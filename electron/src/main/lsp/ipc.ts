// electron/src/main/lsp/ipc.ts
// LSP 子进程 op 路由 + 面板 invoke（spec §7/§8）。
// 子进程 op 不带 workspaceDir（安全边界：主进程以 workspaceId 自查目录，
// path 必须落在 workspace 内——不信子进程自报）。
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app, ipcMain } from 'electron';
import { logger } from '../logger';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import { REGISTRY, extensionToLanguageId, findBinaryInPath } from './registry';
import { ensureLspManager, fileUriToPath, getLspRunState } from './manager';
import { detectWorkspaceLanguages, redetectWorkspaceLanguages, type LanguageStatus } from './detect';
import { setSharedBinDir, getSharedBinDir } from './shared-bin';
import { getWorkspace } from '../workspace/crud';
import { OUTPUT_LIMITS, truncateArray } from '../agent/tools/shared/output-truncate';

interface LspOpEnvelope {
  type: 'lsp:op';
  requestId: string;
  op: {
    kind: 'diagnostics' | 'references';
    workspaceId: string;
    path: string;
    content?: string;
    line?: number;
    character?: number;
  };
}

/**
 * 子进程消息发送端口——ChildProcess 的结构性子集。
 * send 用方法语法声明：参数按双变检查（strictFunctionTypes 只收紧函数属性），
 * 否则 unknown 实参与 ChildProcess.send 的 Serializable 形参互斥、接线不可过检。
 */
interface ChildSendPort {
  send(message: unknown): void;
}

/**
 * 回发线协议应答：ok:true 带 result 字符串 / ok:false 带 error 字符串，
 * requestId 原样回带（单点生成、沿线透传，不重新生成——boundary-rules 铁律 1）。
 * child.send 失败（通道已关）只记日志不上抛：调用方 agent-runner 以
 * fire-and-forget（void）调用，上抛即未处理 rejection；子进程侧自有超时兜底。
 */
function reply(child: ChildSendPort, requestId: string, ok: boolean, payload?: string): void {
  const msg = ok
    ? { type: 'lsp:op-result', requestId, ok: true, result: payload ?? '' }
    : { type: 'lsp:op-result', requestId, ok: false, error: payload };
  try {
    child.send(msg);
  } catch (err) {
    logger.warn('lsp:op 应答回送失败（IPC 通道已关闭）', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 子进程 lsp:op 请求路由（agent-runner 消息监听器分发调用）。
 * 非法 envelope（缺 requestId / 未知 kind / 字段类型错）静默忽略不崩——
 * 协议级垃圾无法构造有意义的回执路由。业务错误统一 ok:false 中文 error。
 */
export async function routeLspOp(child: ChildSendPort, msg: unknown): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as Partial<LspOpEnvelope>;
  if (m.type !== 'lsp:op' || typeof m.requestId !== 'string' || typeof m.op !== 'object' || m.op === null) return;
  const op = m.op;
  if (op.kind !== 'diagnostics' && op.kind !== 'references') return;
  if (typeof op.workspaceId !== 'string' || typeof op.path !== 'string') return;
  try {
    const ws = getWorkspace(op.workspaceId);
    if (!ws) {
      throw new Error(`工作区不存在：${op.workspaceId}`);
    }
    const rootDir = path.resolve(ws.directoryPath);
    const absPath = path.resolve(rootDir, op.path);
    // 字符串边界：复用平台语义 helper（resolve 归一 + sep 边界前缀 + win32
    // 大小写不敏感），同级目录名前缀（/tmp/ws-x-evil）不得因字符串前缀误过
    if (!isInsideDir(rootDir, absPath, { win32: PATH_SEMANTICS_WIN32 })) {
      throw new Error(`路径越界：${op.path}`);
    }
    // 符号链接锚定（workspace-fs assertInWorkspace 同型补层——isInsideDir 纯
    // 字符串运算不触 fs）：字符串边界内仍可能有中间段是指向外部的 symlink。
    // 向上找真实存在的最近祖先 realpathSync，解析后脱离 realRoot 即拒绝；
    // 逐级上溯以支持尚未创建的文件路径。root 本身不存在（离线配置/测试桩）
    // 时跳过——磁盘上无内容即无链接可逃逸，字符串边界已足。
    if (fs.existsSync(rootDir)) {
      const realRoot = fs.realpathSync(rootDir);
      let anchor = absPath;
      while (anchor !== rootDir && !fs.existsSync(anchor)) {
        anchor = path.dirname(anchor);
      }
      if (anchor !== rootDir) {
        const realAnchor = fs.realpathSync(anchor);
        if (realAnchor !== realRoot && !realAnchor.startsWith(realRoot + path.sep)) {
          throw new Error(`路径越界（符号链接逃逸）：${op.path}`);
        }
      }
    }
    const languageId = extensionToLanguageId(path.extname(absPath));
    if (!languageId) {
      throw new Error(`无法识别文件语言（扩展名 ${path.extname(absPath) || '无'}）——当前支持：${REGISTRY.map((s) => s.label).join('、')}`);
    }
    const spec = REGISTRY.find((s) => s.languageId === languageId)!;
    const mgr = await ensureLspManager(op.workspaceId, ws.directoryPath, spec);
    if (op.kind === 'diagnostics') {
      const diags = await mgr.getDiagnostics(absPath, op.content ?? '');
      // 输出截断（旧子进程 lsp-tools 语义回迁，Task 5 薄客户端化时丢失）：
      // 超大诊断集全量回发会撑爆 LLM 上下文——按 OUTPUT_LIMITS 上限截断
      const text = diags.length === 0
        ? `✓ ${op.path} 无诊断`
        : truncateArray(
            diags.map((d) => {
              // 格式保真（F4）：severity 4（hint）单独映射；有 code 时附
              // ` <code>`（如 `error TS2322:`——code 是 LLM 定位问题的关键线索）
              const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warn' : d.severity === 4 ? 'hint' : 'info';
              const code =
                d.code !== undefined && d.code !== null && String(d.code) !== '' ? ` ${d.code}` : '';
              return `${op.path}:${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1} - ${sev}${code}: ${d.message}`;
            }),
            OUTPUT_LIMITS.lsp_diagnostics,
            (s) => s,
          );
      reply(child, m.requestId, true, text);
    } else {
      // op.line 1-based → LSP 0-based；character 按协议 0-based 透传。
      // ENOENT 单点收口（references 分支）：文件读取在 manager.findReferences
      // 内部（diagnostics 分支由工具层自读、已在 lsp-tools.ts 收口）——裸
      // ENOENT 文案（英文 + 绝对路径泄露）在此转写为中文相对路径文案
      const locs = await mgr.findReferences(absPath, (op.line ?? 1) - 1, op.character ?? 0).catch(
        (err: unknown) => {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`文件不存在: ${op.path}`);
          }
          throw err;
        },
      );
      // 同上：引用列表超限截断，防 LLM 上下文膨胀
      const text = locs.length === 0
        ? '(无引用)'
        : truncateArray(
            locs.map((l) => {
              const rel = path.relative(ws.directoryPath, fileUriToPath(l.uri));
              return `${rel}:${(l.range.start.line ?? 0) + 1}:${(l.range.start.character ?? 0) + 1}`;
            }),
            OUTPUT_LIMITS.lsp_references,
            (s) => s,
          );
      reply(child, m.requestId, true, text);
    }
  } catch (err) {
    // 启动类失败附安装指引（2026-10-08 修复闭环）：真实原因（exit code + stderr
    // 尾部）已由 manager 保真带出，此处补「怎么装」让 agent/用户形成行动闭环
    let msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('LSP server 已关闭') || msg.includes('未安装')) {
      const langId = extensionToLanguageId(path.extname(op.path));
      const spec = langId !== null ? REGISTRY.find((s) => s.languageId === langId) : undefined;
      if (spec) msg = `${msg}\n可尝试安装：${spec.installHint}`;
    }
    reply(child, m.requestId, false, msg);
  }
}

/** 面板一键安装的注入缝（D3 修正案）：生产缺省真实实现；handler 三态测试注入桩。
 *  仅 mock 进程/网络边界（npm 解析与 spawn），业务判定（元数据门控 / 重探测 /
 *  running 覆写）始终走真实实现。 */
export interface LspInstallDeps {
  /** npm 可执行解析（null = 不可用）。缺省 PATH 探测全链（win32 试 npm.cmd） */
  resolveNpm?: () => string | null;
  /** npm install 执行（聚合 stderr，code 非 0 由调用方判失败）。缺省异步 spawn */
  runInstall?: (cmd: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
}

/** npm 探测：win32 试 npm.cmd（无扩展名的 npm shim 非 .exe 不可执行）；
 *  走 findBinaryInPath 全链——GUI PATH 兜底（homebrew/nvm 装的 npm 靠 login
 *  shell 兜底命中）对 npm 同样必要 */
function resolveNpmDefault(): string | null {
  return findBinaryInPath([process.platform === 'win32' ? 'npm.cmd' : 'npm']);
}

/** 异步 spawn npm（非 spawnSync——安装可达分钟级，不许阻塞主进程事件循环）。
 *  stdout 丢弃（进度条噪声），stderr 聚合供失败诊断 */
function runInstallDefault(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // win32 必须 shell: true：Node ≥20.12（CVE-2024-27980 修复）起 spawn
    // .cmd/.bat 无 shell 直接 EINVAL（error 事件），npm.cmd 分支会必挂——
    // 仅 win32 开 shell，POSIX 保持无 shell（参数不经解释器，行为不变）
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdout?.on('data', () => { /* 防 stdout 背压挂死 */ });
    child.on('error', (err) => reject(new Error(`npm 启动失败：${err.message}`)));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * 一键安装（lsp:install handler 本体）：npm install --prefix <sharedDir> 落
 * app 管理共享目录，成功后 redetect 强制刷新并返回新 LanguageStatus[]（running
 * 实时覆写，与 lsp:redetect 同型）。安装幂等——npm install 重跑即升级，不做
 * 版本管理（YAGNI）。
 */
export async function installLanguageServer(
  workspaceId: string,
  languageId: string,
  deps: LspInstallDeps = {},
): Promise<LanguageStatus[]> {
  const spec = REGISTRY.find((s) => s.languageId === languageId);
  if (!spec) throw new Error(`未注册的语言：${languageId}`);
  if (!spec.install) throw new Error(`该语言服务需手动安装：${spec.installHint}`);
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
  const sharedDir = getSharedBinDir();
  if (sharedDir === null) throw new Error('LSP 共享安装目录未初始化（IPC 注册异常）');
  const npm = deps.resolveNpm ? deps.resolveNpm() : resolveNpmDefault();
  if (npm === null) throw new Error('未找到 npm——请先安装 Node.js（https://nodejs.org），安装后重试');
  // --prefix 目录不存在时 npm 行为随版本漂移——显式建目录收口（幂等）
  fs.mkdirSync(sharedDir, { recursive: true });
  const run = deps.runInstall ?? runInstallDefault;
  const { code, stderr } = await run(npm, ['install', '--prefix', sharedDir, ...spec.install.packages]);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`npm 安装失败（退出码 ${code}）\n${tail}`);
  }
  logger.info('LSP 一键安装完成', { languageId, sharedDir });
  return redetectWorkspaceLanguages(workspaceId, ws.directoryPath).map((s) => ({
    ...s,
    running: getLspRunState(workspaceId, s.languageId),
  }));
}

/**
 * 手动启动（lsp:start handler 本体，2026-10-08）：面板「启动」按钮触发——
 * ensureLspManager 单例 + 显式 ensureStarted()（spawn + initialize 握手；agent
 * 工具路径经 getDiagnostics/findReferences 内部隐式触发，本通道供用户预热/
 * 验证安装）。注入缝走仓库标准 vi.mock(manager) 整模块——无需 deps 参数。
 * 成功后返回 detect 快照 + running 实时覆写（与 lsp:redetect 同型）。
 */
export async function startLanguageServer(
  workspaceId: string,
  languageId: string,
): Promise<LanguageStatus[]> {
  const spec = REGISTRY.find((s) => s.languageId === languageId);
  if (!spec) throw new Error(`未注册的语言：${languageId}`);
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
  try {
    const mgr = await ensureLspManager(workspaceId, ws.directoryPath, spec);
    await mgr.ensureStarted();
  } catch (err) {
    // 安装指引透出（面板路径同 agent 路径——错误保真 + 行动闭环）。仅启动类
    // 失败附指引；「活跃上限」等其他错误原样上抛不误导
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('LSP server 已关闭') || msg.includes('未安装') || msg.includes('spawn 失败')) {
      throw new Error(`${msg}\n可尝试安装：${spec.installHint}`);
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  logger.info('LSP 手动启动完成', { workspaceId, languageId });
  return detectWorkspaceLanguages(workspaceId, ws.directoryPath).map((s) => ({
    ...s,
    running: getLspRunState(workspaceId, s.languageId),
  }));
}

/** 面板 invoke 注册（settings IPC 注册处调用）：语言状态查询 / 重探测 / 一键安装 / 手动启动。
 *  running 列实时覆写：detect 结果按 workspace 缓存，running 是随 server
 *  生命周期变化的实时态——返回前复制数组并以 getLspRunState（纯内存查询）
 *  覆写，否则面板 running 列被缓存冻结。 */
export function registerLspPanelIpc(deps: LspInstallDeps = {}): void {
  // 共享目录接线（D3 修正案）：app ready 后注册，userData 可用；幂等
  setSharedBinDir(path.join(app.getPath('userData'), 'lsp-bin'));
  ipcMain.handle('lsp:status', (_event, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
    return detectWorkspaceLanguages(workspaceId, ws.directoryPath).map((s) => ({
      ...s,
      running: getLspRunState(workspaceId, s.languageId),
    }));
  });
  ipcMain.handle('lsp:redetect', (_event, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
    return redetectWorkspaceLanguages(workspaceId, ws.directoryPath).map((s) => ({
      ...s,
      running: getLspRunState(workspaceId, s.languageId),
    }));
  });
  ipcMain.handle('lsp:install', (_event, workspaceId: string, languageId: string) =>
    installLanguageServer(workspaceId, languageId, deps));
  ipcMain.handle('lsp:start', (_event, workspaceId: string, languageId: string) =>
    startLanguageServer(workspaceId, languageId));
}
