// renderer/src/lib/locate-message.ts
//
// 任务双锚点定位链路（G2 spec §4.2）：
//   - locateMessage：来源消息定位——selectSession（如需）→ loadOlder 循环直到
//     命中或 hasMore=false（服务端权威终止；防御上限 50 批）→ revealMessage
//   - locateTaskExecution：执行会话定位——最新 taskId 命中必在首屏窗口（最新
//     消息语义），无需向历史翻页；无命中/非顶层行 → 只切会话
//   - revealMessage：切 im 视图 + 双 rAF 等 DOM 提交 + scrollIntoView + 闪烁
//   - isTopLevelMessage：MessageList 顶层渲染口径单源（两处消费防漂移）
// 悬空 sourceMessageId（撤回后硬删）→ toast 如实告知，返回 message-missing。
import { useSessionStore } from '../stores/session.store';
import { useUiStore } from '../stores/ui.store';
import { showToast } from '../components/ui/Toast';
import { flashMessage } from '../components/common/MessageFlash';
import type { ImMessage } from '../ipc/types';

export type LocateResult = 'located' | 'entered' | 'message-missing';

/** loadOlder 循环防御上限（批）——正常由服务端 hasMore 权威终止 */
const MAX_LOAD_OLDER_BATCHES = 50;

/** MessageList 顶层渲染口径（v1.4 嵌套过滤的单一真相源） */
export function isTopLevelMessage(msg: ImMessage): boolean {
  if (msg.eventType === 'io.momo-studio.dispatch') return false;
  if (msg.eventType === 'io.momo-studio.task_reply') return false;
  if (msg.parentStreamSessionId !== null) return false;
  if (msg.segmentOf !== null) return false;
  return true;
}

function nextFrame(): Promise<void> {
  // 双 rAF：先等 React commit 再查 DOM
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** 切 im 视图并滚动闪烁定位；DOM 行不存在（被过滤的嵌套/分段行）返回 false */
export async function revealMessage(messageId: string): Promise<boolean> {
  useUiStore.getState().setActiveView('im');
  await nextFrame();
  const el = document.getElementById(`msg-${messageId}`);
  if (el === null) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashMessage(el);
  return true;
}

/** 确保会话消息已入 store；失败 toast 并返回 null（调用方中止） */
async function ensureSession(sessionId: string): Promise<boolean> {
  if (useSessionStore.getState().activeSessionId === sessionId) return true;
  try {
    await useSessionStore.getState().selectSession(sessionId);
    return true;
  } catch (err) {
    showToast(`进入会话失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 来源消息定位（任务详情「来源消息」入口） */
export async function locateMessage(
  sessionId: string,
  messageId: string | null,
): Promise<LocateResult> {
  if (!(await ensureSession(sessionId))) return 'message-missing';
  if (messageId === null) {
    useUiStore.getState().setActiveView('im');
    return 'entered';
  }
  const find = (): boolean =>
    (useSessionStore.getState().messagesBySession.get(sessionId) ?? []).some(
      (m) => m.id === messageId,
    );
  let found = find();
  let batches = 0;
  while (
    !found &&
    useSessionStore.getState().hasMoreBySession.get(sessionId) !== false &&
    batches < MAX_LOAD_OLDER_BATCHES
  ) {
    await useSessionStore.getState().loadOlder(sessionId);
    batches += 1;
    found = find();
  }
  if (!found) {
    useUiStore.getState().setActiveView('im');
    showToast('定位失败：消息不存在（可能已被撤回）');
    return 'message-missing';
  }
  return (await revealMessage(messageId)) ? 'located' : 'entered';
}

/** 执行会话定位（任务详情「进入执行会话」入口，全状态可用） */
export async function locateTaskExecution(
  taskId: string,
  executionSessionId: string,
): Promise<LocateResult> {
  if (!(await ensureSession(executionSessionId))) return 'message-missing';
  const msgs =
    useSessionStore.getState().messagesBySession.get(executionSessionId) ?? [];
  // 最新命中必在首屏窗口（最新消息语义），不做历史翻页
  const anchor = [...msgs].reverse().find((m) => isTopLevelMessage(m) && m.taskId === taskId);
  if (anchor === undefined) {
    useUiStore.getState().setActiveView('im');
    return 'entered';
  }
  return (await revealMessage(anchor.id)) ? 'located' : 'entered';
}
