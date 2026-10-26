// electron/src/main/sandbox/write-blocked-emit.ts
// 主进程 writeBlocked 检测（spec 2026-10-03 §5.1/§5.3）：stream-relay onFlush
// 批次的唯一消费者——命中即推 sandbox:writeBlocked（renderer 直弹授权卡，
// 取代旧的「事件→renderer 扫子串→置标志」六环链）。
// callId→command 环形缓存跨批关联（start 与 result 可能不同批 flush）；
// sessionId/workspaceId 经 messages 行解析（ getMessage → streamSessionId →
// session 映射），解析失败降级 null——卡按钮据此禁用。
import os from 'node:os';
import type { MessageEventRow } from '../storage/messages/events-repo';
import { getMessage } from '../storage/messages/repo';
import { resolveStreamOwner } from '../storage/messages/repo';
import { getSession } from '../storage/sessions/repo';
import { loadElectronApis } from '../electron-access';
import { detectWriteBlocked, extractBlockedPaths, normalizeGrantDirs } from '../agent/tools/sandbox-write-hint';

const commandByCallId = new Map<string, string>();
const COMMAND_CACHE_MAX = 100;

/**
 * M2.1 T11 L1b：未决写授权登记（主进程真源——委派执行器 sessionWaiting 消费）。
 * 两条上报链（writeBlockedFromChildMsg 等待即报 / inspectEventBatch 迟到兜底）
 * 命中即登记；grantWrite / denyWrite 处置清除（dirs 相交匹配）；15min TTL 惰性
 * 过期（renderer write-grant.store F3 同款语义——covered 轮询路径主进程不可观测，
 * TTL 兜底；child 等待循环 10min 超时自弃，15min 覆盖其上）。
 */
const pendingWriteBlocked = new Map<string, { signal: WriteBlockedSignal; at: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

/** 未决登记惰性清扫（查询路径顺带执行，不设独立计时器） */
function sweepExpired(now: number): void {
  for (const [key, entry] of pendingWriteBlocked) {
    if (now - entry.at > PENDING_TTL_MS) pendingWriteBlocked.delete(key);
  }
}

function registerPending(signal: WriteBlockedSignal): void {
  if (signal.streamSessionId === null) return; // 无流键无法清除——不登记（TTL 语义由 renderer 卡自弃承载）
  pendingWriteBlocked.set(signal.streamSessionId, { signal, at: Date.now() });
}

/** 按聊天会话查未决写授权卡（T11 sessionWaiting 真源查询口） */
export function listPendingWriteBlocked(sessionId: string): WriteBlockedSignal[] {
  sweepExpired(Date.now());
  const out: WriteBlockedSignal[] = [];
  for (const { signal } of pendingWriteBlocked.values()) {
    if (signal.sessionId === sessionId) out.push(signal);
  }
  return out;
}

/** grantWrite 处置清除：scope 键匹配（session/ws）且授权目录与登记目录相交 */
export function clearPendingOnGrant(scope: 'session' | 'workspace', key: string, dirs: string[]): void {
  for (const [streamKey, entry] of pendingWriteBlocked) {
    const { signal } = entry;
    const scopeHit = scope === 'session' ? signal.sessionId === key : signal.workspaceId === key;
    if (scopeHit && signal.dirs.some((d) => dirs.includes(d))) pendingWriteBlocked.delete(streamKey);
  }
}

/** denyWrite 处置清除：sessionId 匹配（null = 未归属卡按目录全局匹配）且目录相交。
 *  dirs 空数组 = 全清意图（P2-2：拒绝未携带目录信息——按会话整体拒绝；旧实现
 *  相交匹配对空 dirs 恒 false，pending 滞留致 sessionWaiting 假阳）；dirs 非数组
 *  防御同全清（IPC 边界已校验，此处兜底直接调用/畸形载荷）。 */
export function clearPendingOnDeny(sessionId: string | null, dirs: string[]): void {
  const denyAll = !Array.isArray(dirs) || dirs.length === 0;
  for (const [streamKey, entry] of pendingWriteBlocked) {
    const { signal } = entry;
    const sessionHit = sessionId === null || signal.sessionId === sessionId;
    if (sessionHit && (denyAll || signal.dirs.some((d) => dirs.includes(d)))) pendingWriteBlocked.delete(streamKey);
  }
}

/** result 文本中的沙箱 tag 行（子进程 shell-tools 拼入 `sandbox: ${plan.tag}`）——主进程侧的沙箱化判定（终审 I2） */
const SANDBOX_TAG_LINE = /^sandbox: (seatbelt|bwrap)\//m;

/** 命令预览截断上限（spec §5.3，与旧 lastToolchainBlockedCommand 同档） */
const COMMAND_PREVIEW_MAX = 200;

export interface WriteBlockedSignal {
  sessionId: string | null;
  workspaceId: string | null;
  dirs: string[];
  command: string;
  /** F4（2026-10-14 后台链授权卡死配套）：来源标注三件套——卡片据此指明
   * 「谁在哪条流的哪个会话里等授权」，后台链场景用户才知道该不该放行 */
  streamSessionId: string | null;
  sourceAgentName: string | null;
  sessionTitle: string | null;
}

/**
 * F4 来源标注 + 归属解析（两条上报链共用，2026-10-15 会话验收修复合并）：
 * 换用 resolveStreamOwner（不排除子链行）——dispatch 子链场景 sessionId/
 * workspaceId/sourceAgentName/sessionTitle 四件套全解出；sender `agent-<slug>-<rand>`
 * 提取 slug 作展示名。解析失败降级 null（sessionId null → 卡按钮禁用，防线不变）。
 */
function resolveStreamContext(streamSessionId: string | null): {
  sessionId: string | null;
  workspaceId: string | null;
  sourceAgentName: string | null;
  sessionTitle: string | null;
} {
  try {
    if (streamSessionId === null) {
      return { sessionId: null, workspaceId: null, sourceAgentName: null, sessionTitle: null };
    }
    const owner = resolveStreamOwner(streamSessionId);
    if (!owner) {
      return { sessionId: null, workspaceId: null, sourceAgentName: null, sessionTitle: null };
    }
    const senderMatch = /^agent-([a-z0-9-]+?)(?:-[a-z0-9]{6})?$/i.exec(owner.sender);
    const sourceAgentName = senderMatch !== null && senderMatch[1] !== undefined ? senderMatch[1] : null;
    const sessionTitle = getSession(owner.sessionId)?.title ?? null;
    return {
      sessionId: owner.sessionId,
      workspaceId: owner.workspaceId,
      sourceAgentName,
      sessionTitle,
    };
  } catch {
    return { sessionId: null, workspaceId: null, sourceAgentName: null, sessionTitle: null };
  }
}

export function __resetInspectStateForTest(): void {
  commandByCallId.clear();
  pendingWriteBlocked.clear();
}

export function inspectEventBatch(events: MessageEventRow[]): WriteBlockedSignal | null {
  // 1) 缓存 tool_call_start 的 command（start 必先于 result 到达）
  for (const e of events) {
    if (e.eventType !== 'tool_call_start') continue;
    const callId = e.payload.callId;
    const cmd = (e.payload.args as Record<string, unknown> | undefined)?.command;
    if (typeof callId === 'string' && callId !== '' && typeof cmd === 'string' && cmd !== '') {
      if (commandByCallId.size >= COMMAND_CACHE_MAX) {
        const oldest = commandByCallId.keys().next().value;
        if (oldest !== undefined) commandByCallId.delete(oldest);
      }
      commandByCallId.set(callId, cmd);
    }
  }
  // 2) bash 结果检测——沙箱化判定取自 result 文本的 sandbox tag 行（终审 I2：
  //    主进程无 plan.tag，硬编码恒过会让 permissive/unsandboxed 下的真实系统
  //    权限错误误弹授权卡且授权无效循环——文本里有子进程拼入的权威 tag）
  for (const e of events) {
    if (e.eventType !== 'tool_call_result') continue;
    if (e.payload.toolName !== 'bash') continue;
    const result = e.payload.result;
    if (typeof result !== 'string') continue;
    if (!SANDBOX_TAG_LINE.test(result)) continue;
    const callId = e.payload.callId;
    const command = typeof callId === 'string' ? commandByCallId.get(callId) ?? '' : '';
    if (!detectWriteBlocked('seatbelt/x', command, result)) continue;
    const dirs = normalizeGrantDirs(extractBlockedPaths(command, result), os.homedir());
    // 3) 归属解析（resolveStreamContext——含子链行，2026-10-15 P1-1 修复）——
    //    异常降级 null，绝不阻断消息主路径
    const streamSessionId = (() => {
      try {
        return getMessage(e.messageId)?.streamSessionId ?? null;
      } catch {
        return null;
      }
    })();
    const ctx = resolveStreamContext(streamSessionId);
    const signal: WriteBlockedSignal = {
      sessionId: ctx.sessionId,
      workspaceId: ctx.workspaceId,
      dirs,
      command: command.length > COMMAND_PREVIEW_MAX ? command.slice(0, COMMAND_PREVIEW_MAX) : command,
      streamSessionId,
      sourceAgentName: ctx.sourceAgentName,
      sessionTitle: ctx.sessionTitle,
    };
    registerPending(signal);
    return signal;
  }
  return null;
}


/**
 * 子进程等待上报的消费入口（spec §12——runtime-spawner messageHandler 调用，
 * 照 process-registry.registerFromChildMsg 形态）：bash 被拦进入有界等待时
 * fire-and-forget 上报，此处解析聊天会话（roll 流族最新行语义）后立即推
 * sandbox:writeBlocked——等待开始即弹卡（inspectEventBatch 降级为迟到兜底）。
 * 载荷形状不符返回 false（消息原样落回其他分支）。
 */
export function writeBlockedFromChildMsg(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as {
    type?: unknown; streamSessionId?: unknown; workspaceId?: unknown;
    dirs?: unknown; command?: unknown;
  };
  if (m.type !== 'write-blocked-report') return false;
  if (typeof m.streamSessionId !== 'string' || m.streamSessionId === '') return false;
  if (!Array.isArray(m.dirs) || m.dirs.some((d) => typeof d !== 'string')) return false;
  if (typeof m.command !== 'string') return false;
  // 归属解析（resolveStreamContext 含子链行——2026-10-15 P1-1：旧 getLatest
  // 对子链流恒 null，会话允许禁用 + covered 查不到 session 授权）
  const ctx = resolveStreamContext(m.streamSessionId);
  const signal: WriteBlockedSignal = {
    sessionId: ctx.sessionId,
    workspaceId: typeof m.workspaceId === 'string' ? m.workspaceId : ctx.workspaceId,
    dirs: m.dirs,
    command: m.command.length > 200 ? m.command.slice(0, 200) : m.command,
    streamSessionId: m.streamSessionId,
    sourceAgentName: ctx.sourceAgentName,
    sessionTitle: ctx.sessionTitle,
  };
  registerPending(signal);
  const { BrowserWindow } = loadElectronApis();
  const win = BrowserWindow?.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('sandbox:writeBlocked', signal);
  }
  return true;
}
