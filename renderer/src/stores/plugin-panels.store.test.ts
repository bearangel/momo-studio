// renderer/src/stores/plugin-panels.store.test.ts
//
// T4：面板 store——listPanels 驱动 / activeKey 失效退出 / 宽度钳制。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePluginPanelsStore, panelKeyOf } from './plugin-panels.store';
import type { PluginPanelInfo } from '../ipc/types';

const listPanels = vi.fn();
vi.mock('../ipc/client', () => ({
  ipc: { plugin: { listPanels: (...a: unknown[]) => listPanels(...a) } },
}));

const P1: PluginPanelInfo = {
  pluginId: 'cg',
  pluginName: 'Codegraph',
  panelId: 'graph',
  title: '代码图谱',
  icon: 'lucide:git-fork',
  entryUrl: 'momo-plugin://cg/panel/index.html',
};

beforeEach(() => {
  usePluginPanelsStore.setState({ panels: [], activeKey: null, width: 320 });
  listPanels.mockReset();
});

describe('plugin-panels store', () => {
  it('refresh：listPanels 结果落 store，透传 workspaceId', async () => {
    listPanels.mockResolvedValue([P1]);
    await usePluginPanelsStore.getState().refresh('ws1');
    expect(listPanels).toHaveBeenCalledWith('ws1');
    expect(usePluginPanelsStore.getState().panels).toEqual([P1]);
  });

  it('activeKey 对应面板消失（禁用/卸载推送刷新后）→ 自动退出面板模式', async () => {
    usePluginPanelsStore.setState({ panels: [P1], activeKey: panelKeyOf(P1) });
    listPanels.mockResolvedValue([]); // 禁用后列表为空
    await usePluginPanelsStore.getState().refresh('ws1');
    expect(usePluginPanelsStore.getState().activeKey).toBeNull();
  });

  it('activeKey 仍在列表 → 保留', async () => {
    usePluginPanelsStore.setState({ panels: [P1], activeKey: panelKeyOf(P1) });
    listPanels.mockResolvedValue([P1]);
    await usePluginPanelsStore.getState().refresh('ws1');
    expect(usePluginPanelsStore.getState().activeKey).toBe(panelKeyOf(P1));
  });

  it('refresh 失败 → 清空并退出（容错不炸）', async () => {
    usePluginPanelsStore.setState({ panels: [P1], activeKey: panelKeyOf(P1) });
    listPanels.mockRejectedValue(new Error('boom'));
    await usePluginPanelsStore.getState().refresh('ws1');
    expect(usePluginPanelsStore.getState().panels).toEqual([]);
    expect(usePluginPanelsStore.getState().activeKey).toBeNull();
  });

  it('setWidth 钳制在 240–560', () => {
    usePluginPanelsStore.getState().setWidth(100);
    expect(usePluginPanelsStore.getState().width).toBe(240);
    usePluginPanelsStore.getState().setWidth(999);
    expect(usePluginPanelsStore.getState().width).toBe(560);
    usePluginPanelsStore.getState().setWidth(400);
    expect(usePluginPanelsStore.getState().width).toBe(400);
  });
});
