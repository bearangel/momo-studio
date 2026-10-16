// renderer/src/stores/plugin-panels.store.ts
//
// 插件面板状态（P4，spec §6.1 挂载形态裁定）：面板 = 侧栏槽内容——
// activeKey 非空时 ViewSidebar 渲染 PanelHost（面板模式），主区不动。
// panels 由 plugin:listPanels（workspace 启用过滤）驱动；安装/卸载/重载/启停
// 经 plugin:panelsChanged 推送刷新（ActivityBar 订阅）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { PluginPanelInfo } from '../ipc/types';

export function panelKeyOf(p: Pick<PluginPanelInfo, 'pluginId' | 'panelId'>): string {
  return `${p.pluginId}/${p.panelId}`;
}

const WIDTH_DEFAULT = 320;
const WIDTH_MIN = 240;
const WIDTH_MAX = 560;

interface PluginPanelsState {
  panels: PluginPanelInfo[];
  /** 面板模式激活键（pluginId/panelId）；null = 未激活 */
  activeKey: string | null;
  /** 面板侧栏宽度（独立于视图侧栏，拖拽提交） */
  width: number;
  setWidth: (w: number) => void;
  /** 拉取当前 workspace 的可用面板；activeKey 失效（禁用/卸载）即退出面板模式 */
  refresh: (workspaceId: string) => Promise<void>;
  activate: (key: string) => void;
  deactivate: () => void;
}

export const usePluginPanelsStore = create<PluginPanelsState>((set, get) => ({
  panels: [],
  activeKey: null,
  width: WIDTH_DEFAULT,
  setWidth: (w) => set({ width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(w))) }),
  refresh: async (workspaceId) => {
    try {
      const panels = await ipc.plugin.listPanels(workspaceId);
      const activeKey = get().activeKey;
      const stillThere = activeKey !== null && panels.some((p) => panelKeyOf(p) === activeKey);
      set({ panels, activeKey: stillThere ? activeKey : null });
    } catch {
      set({ panels: [], activeKey: null });
    }
  },
  activate: (key) => set({ activeKey: key }),
  deactivate: () => set({ activeKey: null }),
}));
