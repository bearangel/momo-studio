// electron/tests/resource/custom-plugin-disabled.test.ts
//
// 展示层启停标注（spec 2026-10-21 消费面矩阵 C1/C2/C3）：
// listCustomResources(workspaceId) 对 plugin 源 MCP/skill/agent 行按
// isPluginEnabled 填 pluginDisabled——管理面（资源库）保留行 + 徽标，
// 选择器（成员编辑// 菜单/向导）消费该字段过滤。无 ws 上下文不标注。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/main/mcp/host-manager', () => ({
  listRegistered: vi.fn(() => [
    {
      id: 'p-cg', name: 'cgx', version: '1.0.0', transport: 'stdio',
      command: 'npx', args: [], source: 'plugin', pluginId: 'cg', installedAt: 'x',
    },
  ]),
}));
vi.mock('../../src/main/skill/zip-uploader', () => ({ listInstalled: vi.fn(() => []) }));
vi.mock('../../src/main/plugin/assembly', () => ({
  listAllPluginSkills: vi.fn(() => [{ slug: 'cg-usage', pluginId: 'cg', name: 'cg-usage', description: '' }]),
}));
vi.mock('../../src/main/agent/crud', () => ({
  listAgentDefinitions: vi.fn(() => [
    {
      id: 'plugin:cg:nav', name: '导航员', slug: 'nav', version: '1', source: 'plugin',
      description: '', iconEmoji: '🤖', systemPrompt: 'p', createdAt: 'x', runtime: 'declarative',
      defaultTools: [], defaultMcps: [], defaultSkills: [], workspaceId: null,
      modelProviderId: 'p', modelName: 'm',
    },
  ]),
}));
const registryFns = vi.hoisted(() => ({ isPluginEnabled: vi.fn() }));
vi.mock('../../src/main/plugin/registry', () => registryFns);

import { listCustomResources } from '../../src/main/resource/custom';

beforeEach(() => {
  registryFns.isPluginEnabled.mockReset();
});

describe('plugin 源行启停标注（C1/C2/C3）', () => {
  it('插件停用时 MCP/skill/agent 三类行均 pluginDisabled=true', () => {
    registryFns.isPluginEnabled.mockReturnValue(false);
    const items = listCustomResources('ws1');
    expect(registryFns.isPluginEnabled).toHaveBeenCalledWith('cg', 'ws1');
    for (const item of items) {
      expect(item.pluginDisabled).toBe(true);
    }
    expect(items).toHaveLength(3);
  });

  it('插件启用 / 无 ws 上下文 → 不标注（undefined）', () => {
    registryFns.isPluginEnabled.mockReturnValue(true);
    for (const item of listCustomResources('ws1')) {
      expect(item.pluginDisabled).toBe(false); // 显式已判定（启用）
    }
    registryFns.isPluginEnabled.mockClear();
    for (const item of listCustomResources()) {
      expect(item.pluginDisabled).toBeUndefined();
      expect(registryFns.isPluginEnabled).not.toHaveBeenCalled();
    }
  });
});
