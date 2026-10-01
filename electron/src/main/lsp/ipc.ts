// electron/src/main/lsp/ipc.ts
// LSP 子进程 op 路由 + 面板 invoke（spec §7/§8）。
// 子进程 op 不带 workspaceDir（安全边界：主进程以 workspaceId 自查目录，
// path 必须落在 workspace 内——不信子进程自报）。
import path from 'node:path';
import fs from 'node:fs';
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import { REGISTRY, extensionToLanguageId } from './registry';
import { ensureLspManager, fileUriToPath } from './manager';
import { detectWorkspaceLanguages, redetectWorkspaceLanguages } from './detect';
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
              const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warn' : 'info';
              return `${op.path}:${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1} - ${sev}: ${d.message}`;
            }),
            OUTPUT_LIMITS.lsp_diagnostics,
            (s) => s,
          );
      reply(child, m.requestId, true, text);
    } else {
      // op.line 1-based → LSP 0-based；character 按协议 0-based 透传
      const locs = await mgr.findReferences(absPath, (op.line ?? 1) - 1, op.character ?? 0);
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
    reply(child, m.requestId, false, err instanceof Error ? err.message : String(err));
  }
}

/** 面板 invoke 注册（settings IPC 注册处调用）：语言状态查询 / 重探测 */
export function registerLspPanelIpc(): void {
  ipcMain.handle('lsp:status', (_event, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
    return detectWorkspaceLanguages(workspaceId, ws.directoryPath);
  });
  ipcMain.handle('lsp:redetect', (_event, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    if (!ws) throw new Error(`工作区不存在：${workspaceId}`);
    return redetectWorkspaceLanguages(workspaceId, ws.directoryPath);
  });
}
