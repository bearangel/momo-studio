// renderer/src/components/im/composer-drafts.ts
//
// 会话输入草稿仓（模块级 Map）：跨 composer 卸载/重挂载存续。
//
// why 模块级：MiddlePanel 按视图条件渲染——切到文件/资源库等面板时整个 im
// 分支（含输入框）卸载，组件内 ref/useState 随之销毁；用户去文件面板查资料
// 再回到会话，半截输入必须原样在（2026-11-19 用户反馈「输入内容全部丢失」）。
//
// 两仓分立：普通会话草稿（segments JSON，含 pill）与任务执行会话 steer 草稿
// （纯文本）键空间同为 sessionId，但两类会话互斥、值格式不同——分立 Map 防
// 语义漂移，绝不共享。登出不清理（内存级字符串、sessionId 全局唯一，无泄漏
// 面）；resetComposerDrafts 仅供测试隔离。
import { segmentsToDraft } from './composer-segments';
import type { ComposerSegment } from './composer-segments';

/** 普通会话草稿：sessionId → segments JSON（segmentsToDraft/draftToSegments 往返） */
const chatDrafts = new Map<string, string>();

/** 任务执行会话 steer 草稿：sessionId → 纯文本 */
const steerDrafts = new Map<string, string>();

/** 保存普通会话草稿（segments 序列化——与切会话路径同一序列化器） */
export function saveChatDraft(sessionId: string, segs: ComposerSegment[]): void {
  chatDrafts.set(sessionId, segmentsToDraft(segs));
}

/** 读取普通会话草稿原始 JSON（无则 undefined）；解析交 draftToSegments 宽容恢复 */
export function loadChatDraft(sessionId: string): string | undefined {
  return chatDrafts.get(sessionId);
}

/** 普通会话草稿失效（发送成功后调用——已发出的内容不再是草稿） */
export function clearChatDraft(sessionId: string): void {
  chatDrafts.delete(sessionId);
}

/** steer 草稿写穿（空串即删除，防条目泄漏） */
export function saveSteerDraft(sessionId: string, text: string): void {
  if (text === '') steerDrafts.delete(sessionId);
  else steerDrafts.set(sessionId, text);
}

/** 读取 steer 草稿（无则空串） */
export function loadSteerDraft(sessionId: string): string {
  return steerDrafts.get(sessionId) ?? '';
}

/** 仅测试隔离用：清空两仓（每个用例 beforeEach 调，防跨用例污染） */
export function resetComposerDrafts(): void {
  chatDrafts.clear();
  steerDrafts.clear();
}
