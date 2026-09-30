// renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx
//
// 新建智能体 4 步向导测试（spec §4.1）：基础信息 → System Prompt → 能力绑定 → 模型与完成。
//   - 四步流转：必填校验拦截空步（名称 / 系统提示词）
//   - 步 3 勾选 MCP/Skill 后 createCustom 携带 defaultMcps/defaultSkills + scope='global'
//   - 上一步回退保留已填内容
//   - v2.x 工具能力重构（Task 7）：能力步工具分组来自 IPC 目录（tools:getCatalog，
//     不再是 renderer 镜像常量）；标准档提交 = mock 目录 defaultOn 集；目录未就绪
//     时提交被守卫拦截（对齐 CreateAgentDialog）。
//
// Mock 策略遵循 SkillCreateDialog.test / ResourceLibraryView.test 既有形态：
// 在真实 jsdom window 上装 window.api 属性（agent.createCustom / resource.list /
// tools.getCatalog），ipc.client 走真通道（Proxy）经桩——mock 收窄到 IPC 边界
// （momo-test-rules，同 Task 6 CreateAgentDialog.test 形态）。preset 断言不 import
// 镜像常量，一律用 mock 目录派生集合；目录未就绪守卫用例走 vi.resetModules +
// 动态 import（useToolCatalog 模块级 cache=null 才能真实触发「加载中」路径）。
// ProviderModelPicker / ThinkingOverrideControl 为重数据子组件（provider store +
// listModels 拉取），按 brief 桩替换。vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentCreateWizard } from './AgentCreateWizard';
import type { ApiSurface, ResourceItem, ToolCatalogEntry } from '../../../ipc/types';

// ---- mock IPC 桩（向导触达 agent.createCustom / resource.list / tools.getCatalog 通道）----
// 入参类型取真实 createCustom 签名（Parameters 提取），断言直接消费生产字段
type CreateCustomInput = Parameters<ApiSurface['agent']['createCustom']>[0];
// 返回值向导只 await 不消费，按 brief 保留 3 字段形状（入参才是断言对象）
const createCustomMock = vi.fn(async (_input: CreateCustomInput) => ({ id: 'u1', name: '审查员', slug: 'reviewer' }));
const listMock = vi.fn(async (filter?: { type?: string }): Promise<ResourceItem[]> => {
  if (filter?.type === 'mcp') return [
    { id: 'custom-mcp-github', type: 'mcp', source: 'custom', slug: 'github', name: 'github', description: '', installed: true, installable: false, removable: true },
  ];
  return [
    { id: 'custom-skill-pdf', type: 'skill', source: 'custom', slug: 'pdf', name: 'pdf', description: '', installed: true, installable: false, removable: true },
  ];
});
/** 模拟 IPC 工具目录：两工具同属「文件」类，且该组只有这两项（旧镜像「文件」组有 8 项）——write_file 缺席即分组来源判别器 */
const MOCK_CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', description: '', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'rm', description: '', category: '文件', categoryEmoji: '📁', defaultOn: false },
];
/** mock 目录派生：Tier 1（defaultOn 集）——标准档提交断言用 */
const MOCK_TIER1 = ['read_file'];
const getCatalogMock = vi.fn();

const mockApi = {
  agent: { createCustom: createCustomMock },
  resource: { list: listMock },
  tools: { getCatalog: getCatalogMock },
};

vi.mock('../../agent/ProviderModelPicker', () => ({
  ProviderModelPicker: ({ onProviderChange, onModelChange }: { onProviderChange: (v: string) => void; onModelChange: (v: string) => void }) => (
    <div aria-label="model-picker-stub">
      <button type="button" onClick={() => onProviderChange('openai')}>选供应商</button>
      <button type="button" onClick={() => onModelChange('gpt-4o')}>选模型</button>
    </div>
  ),
}));
vi.mock('../../agent/ThinkingOverrideControl', () => ({
  ThinkingOverrideControl: () => <div aria-label="thinking-stub" />,
}));

function fillStep1AndNext(): void {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '审查员' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}
function fillStep2AndNext(): void {
  fireEvent.change(screen.getByLabelText('系统提示词'), { target: { value: '你是审查员' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

/**
 * 目录未就绪用例专用：vi.resetModules 后动态 import，拿全新组件与全新
 * useToolCatalog 模块实例（模块级 cache=null，「加载中」守卫路径才能真实触发）。
 * ipc Proxy 每次调用现读 window.api，beforeEach 装的桩对全新模块同样生效。
 */
async function importFreshWizard(): Promise<typeof AgentCreateWizard> {
  vi.resetModules();
  const mod = await import('./AgentCreateWizard');
  return mod.AgentCreateWizard;
}

beforeEach(() => {
  createCustomMock.mockClear();
  listMock.mockClear();
  // 默认目录就绪（守卫用例在测试体内改写 getCatalog 为永不 resolve）
  getCatalogMock.mockReset().mockResolvedValue(MOCK_CATALOG);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('AgentCreateWizard', () => {
  it('四步流转：基础→提示词→能力→模型；必填校验拦截空步', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    // 步 1：名称必填
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('名称不能为空')).toBeTruthy();
    fillStep1AndNext();
    // 步 2：提示词必填
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('系统提示词不能为空')).toBeTruthy();
    fillStep2AndNext();
    // 步 3：能力绑定（MCP/Skill 多选出现）
    expect(await screen.findByText('github')).toBeTruthy();
    expect(screen.getByText('pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    // 步 4：模型
    expect(screen.getByLabelText('model-picker-stub')).toBeTruthy();
  });

  it('步 3 勾选 MCP/Skill 后 createCustom 携带 defaultMcps/defaultSkills；标准档 defaultTools=目录 defaultOn 集', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fillStep2AndNext();
    fireEvent.click(await screen.findByRole('checkbox', { name: /github/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '选供应商' }));
    fireEvent.click(screen.getByRole('button', { name: '选模型' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustomMock).toHaveBeenCalled());
    const arg = createCustomMock.mock.calls[0]![0];
    // 标准档（默认）提交的工具集来自 IPC 目录 Tier 1，不再是镜像 SAFE_MINIMUM 常量
    expect(arg.defaultTools).toEqual(MOCK_TIER1.map((ref) => ({ kind: 'builtin', ref })));
    expect(arg.defaultMcps).toEqual([{ kind: 'mcp', ref: 'github' }]);
    expect(arg.defaultSkills).toEqual([{ kind: 'skill', ref: 'pdf' }]);
    expect(arg.scope).toBe('global');
  });

  it('上一步回退保留已填内容', () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('审查员');
  });
});

describe('AgentCreateWizard — 工具目录源（v2.x Task 7）', () => {
  it('能力步骤「自定义」档渲染 IPC 目录分组，Tier 1 回填勾选', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fillStep2AndNext();
    // 切「自定义」档展开工具分组（分组标题 = 目录 categoryEmoji + category）
    fireEvent.click(screen.getByLabelText('自定义'));
    expect(await screen.findByText('📁 文件')).toBeTruthy();
    const readFile = screen.getByLabelText('read_file') as HTMLInputElement;
    const rm = screen.getByLabelText('rm') as HTMLInputElement;
    expect(readFile).toBeTruthy();
    expect(rm).toBeTruthy();
    // 自选档初始勾选 = 目录 defaultOn 集（Tier 1 回填），rm 未默认勾选
    expect(readFile.checked).toBe(true);
    expect(rm.checked).toBe(false);
    // 分组来源判别：mock 目录「文件」组只有 read_file/rm——write_file 在场即仍是镜像常量
    expect(screen.queryByLabelText('write_file')).toBeNull();
    // 回标准档继续到模型步，本用例不触发提交
    fireEvent.click(screen.getByLabelText('标准（推荐）'));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByLabelText('model-picker-stub')).toBeTruthy();
    expect(createCustomMock).not.toHaveBeenCalled();
  });
});

describe('AgentCreateWizard — 空工具集提交守卫（终审 Finding 1）', () => {
  it('自定义档清空全部工具后提交 → 拦截并提示，不调 createCustom', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fillStep2AndNext();
    fireEvent.click(screen.getByLabelText('自定义'));
    // 目录就绪 Tier 1 回填后取消唯一勾选项 → 自选集为空
    fireEvent.click(await screen.findByLabelText('read_file'));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '选供应商' }));
    fireEvent.click(screen.getByRole('button', { name: '选模型' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('至少勾选一个工具，或改用标准档')).toBeTruthy();
    expect(createCustomMock).not.toHaveBeenCalled();
  });
});

describe('AgentCreateWizard — 目录未就绪提交守卫', () => {
  it('标准档 + 目录未就绪 → 提示「工具目录加载中」且不提交', async () => {
    getCatalogMock.mockReturnValue(new Promise(() => {})); // 永不 resolve
    const Fresh = await importFreshWizard();
    render(<Fresh onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fillStep2AndNext();
    fireEvent.click(screen.getByRole('button', { name: '下一步' })); // 能力 → 模型
    fireEvent.click(screen.getByRole('button', { name: '选供应商' }));
    fireEvent.click(screen.getByRole('button', { name: '选模型' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('工具目录加载中，请稍候再提交')).toBeTruthy();
    expect(createCustomMock).not.toHaveBeenCalled();
  });
});
