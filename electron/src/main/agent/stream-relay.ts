// electron/src/main/agent/stream-relay.ts
//
// 流式 chunk 中继层（独立模块）。
//
// 职责（P2 Task 10 起单通道）：
//   落盘：chunk → MessageEventBuffer → messages / message_events 表，
//   flush 时批量推送 'session:message_event_batch'（Task 8 已从 im:message_event_batch 改名）。
//   （旧 'agent:stream' 实时推送通道已删除——renderer 早已零订阅，
//   实时显示统一走 message_event_batch 事件流。）
//
// 中断：abortStreamBySessionId(streamSessionId)——按 streamSessionId 精确中断。
// 为避免循环依赖（stream-relay 不得 import runtime-registry），采用注册反转：
// runtime-registry 模块初始化时通过 setAbortResolver 注入实际广播逻辑
// （遍历 agentRunners，逐 runner 调 abortStream；各 runner 内部按活跃表自然过滤）。
//
// 性能（minor-1 修复）：streamSessionId → messageId 内存缓存（start 填充，
// end / 子进程崩溃收尾清空）——此前每个 streaming chunk 都要同步 SELECT
// messages 表一次，千级 delta 流即千次查询；命中缓存后为 0 次。
//

import { BrowserWindow, ipcMain } from 'electron';
import { logger } from '../logger';
import type { StreamChunk } from './stream-chunk';
import { MessageEventBuffer } from '../storage/messages/event-buffer';
import {
  insertMessage,
  updateMessageStatus,
  getMessageByStreamSessionId,
} from '../storage/messages/repo';

// === A7：stream chunk → MessageEventBuffer 落盘 ===

/**
 * 全局 MessageEventBuffer 单例。聚批 stream chunk 后单事务写入 message_events 表，
 * flush 时批量推送给 renderer（session:message_event_batch 通道）。
 * 单例简化生命周期管理；内部 pending 数组操作同步，并发安全。
 */
let eventBuffer: MessageEventBuffer | null = null;

export function getEventBuffer(): MessageEventBuffer {
  if (!eventBuffer) {
    eventBuffer = new MessageEventBuffer({
      onFlush: (events) => {
        // headless / 测试环境 BrowserWindow 可能为 undefined，静默跳过 IPC 推送
        if (!BrowserWindow) return;
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return;
        win.webContents.send('session:message_event_batch', events);
      },
    });
  }
  return eventBuffer;
}

/** 测试用：重置单例（清 pending + 销毁 timer） */
export function __resetEventBufferForTest(): void {
  eventBuffer?.destroy();
  eventBuffer = null;
  streamMessageIdCache.clear();
}

/**
 * 推送 agent 消息行到 renderer（'session:message' 通道）。
 *
 * start / segment_boundary 分支 INSERT 消息行后必须立即推送——否则 renderer 的
 * messagesBySession 永远不知道该行存在，agent 流式气泡（含失败错误气泡）实时
 * 不可见，重启拉历史才出现（2.0.0 主机验收 P0-2）。与 onFlush 推 event batch
 * 的窗口获取方式一致；非 Electron 环境（测试/headless）静默跳过。
 */
function pushSessionMessage(msg: ReturnType<typeof insertMessage>): void {
  if (!BrowserWindow) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send('session:message', msg);
}

/** 测试用：导出 routeChunkToBuffer 以便单测直接验证 chunk → SQLite 映射 */
export function __routeChunkToBufferForTest(chunk: StreamChunk): void {
  routeChunkToBuffer(chunk);
}

/** 测试用：强制 flush 当前 buffer（确保 pending events 落盘后再断言） */
export function __flushEventBufferForTest(): void {
  if (eventBuffer) eventBuffer.flush();
}

/**
 * streamSessionId → messageId 缓存（minor-1）。
 * start 分支 INSERT 后填充；end 分支与崩溃收尾（finalizeStreamOnCrash）清空。
 * 未命中时回退一次 DB 查询并回填——start 因 DB 未就绪被跳过时仍能自愈。
 */
const streamMessageIdCache = new Map<string, string>();

/** 解析流会话对应的 message id：缓存命中 0 查询；未命中查一次 DB 并回填 */
function resolveMessageId(streamSessionId: string): string | null {
  const cached = streamMessageIdCache.get(streamSessionId);
  if (cached !== undefined) return cached;
  const msg = getMessageByStreamSessionId(streamSessionId);
  if (!msg) return null;
  streamMessageIdCache.set(streamSessionId, msg.id);
  return msg.id;
}

/** 清空指定流会话的缓存（end / 子进程崩溃时调用，防 Map 无界增长） */
function clearStreamSessionCache(streamSessionId: string): void {
  streamMessageIdCache.delete(streamSessionId);
}

/**
 * task-driven runtime 的 chunk 入口——落盘 SQLite（MessageEventBuffer 聚批）。
 * WarmPool spawn 的子进程 chunk 经此函数进入唯一通道
 * （P2 Task 10 已删除 'agent:stream' renderer 直推；实时显示走 event_batch 推送）。
 */
export function handleStreamChunk(chunk: StreamChunk): void {
  routeChunkToBuffer(chunk);
}

/**
 * 判定是否为「DB 未就绪」类错误（测试环境 / 表未迁移）。
 * SQLite 对缺失表的报错文案是 "no such table: xxx"——只有这类错误
 * 允许按 debug 级别静默；其余（磁盘满 / 库锁定 / 损坏）必须 error 级别暴露。
 */
function isDbNotReadyError(errText: string): boolean {
  return /no such table/i.test(errText);
}

/**
 * 子进程异常退出时的流收尾（C2 清理链的消息侧）。
 * 由 AgentRunner.handleChildExit 调用：仍处于 'streaming' 的消息行
 * 置 'failed' 并补一条带错误文案的 final 事件（否则 renderer 永远显示"流式中"）。
 * 幂等：end 路径已收尾（status 非 streaming）时 no-op。
 */
export function finalizeStreamOnCrash(streamSessionId: string, exitCode: number | null): void {
  try {
    clearStreamSessionCache(streamSessionId);
    const msg = getMessageByStreamSessionId(streamSessionId);
    if (!msg || msg.status !== 'streaming') return;
    const errorText = exitCode === null ? 'agent 运行时异常退出' : `agent 运行时异常退出（exit code=${exitCode}）`;
    updateMessageStatus(msg.id, 'failed');
    const buf = getEventBuffer();
    buf.flush();
    buf.append({
      messageId: msg.id,
      eventType: 'final',
      payload: { status: 'failed', error: errorText },
    });
    buf.flush();
  } catch (err) {
    // 收尾自身失败不得向上传播（调用方在 child exit 事件回调里）——记 error 后放行
    logger.error('崩溃流收尾失败（消息可能滞留 streaming 状态）', {
      streamSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 把单个 StreamChunk 转换为 MessageEventBuffer.append 调用（A 子系统写入路径）。
 *
 * 映射关系：
 *   start             → INSERT messages 行（status='streaming'）+ append status_change
 *   thinking/text     → append thinking_delta / text_delta
 *   tool_call         → append tool_call_start（callId 由 runtime-entry 在 chunk 内携带）
 *   tool_result       → append tool_call_result（callId 配对同一工具调用）
 *   todo_update       → append todo_update
 *   segment_boundary  → INSERT 分段 messages 行（segment_of/segment_index）+ append final
 *   end               → UPDATE messages status + flush + append final
 *
 * DB 未就绪（测试环境 / messages / message_events 表未迁移，SQLite 报
 * "no such table"）时按 debug 级别跳过——buffer 落盘是 best-effort，
 * 不应阻塞子进程 chunk 处理链。其余 DB 错误（磁盘满 / 锁定 / 损坏）
 * 以 error 级别记录（C5：不得静默吞掉生产故障），同样不中断中继。
 */
export function routeChunkToBuffer(chunk: StreamChunk): void {
  try {
    switch (chunk.type) {
      case 'start': {
        insertMessage({
          // Task 6 字段迁移：chunk.sessionId（原 roomId）/ chunk.senderAgentId（原 botUserId）
          sessionId: chunk.sessionId,
          sender: chunk.senderAgentId,
          eventType: 'm.room.message',
          body: '',
          streamSessionId: chunk.streamSessionId,
          parentStreamSessionId: chunk.parentStreamSessionId ?? null,
          status: 'streaming',
        });
        const msg = getMessageByStreamSessionId(chunk.streamSessionId);
        if (!msg) return;
        streamMessageIdCache.set(chunk.streamSessionId, msg.id);
        pushSessionMessage(msg);
        getEventBuffer().append({
          messageId: msg.id,
          eventType: 'status_change',
          payload: { status: 'streaming' },
        });
        return;
      }
      case 'thinking': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'thinking_delta',
          payload: { delta: chunk.delta },
        });
        return;
      }
      case 'text': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'text_delta',
          payload: { delta: chunk.delta },
        });
        return;
      }
      case 'tool_call': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'tool_call_start',
          payload: {
            callId: chunk.callId,
            toolName: chunk.toolName,
            args: chunk.args,
            ...(chunk.isDispatch
              ? {
                  isDispatch: true,
                  subStreamSessionId: chunk.subStreamSessionId,
                  subAgentName: chunk.subAgentName,
                  subAgentAvatar: chunk.subAgentAvatar,
                }
              : {}),
          },
        });
        return;
      }
      case 'tool_result': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'tool_call_result',
          payload: {
            callId: chunk.callId,
            toolName: chunk.toolName,
            result: chunk.result,
            success: chunk.success,
            ...(chunk.subStatus ? { subStatus: chunk.subStatus } : {}),
          },
        });
        return;
      }
      case 'todo_update': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'todo_update',
          payload: { todos: chunk.todos },
        });
        return;
      }
      case 'segment_boundary': {
        // A7 fix：分段边界 → INSERT 独立分段 message row。
        // 父 message 必须已存在（由前置的 start chunk 创建）；不存在则静默跳过。
        // 分段 message 仅存 body 快照 + segment_of/segment_index；后续 events 仍关联父 message。
        // 分段是低频事件（每次 task_complete 一次），直接取全行（需要 sessionId/sender 等字段）
        const parentMsg = getMessageByStreamSessionId(chunk.streamSessionId);
        if (!parentMsg) return;
        const segMsg = insertMessage({
          sessionId: parentMsg.sessionId,
          sender: parentMsg.sender,
          eventType: 'm.room.message',
          body: chunk.segmentBody,
          streamSessionId: chunk.segmentStreamSessionId,
          segmentOf: chunk.streamSessionId,
          segmentIndex: chunk.segmentIndex,
          parentStreamSessionId: parentMsg.parentStreamSessionId,
          workspaceId: parentMsg.workspaceId,
          status: 'done',
        });
        const segBuf = getEventBuffer();
        pushSessionMessage(segMsg);
        segBuf.append({
          messageId: segMsg.id,
          eventType: 'final',
          payload: { body: chunk.segmentBody },
        });
        segBuf.flush();
        return;
      }
      case 'end': {
        const messageId = resolveMessageId(chunk.streamSessionId);
        clearStreamSessionCache(chunk.streamSessionId);
        if (!messageId) return;
        const status =
          chunk.finishReason === 'stop'
            ? 'done'
            : chunk.finishReason === 'interrupted'
              ? 'aborted'
              : 'failed';
        // minor-3：budget_exhausted 时 runtime 不携带 error 字段——此处补中文
        // 错误文案，否则 renderer 失败气泡无任何原因展示
        const errorText =
          chunk.error ??
          (chunk.finishReason === 'budget_exhausted' ? '工具调用预算已耗尽' : undefined);
        updateMessageStatus(messageId, status);
        const buf = getEventBuffer();
        buf.flush();
        buf.append({
          messageId,
          eventType: 'final',
          payload: { status, ...(errorText !== undefined ? { error: errorText } : {}) },
        });
        buf.flush();
        return;
      }
    }
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    if (isDbNotReadyError(errText)) {
      // DB 未就绪 / 表不存在（测试环境）→ debug 级别跳过，不阻塞流式显示
      logger.debug('routeChunkToBuffer 跳过（DB 未就绪或表不存在）', {
        chunkType: chunk.type,
        error: errText,
      });
      return;
    }
    // C5：真实 DB 故障（磁盘满 / 锁定 / 损坏）必须 error 级别暴露——
    // 旧实现 catch-all 全部按 debug 静默，生产数据丢失无任何线索
    logger.error('routeChunkToBuffer 落盘失败（chunk 已跳过，流式中继继续）', {
      chunkType: chunk.type,
      error: errText,
    });
  }
}

// === 按 streamSessionId 中断（注册反转） ===

/** 中断解析器——由 runtime-registry 模块初始化时注入（避免循环依赖） */
let abortResolver: ((streamSessionId: string) => boolean) | null = null;

/**
 * 注册中断解析器。resolver 接收 streamSessionId，广播到所有 runner
 * （各 runner 内部按活跃表过滤），返回是否存在 runner。
 * 传 null 恢复未注入状态（测试隔离用）。
 */
export function setAbortResolver(fn: ((streamSessionId: string) => boolean) | null): void {
  abortResolver = fn;
}

/**
 * 中断指定 streamSessionId 的活跃流式会话。
 * 按 streamSessionId 精确定位中断（旧 v1 按 roomId 索引），
 * PM 与子 agent 同房时不再互相覆盖（修掉"同房中断限制"技术债）。
 *
 * @returns 是否有 runner 接收了广播（未注入 resolver 时 false）
 */
export function abortStreamBySessionId(streamSessionId: string): boolean {
  if (!abortResolver) return false;
  return abortResolver(streamSessionId);
}

/** 注册流式相关 IPC handler（agent:abortStream，入参 streamSessionId） */
export function registerStreamIpc(): void {
  ipcMain.handle('agent:abortStream', (_event, streamSessionId: string) => {
    abortStreamBySessionId(streamSessionId);
  });
}
