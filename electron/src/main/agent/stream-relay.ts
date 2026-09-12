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
  getMessage,
  getMessageByStreamSessionId,
  getLatestMessageByStreamSessionId,
} from '../storage/messages/repo';
import { aggregateTextDeltas } from '../storage/messages/events-repo';

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
  streamTaskIds.clear();
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

/**
 * v2.8.0 链路打标（Task 5）：streamSessionId → 链/任务 taskId（start 建立随 end 清理）。
 * taskId 是链属性不是流属性——message_roll 换行 / segment 分段的后续行同标
 * （roll / segment 落库时优先读本记忆，DB 行值兜底跨进程重启场景）。
 */
const streamTaskIds = new Map<string, string>();

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
  rollCounts.delete(streamSessionId);
  streamTaskIds.delete(streamSessionId);
}

/** v2.3.1 roll 计数：streamSessionId → 已 roll 次数（新行后缀 #roll{n}）。
 * end 的 clearStreamSessionCache 一并清理，防泄漏。 */
const rollCounts = new Map<string, number>();

/** 测试用：清空 roll 计数 */
export function __rollCountsForTest(): void {
  rollCounts.clear();
}

// === T9 命名接线：final 事件落库监听（注册反转，同 setAbortResolver 模式） ===

/**
 * final 事件监听器：'end' chunk 的 final 事件落库后回调（参数为所属 message id）。
 * 生产注册方：router-bootstrap（lazy 启动时注入 session-naming 的 onLeaderFinal，
 * 接待 agent 首次 final → LLM 异步命名）。stream-relay 不 import session-naming，
 * 避免 stream-relay → session-naming → crud → runtime-registry → stream-relay 循环。
 */
type StreamFinalListener = (messageId: string) => void;

let finalListener: StreamFinalListener | null = null;

export function setFinalListener(listener: StreamFinalListener | null): void {
  finalListener = listener;
}

/** 通知 final 监听器；监听器自身异常不中断流式收尾主链 */
function notifyFinalListener(messageId: string): void {
  if (!finalListener) return;
  try {
    finalListener(messageId);
  } catch (err) {
    logger.warn('final 事件监听器执行失败（不影响流式收尾）', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    const buf = getEventBuffer();
    // 与 end 分支同契约：pending 先落盘再聚合回写 body + 推送更新行
    buf.flush();
    updateMessageStatus(msg.id, 'failed', aggregateTextDeltas(msg.id));
    const updated = getMessage(msg.id);
    if (updated) pushSessionMessage(updated);
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
        // C1（v2.6.0 final review）幂等化：resume 是首个跨子进程重启复用
        // streamSessionId 的流程——历史全部 randomUUID 新流，无条件 INSERT
        // 不会撞 ssi；resume 派发后子进程重发 start chunk 会再 INSERT 一条
        // status='streaming' body='' 的僵尸行（无 end 引用 → 下次 boot 被
        // sweepStaleStreaming 标 failed+final「进程中断」→ 会话历史永久幽灵
        // 气泡）。改为先查该流「当前行」（base 精确或 #roll 后缀最新一行，
        // 顶层非 segment）：
        //   - 命中且 streaming → 幂等续流：复用该行不 INSERT——cache 回填 +
        //     推 renderer + 补 status_change（与 resume flip 的 status_change
        //     互为反向呼应；后续事件续落旧行，seq 递增天然连续）
        //   - 命中但非 streaming → 契约外形态（正常 resume 先经
        //     flipMessageBackToStreaming 翻回 streaming 才派发，不应走到）：
        //     warn 后按新流 INSERT 独立行兜底（事件时间线不得挂到终态旧行）
        //   - 未命中 → 历史行为：INSERT 新行
        const existing = getLatestMessageByStreamSessionId(chunk.streamSessionId);
        if (existing && existing.status === 'streaming') {
          streamMessageIdCache.set(chunk.streamSessionId, existing.id);
          // 链路打标续流记忆：resume 重发 start——优先 chunk.taskId；
          // 旧生产者（不带字段）回退既有行的 task_id，跨进程重启不丢标
          if (chunk.taskId !== undefined) {
            streamTaskIds.set(chunk.streamSessionId, chunk.taskId);
          } else if (existing.taskId !== null) {
            streamTaskIds.set(chunk.streamSessionId, existing.taskId);
          }
          pushSessionMessage(existing);
          getEventBuffer().append({
            messageId: existing.id,
            eventType: 'status_change',
            payload: { status: 'streaming' },
          });
          return;
        }
        if (existing) {
          logger.warn(
            'start chunk 命中非 streaming 旧流行，按新流处理（正常 resume 不应出现——flip 应已翻回 streaming）',
            {
              streamSessionId: chunk.streamSessionId,
              existingMessageId: existing.id,
              existingStatus: existing.status,
            },
          );
        }
        const msg = insertMessage({
          // Task 6 字段迁移：chunk.sessionId（原 roomId）/ chunk.senderAgentId（原 botUserId）
          sessionId: chunk.sessionId,
          sender: chunk.senderAgentId,
          eventType: 'm.room.message',
          body: '',
          streamSessionId: chunk.streamSessionId,
          parentStreamSessionId: chunk.parentStreamSessionId ?? null,
          status: 'streaming',
          // v2.8.0 链路打标（Task 5）：undefined → NULL（普通 chat 流零变化）
          taskId: chunk.taskId,
        });
        if (chunk.taskId !== undefined) {
          streamTaskIds.set(chunk.streamSessionId, chunk.taskId);
        }
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
      case 'steer': {
        // v2.6.0 断点续跑：steer drain 事件持久化（spec §2）。
        // 纯事件追加，不动 messages 行状态——与 thinking/text/todo_update 同型。
        // turn-reconstructor 据此重建 [用户中途补充] user 消息或入 steers[]。
        const messageId = resolveMessageId(chunk.streamSessionId);
        if (!messageId) return;
        getEventBuffer().append({
          messageId,
          eventType: 'steer',
          payload: { body: chunk.body },
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
          // 链路打标：分段快照行同属链（记忆优先，父行 DB 值兜底）
          taskId: streamTaskIds.get(chunk.streamSessionId) ?? parentMsg.taskId,
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
      case 'message_roll': {
        // v2.3.1 消息滚动（spec §2.3）：旧行终态化（聚合回写语义同 end 的 done 路径），
        // 新行承接后续输出；cache 换指向后 thinking/text/tool/end 零改动落新行
        const oldId = resolveMessageId(chunk.streamSessionId);
        if (!oldId) return; // 无行则静默跳过（与 start 前置同防御）
        const buf = getEventBuffer();
        // ① 旧行终态化：先冲刷 pending 让全部 text_delta 落盘，再聚合回写
        buf.flush();
        const oldBody = aggregateTextDeltas(oldId);
        updateMessageStatus(oldId, 'done', oldBody);
        const oldUpdated = getMessage(oldId);
        if (oldUpdated) pushSessionMessage(oldUpdated);
        buf.append({ messageId: oldId, eventType: 'final', payload: { body: oldBody } });
        buf.flush();
        // ② 新行：继承旧行会话身份，streamSessionId 加 roll 后缀（避免双行同值歧义）
        const oldMsg = getMessage(oldId)!;
        const n = (rollCounts.get(chunk.streamSessionId) ?? 0) + 1;
        rollCounts.set(chunk.streamSessionId, n);
        const rollMsg = insertMessage({
          sessionId: oldMsg.sessionId,
          sender: oldMsg.sender,
          eventType: 'm.room.message',
          body: '',
          streamSessionId: `${chunk.streamSessionId}#roll${n}`,
          parentStreamSessionId: oldMsg.parentStreamSessionId,
          workspaceId: oldMsg.workspaceId,
          // 链路打标：taskId 是链属性不是流属性——roll 换行不丢标
          //（记忆优先，旧行 DB 值兜底）
          taskId: streamTaskIds.get(chunk.streamSessionId) ?? oldMsg.taskId,
          status: 'streaming',
        });
        streamMessageIdCache.set(chunk.streamSessionId, rollMsg.id);
        pushSessionMessage(rollMsg);
        buf.append({
          messageId: rollMsg.id,
          eventType: 'status_change',
          payload: { status: 'streaming' },
        });
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
        const buf = getEventBuffer();
        // 终态回写 body（2026-09-06 复制/导出契约修复）：先冲刷 pending 让全部
        // text_delta 落盘，再聚合回写——messages.body 成为 agent 正文单一真相源
        buf.flush();
        updateMessageStatus(messageId, status, aggregateTextDeltas(messageId));
        // 推送更新行：renderer receiveMessage 按 id 原位替换——否则复制按钮
        // 读到的仍是 start 时落库的空 body（终态后需重启才能拿到正文）
        const updated = getMessage(messageId);
        if (updated) pushSessionMessage(updated);
        buf.append({
          messageId,
          eventType: 'final',
          payload: { status, ...(errorText !== undefined ? { error: errorText } : {}) },
        });
        buf.flush();
        // T9：final 事件落库点 → 命名服务等下游监听（非 owner 流即 agent 回复完成）
        notifyFinalListener(messageId);
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
