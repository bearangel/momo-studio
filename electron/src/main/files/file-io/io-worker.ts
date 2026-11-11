// electron/src/main/files/file-io/io-worker.ts
//
// 白名单代理进程脚本（spec §5.5）：由系统 node.exe 常驻启动（node 在亿赛通
// 白名单内，驱动层自动解密/加密——本脚本无感知）。
// 约束：Node >= 14 语法；不得 require 任何外部包；不得 import electron。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export interface WorkerRequest {
  id: number;
  op: 'read' | 'readMany' | 'write' | 'stat';
  path?: string;
  paths?: string[];
  dataBase64?: string;
}

export interface WorkerItem {
  ok: boolean;
  dataBase64?: string;
  size?: number;
  error?: { code: string; message: string };
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  dataBase64?: string;
  size?: number;
  items?: WorkerItem[];
  error?: { code: string; message: string };
}

function toErr(e: unknown): { code: string; message: string } {
  const err = e as NodeJS.ErrnoException;
  return {
    code: typeof err?.code === 'string' ? err.code : 'EUNKNOWN',
    message: err?.message ?? String(e),
  };
}

/**
 * 单请求处理（纯函数，便于单测）。同步 IO：批量由主进程按 batchSize 分片，
 * 单批 50 个小文件实测 < 1ms（上游 PoC §7.3），无需异步化。
 */
export function handleWorkerRequest(req: WorkerRequest): WorkerResponse {
  try {
    if (req.op === 'read' && typeof req.path === 'string') {
      const buf = fs.readFileSync(req.path);
      return { id: req.id, ok: true, dataBase64: buf.toString('base64'), size: buf.length };
    }
    if (req.op === 'readMany' && Array.isArray(req.paths)) {
      const items: WorkerItem[] = req.paths.map((p) => {
        try {
          const buf = fs.readFileSync(p);
          return { ok: true, dataBase64: buf.toString('base64'), size: buf.length };
        } catch (e) {
          return { ok: false, error: toErr(e) };
        }
      });
      return { id: req.id, ok: true, items };
    }
    if (req.op === 'write' && typeof req.path === 'string' && typeof req.dataBase64 === 'string') {
      fs.mkdirSync(path.dirname(req.path), { recursive: true });
      const buf = Buffer.from(req.dataBase64, 'base64');
      fs.writeFileSync(req.path, buf);
      return { id: req.id, ok: true, size: buf.length };
    }
    if (req.op === 'stat' && typeof req.path === 'string') {
      const st = fs.statSync(req.path);
      return { id: req.id, ok: true, size: st.size };
    }
    return { id: req.id, ok: false, error: { code: 'EBADREQ', message: `非法请求: ${String(req.op)}` } };
  } catch (e) {
    return { id: req.id, ok: false, error: toErr(e) };
  }
}

/** 逐行循环（真实入口；单测直接测 handleWorkerRequest，不跑本函数） */
export function startWorkerLoop(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): void {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let req: WorkerRequest;
    try {
      req = JSON.parse(line) as WorkerRequest;
    } catch {
      return; // 非 JSON 行丢弃——协议不容错降级，但不能崩
    }
    output.write(`${JSON.stringify(handleWorkerRequest(req))}\n`);
  });
  rl.on('close', () => process.exit(0));
}

// 打包产物由 node.exe 直接执行（require.main 守卫：被 import 时不启动循环）。
// typeof 守卫：vitest 以 ESM 加载本模块时无 require，不能因守卫求值抛错。
if (typeof require !== 'undefined' && require.main === module) {
  startWorkerLoop(process.stdin, process.stdout);
}
