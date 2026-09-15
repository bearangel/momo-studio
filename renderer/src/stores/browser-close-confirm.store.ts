// renderer/src/stores/browser-close-confirm.store.ts
//
// 关闭浏览器确认卡状态（spec §6.4）：有 agent 拥有 tab 时强制居中确认——
// 防误杀正在操作的 agent；确认后走 browser:closeBrowser（user 源全局销毁）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';

interface BrowserCloseConfirmState {
  open: boolean;
  workspaceId: string | null;
  /** hasAgentTabs=false 直接销毁（无卡）；true 弹卡等确认 */
  request: (workspaceId: string, hasAgentTabs: boolean) => void;
  confirm: () => void;
  cancel: () => void;
}

export const useBrowserCloseConfirmStore = create<BrowserCloseConfirmState>((set, get) => ({
  open: false,
  workspaceId: null,
  request: (workspaceId, hasAgentTabs) => {
    if (!hasAgentTabs) {
      void ipc.browser.closeBrowser(workspaceId).catch(() => {});
      return;
    }
    set({ open: true, workspaceId });
  },
  confirm: () => {
    const wsId = get().workspaceId;
    set({ open: false, workspaceId: null });
    if (wsId) void ipc.browser.closeBrowser(wsId).catch(() => {});
  },
  cancel: () => set({ open: false, workspaceId: null }),
}));
