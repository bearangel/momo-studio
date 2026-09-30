// renderer/src/components/common/MessageFlash.tsx
//
// 消息定位闪烁共享件（G2 spec §4.2）：keyframes 组件内 <style> 注入（仓库惯例，
// 先例 AgentStreamBubble momo-stream-blink）+ flashMessage 工具。挂载于 MessageList
// （im 视图常驻）；TaskProgressButton 与 locate-message 共用同一视觉。
export const MSG_FLASH_CLASS = 'msg-flash';

/** 闪烁停留时长（ms）——0.8s × 3 次 */
const FLASH_MS = 2400;

export function flashMessage(el: HTMLElement): void {
  el.classList.add(MSG_FLASH_CLASS);
  window.setTimeout(() => el.classList.remove(MSG_FLASH_CLASS), FLASH_MS);
}

export function MessageFlashStyle() {
  return (
    <style>{`
@keyframes momo-msg-flash{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 2px rgb(var(--accent-500))}}
.msg-flash{animation:momo-msg-flash .8s ease-in-out 3}
    `}</style>
  );
}
