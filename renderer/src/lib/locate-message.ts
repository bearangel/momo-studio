// renderer/src/lib/locate-message.ts
//
// 任务双锚点定位链路（G2 spec §4.2）：
//   - locateMessage：来源消息定位——selectSession（如需）→ loadOlder 循环直到
//     命中或 hasMore=false（服务端权威终止；防御上限 50 批）；加载侧失败
//     （loadOlderError / 无进展）即刻如实降级，不空转也不误报撤回
//   - locateTaskExecution：执行会话定位——锚点 = 顶层消息中 task_id 命中任务
//     id 的最新一条（kickoff 行，session-service 落库；agent 回复行落链 id
//     属另一 ID 空间不参与）。锚点可能在首屏窗口之外（执行会话长对话 /
//     复用会话）→ 与 locateMessage 同一翻页循环；穷尽未见 → 会话照进 +
//     toast 说明（旧任务无锚点数据 / 已被撤回），不误报失败
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

/**
 * 确保会话消息已入 store；失败 toast 并返回 false（调用方中止）。
 * 真实 selectSession 吞错不 reject（getMessages 失败只 set({error})），故除
 * try/catch（防御 + 测试可注入 reject）外，await 后还需 post-check：
 * 成功路径必然写 messagesBySession key（即使空数组），失败路径不写。
 */
async function ensureSession(sessionId: string): Promise<boolean> {
  if (useSessionStore.getState().activeSessionId === sessionId) return true;
  try {
    await useSessionStore.getState().selectSession(sessionId);
  } catch (err) {
    showToast(`进入会话失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!useSessionStore.getState().messagesBySession.has(sessionId)) {
    showToast('进入会话失败');
    return false;
  }
  return true;
}

/** 翻页循环的三种终态（两定位入口共用——语义见 paginateUntilFound） */
type PageOutcome = 'found' | 'exhausted' | 'load-failed';

/**
 * loadOlder 翻页循环（locateMessage / locateTaskExecution 共用单点，防两份
 * 副本漂移）：
 *   - found：isFound 命中（含循环前已加载即命中的快路径）
 *   - exhausted：服务端权威到底（hasMore=false）仍未命中
 *   - load-failed：加载侧失败——loadOlderError 置位，或无进展（loadOlder
 *     no-op：空列表守卫 / 加载中防抖不更新长度）防自旋
 */
async function paginateUntilFound(sessionId: string, isFound: () => boolean): Promise<PageOutcome> {
  if (isFound()) return 'found';
  let batches = 0;
  while (
    useSessionStore.getState().hasMoreBySession.get(sessionId) !== false &&
    batches < MAX_LOAD_OLDER_BATCHES
  ) {
    // 无进展基线：loadOlder 存在 no-op 向量（空列表守卫 / 加载中防抖），
    // 这些路径不更新 hasMore——逐轮量长度，无增长即 break 防自旋
    const lenBefore = useSessionStore.getState().messagesBySession.get(sessionId)?.length ?? 0;
    await useSessionStore.getState().loadOlder(sessionId);
    batches += 1;
    if (isFound()) return 'found';
    if (useSessionStore.getState().loadOlderError !== null) {
      // 真实 loadOlder 吞错：set loadOlderError 但不动 hasMore——持续失败时
      // 本轮即如实上报并中止，不空转 50 批后误报「已撤回」
      return 'load-failed';
    }
    const lenAfter = useSessionStore.getState().messagesBySession.get(sessionId)?.length ?? 0;
    if (lenAfter === lenBefore) return 'load-failed';
  }
  return 'exhausted';
}

/** 定位链路加载侧失败降级：切 im 视图 + 如实 toast（不误报「已撤回」） */
function degradeToLoadFailure(): LocateResult {
  useUiStore.getState().setActiveView('im');
  showToast('定位失败：历史消息加载失败');
  return 'message-missing';
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
  const outcome = await paginateUntilFound(sessionId, find);
  if (outcome === 'load-failed') return degradeToLoadFailure();
  if (outcome === 'exhausted') {
    useUiStore.getState().setActiveView('im');
    showToast('定位失败：消息不存在（可能已被撤回）');
    return 'message-missing';
  }
  return (await revealMessage(messageId)) ? 'located' : 'entered';
}

/**
 * 执行会话定位（任务详情「进入执行会话」入口，全状态可用）。
 * 锚点 = 顶层消息中 task_id 命中的最新一条（kickoff 行）；翻页穷尽未见时
 * 如实区分两类原因：旧任务（定位修复前启动，锚点未落库）或消息已被撤回。
 */
export async function locateTaskExecution(
  taskId: string,
  executionSessionId: string,
): Promise<LocateResult> {
  if (!(await ensureSession(executionSessionId))) return 'message-missing';
  const anchorOf = (): ImMessage | undefined => {
    const msgs =
      useSessionStore.getState().messagesBySession.get(executionSessionId) ?? [];
    return [...msgs].reverse().find((m) => isTopLevelMessage(m) && m.taskId === taskId);
  };
  const outcome = await paginateUntilFound(executionSessionId, () => anchorOf() !== undefined);
  const anchor = anchorOf();
  if (outcome === 'load-failed') return degradeToLoadFailure();
  if (anchor === undefined) {
    // 会话照进（底部最新消息），锚点缺失如实说明——「定位失败」措辞会误导
    // 旧任务数据（锚点从未落库，非本次加载失败）
    useUiStore.getState().setActiveView('im');
    showToast('未找到任务关联消息（旧版本任务或已被撤回），已进入会话');
    return 'entered';
  }
  return (await revealMessage(anchor.id)) ? 'located' : 'entered';
}
