// renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx
//
// 新建智能体 4 步向导测试（spec §4.1）：基础信息 → System Prompt → 能力绑定 → 模型与完成。
//   - 四步流转：必填校验拦截空步（名称 / 系统提示词）
//   - 步 3 勾选 MCP/Skill 后 createCustom 携带 defaultMcps/defaultSkills + scope='global'
//   - 上一步回退保留已填内容
//
// Mock 策略遵循 SkillCreateDialog.test / ResourceLibraryView.test 既有形态：
// 在真实 jsdom window 上装 window.api 属性（agent.createCustom / resource.list），
// ipc.client 走真通道（Proxy）经桩——mock 收窄到 IPC 边界（momo-test-rules）。
// ProviderModelPicker / ThinkingOverrideControl 为重数据子组件（provider store +
// listModels 拉取），按 brief 测试代码 vi.mock 桩替换。vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentCreateWizard } from './AgentCreateWizard';
import type { ApiSurface, ResourceItem } from '../../../ipc/types';

// ---- mock IPC 桩（向导只触达 agent.createCustom / resource.list 通道）----
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

const mockApi = {
  agent: { createCustom: createCustomMock },
  resource: { list: listMock },
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

beforeEach(() => {
  createCustomMock.mockClear();
  listMock.mockClear();
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

  it('步 3 勾选 MCP/Skill 后 createCustom 携带 defaultMcps/defaultSkills', async () => {
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
