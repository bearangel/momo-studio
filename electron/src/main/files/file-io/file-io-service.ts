// electron/src/main/files/file-io/file-io-service.ts
//
// FileIoService（spec §5.8）：主进程单例持有，懒启动常驻 node.exe worker。
// 设计要点（上游 PoC 实测结论）：
//   - 常驻复用：每次 spawn 142ms 冷启动，逐请求 spawn 不可用
//   - 批量：batchSize=50 摊薄 IPC（2.51x → 1.39x）
//   - 密文硬失败：读到 E-SafeNet 立即 EENCRYPTED，绝不静默降级
//   - env 原样继承：亿赛通注入 DLL 经 PATH 加载（裁剪即 0xc0000135）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { looksEncrypted } from './cipher-detect';
import {
  FileIoError,
  MSG_DIRECT_CIPHER,
  MSG_PROXY_CIPHER,
  type EffectiveFileIoMode,
} from './types';
import {
  detectClientInstalled,
  resolveEffectiveMode,
  type ResolvedFileIoSettings,
} from './file-io-settings';
import type { WorkerResponse } from './io-worker';

export interface FileIoServiceOpts {
  settings: ResolvedFileIoSettings;
  /** worker 脚本绝对路径（默认同目录编译产物 io-worker.js；测试注入 fixture） */
  workerPath?: string;
  /** 覆盖 node 解析（测试注入） */
  nodePathOverride?: string;
  timeoutMs?: number;
  batchSize?: number;
  /** 客户端安装探测注入（测试；默认真实探测） */
  clientInstalled?: boolean;
  logger?: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void };
  /** spawn 注入（测试断言 env 继承；默认 child_process.spawn） */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

const DEFAULT_WORKER_PATH = path.join(__dirname, 'io-worker.js');
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;

/** node 可用性验证（真跑一次——防「同名但不可执行」） */
function verifyNode(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    const r = spawnSync(p, ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return r.status === 0 && String(r.stdout).trim() === 'ok';
  } catch {
    return false;
  }
}

/**
 * 解析可用 node 可执行文件。优先级（上游 PoC §4.4）：
 * 显式 nodePath（无效即 ENONODE，不回退）→ 自身 execPath 若为 node → PATH → 常见安装位。
 */
export function findNodePath(nodePath: string | null): string {
  if (nodePath !== null) {
    if (verifyNode(nodePath)) return nodePath;
    throw new FileIoError('ENONODE', `配置的 Node.js 路径不可用: ${nodePath}`);
  }

  const win = process.platform === 'win32';
  const exeName = win ? 'node.exe' : 'node';
  const candidates: string[] = [];

  // vitest / node 直跑时 execPath 就是 node；打包 Electron 下是 momo-studio.exe，跳过
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) candidates.push(process.execPath);

  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exeName));
  }
  if (win) {
    candidates.push('C:\\Program Files\\nodejs\\node.exe', 'D:\\Program Files\\nodejs\\node.exe');
  }

  for (const c of candidates) {
    if (verifyNode(c)) return c;
  }
  throw new FileIoError(
    'ENONODE',
    '未找到可用的 Node.js。Node 代理模式需要系统中存在 node（安装 Node.js 或在 设置 → 文件访问 指定路径）。',
  );
}

interface PendingEntry {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class FileIoService {
  private settings: ResolvedFileIoSettings;
  private readonly workerPath: string;
  private readonly nodePathOverride: string | null;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly clientInstalled: boolean;
  private readonly logger: FileIoServiceOpts['logger'];
  private readonly spawnImpl: NonNullable<FileIoServiceOpts['spawnImpl']>;

  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private seq = 0;
  private buf = '';
  private cachedEffective: EffectiveFileIoMode | null = null;

  constructor(opts: FileIoServiceOpts) {
    this.settings = opts.settings;
    this.workerPath = opts.workerPath ?? DEFAULT_WORKER_PATH;
    this.nodePathOverride = opts.nodePathOverride ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.clientInstalled = opts.clientInstalled ?? detectClientInstalled();
    this.logger = opts.logger;
    this.spawnImpl = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o));
  }

  /** 设置变更入口（模式切换后清缓存；direct 时回收 worker） */
  applySettings(s: ResolvedFileIoSettings): void {
    this.settings = s;
    this.cachedEffective = null;
    if (this.effectiveMode() === 'direct') this.close();
  }

  effectiveMode(): EffectiveFileIoMode {
    if (this.cachedEffective === null) {
      this.cachedEffective = resolveEffectiveMode(this.settings, this.clientInstalled);
    }
    return this.cachedEffective;
  }

  async readFile(p: string): Promise<Buffer> {
    return (await this.readFiles([p]))[0]!;
  }

  async readFiles(paths: string[]): Promise<Buffer[]> {
    if (paths.length === 0) return [];
    if (this.effectiveMode() === 'direct') {
      return paths.map((p) => {
        let buf: Buffer;
        try {
          buf = fs.readFileSync(p);
        } catch (e) {
          throw new FileIoError('EREAD', `读取失败: ${p} — ${(e as Error).message}`);
        }
        this.assertNotCipher(buf, p, 'direct');
        return buf;
      });
    }

    await this.ensureWorker();
    const out = new Array<Buffer>(paths.length);
    for (let i = 0; i < paths.length; i += this.batchSize) {
      const chunk = paths.slice(i, i + this.batchSize);
      const resp = await this.request({ op: 'readMany', paths: chunk });
      if (!resp.ok || !Array.isArray(resp.items) || resp.items.length !== chunk.length) {
        throw new FileIoError('EREAD', '代理进程返回格式异常');
      }
      for (let j = 0; j < chunk.length; j++) {
        const item = resp.items[j]!;
        if (!item.ok || item.dataBase64 === undefined) {
          throw new FileIoError(
            (item.error?.code as FileIoError['code']) ?? 'EREAD',
            `读取失败: ${chunk[j]} — ${item.error?.message ?? '未知错误'}`,
          );
        }
        const buf = Buffer.from(item.dataBase64, 'base64');
        this.assertNotCipher(buf, chunk[j]!, 'proxy');
        out[i + j] = buf;
      }
    }
    return out;
  }

  async writeFile(p: string, data: Buffer): Promise<void> {
    if (this.effectiveMode() === 'direct') {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, data);
      } catch (e) {
        throw new FileIoError('EWRITE', `写入失败: ${p} — ${(e as Error).message}`);
      }
      return;
    }
    await this.ensureWorker();
    const resp = await this.request({ op: 'write', path: p, dataBase64: data.toString('base64') });
    if (!resp.ok) {
      throw new FileIoError(
        (resp.error?.code as FileIoError['code']) ?? 'EWRITE',
        `写入失败: ${p} — ${resp.error?.message ?? '未知错误'}`,
      );
    }
  }

  /** 关闭 worker（app will-quit / 测试 teardown） */
  close(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        // 已退出——忽略
      }
    }
    this.failAllPending('worker 已关闭');
    this.buf = '';
  }

  /** 密文硬失败（spec §5.3 最重要设计决策） */
  private assertNotCipher(buf: Buffer, p: string, mode: EffectiveFileIoMode): void {
    if (!this.settings.strictCipherCheck || !looksEncrypted(buf)) return;
    // 技术细节只进日志（UI 中性化约束）
    this.logger?.warn('读到加密容器内容（通道不对或策略变更）', { path: p, mode });
    throw new FileIoError(
      'EENCRYPTED',
      `${mode === 'direct' ? MSG_DIRECT_CIPHER : MSG_PROXY_CIPHER}（${p}）`,
    );
  }

  private ensureWorker(): Promise<void> {
    if (this.child !== null && this.child.exitCode === null) return Promise.resolve();
    if (this.starting !== null) return this.starting;

    const start = new Promise<void>((resolve, reject) => {
      const nodePath = this.nodePathOverride ?? findNodePath(this.settings.nodePath);
      if (!fs.existsSync(this.workerPath)) {
        reject(new FileIoError('ENOWORKER', `worker 脚本不存在: ${this.workerPath}`));
        return;
      }

      let child: ChildProcess;
      try {
        // env 原样继承（硬约束）：注入 DLL 经 PATH 加载，禁止 sanitize
        child = this.spawnImpl(nodePath, [this.workerPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        });
      } catch (e) {
        reject(new FileIoError('ESPAWN', `启动代理进程失败: ${(e as Error).message}`));
        return;
      }

      this.child = child;
      this.buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: WorkerResponse;
          try {
            msg = JSON.parse(line) as WorkerResponse;
          } catch {
            continue;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg);
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => {
        this.logger?.warn('代理进程 stderr', { text: String(d).trim() });
      });
      child.on('error', (e) => {
        this.failAllPending(`代理进程错误: ${e.message}`);
        // 同一时刻可能已 spawn 出新 worker——只清理自己创建的状态
        if (this.child !== child) return;
        this.child = null;
        this.starting = null;
      });
      child.on('exit', (code, signal) => {
        // 无论是否已被新 worker 取代，本进程在途请求的应答永远不会来——必须失败
        this.failAllPending(`代理进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
        if (this.child !== child) return;
        this.child = null;
        this.starting = null;
      });

      resolve();
    });
    this.starting = start;
    // 同步失败（ENONODE / ENOWORKER / spawn 抛错）不得把 rejected promise 留在
    // starting 里——否则后续 ensureWorker 永远拿到同一拒绝，applySettings 后也无法自愈
    start.catch(() => {
      if (this.starting === start) this.starting = null;
    });
    return start;
  }

  private request(payload: { op: string; path?: string; paths?: string[]; dataBase64?: string }): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const child = this.child;
      if (child === null || child.exitCode !== null || !child.stdin) {
        reject(new FileIoError('ECHILD', '代理进程未就绪'));
        return;
      }
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FileIoError('ETIMEOUT', `代理进程请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new FileIoError('ECHILD', `写代理进程失败: ${(e as Error).message}`));
      }
    });
  }

  private failAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new FileIoError('ECHILD', reason));
    }
    this.pending.clear();
  }
}
