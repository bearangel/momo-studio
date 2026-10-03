// electron/src/main/sandbox/write-blocked-emit.ts
// 主进程 writeBlocked 检测（spec 2026-10-03 §5.1/§5.3）：stream-relay onFlush
// 批次的唯一消费者——命中即推 sandbox:writeBlocked（renderer 直弹授权卡，
// 取代旧的「事件→renderer 扫子串→置标志」六环链）。
// callId→command 环形缓存跨批关联（start 与 result 可能不同批 flush）；
// sessionId/workspaceId 经 messages 行解析（ getMessage → streamSessionId →
// session 映射），解析失败降级 null——卡按钮据此禁用。
import os from 'node:os';
import type { MessageEventRow } from '../storage/messages/events-repo';
import { getMessage, getLatestMessageByStreamSessionId } from '../storage/messages/repo';
import { loadElectronApis } from '../electron-access';
import { detectWriteBlocked, extractBlockedPaths, normalizeGrantDirs } from '../agent/tools/sandbox-write-hint';

const commandByCallId = new Map<string, string>();
const COMMAND_CACHE_MAX = 100;

/** result 文本中的沙箱 tag 行（子进程 shell-tools 拼入 `sandbox: ${plan.tag}`）——主进程侧的沙箱化判定（终审 I2） */
const SANDBOX_TAG_LINE = /^sandbox: (seatbelt|bwrap)\//m;

/** 命令预览截断上限（spec §5.3，与旧 lastToolchainBlockedCommand 同档） */
const COMMAND_PREVIEW_MAX = 200;

export interface WriteBlockedSignal {
  sessionId: string | null;
  workspaceId: string | null;
  dirs: string[];
  command: string;
}

export function __resetInspectStateForTest(): void {
  commandByCallId.clear();
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
    // 3) 会话/工作空间解析（消息行）——异常降级 null，绝不阻断消息主路径
    let sessionId: string | null = null;
    let workspaceId: string | null = null;
    try {
      const msg = getMessage(e.messageId);
      if (msg) {
        workspaceId = msg.workspaceId ?? null;
        if (msg.streamSessionId !== null) {
          sessionId = getLatestMessageByStreamSessionId(msg.streamSessionId)?.sessionId ?? null;
        }
      }
    } catch {
      // DB 异常：信号仍发出（dirs/command 可用），键位 null → 卡按钮禁用
    }
    return {
      sessionId,
      workspaceId,
      dirs,
      command: command.length > COMMAND_PREVIEW_MAX ? command.slice(0, COMMAND_PREVIEW_MAX) : command,
    };
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
  let sessionId: string | null = null;
  try {
    sessionId = getLatestMessageByStreamSessionId(m.streamSessionId)?.sessionId ?? null;
  } catch {
    sessionId = null;
  }
  const { BrowserWindow } = loadElectronApis();
  const win = BrowserWindow?.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('sandbox:writeBlocked', {
      sessionId,
      workspaceId: typeof m.workspaceId === 'string' ? m.workspaceId : null,
      dirs: m.dirs,
      command: m.command.length > 200 ? m.command.slice(0, 200) : m.command,
    });
  }
  return true;
}
