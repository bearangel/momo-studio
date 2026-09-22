// renderer/src/components/resource-library/ImportAgentYamlDialog.test.tsx
//
// Agent YAML 导入弹窗测试（spec §4.1）：
//   - 选择文件后回显文件名
//   - 导入调 agent.createFromYaml（原文透传，无客户端解析）
//   - 成功展示「已导入：<name>（<slug>）」
//   - 校验失败错误内联展示（多行/字段名）且弹窗不关
//
// Mock 策略遵循 McpJsonPasteDialog.test / SkillCreateDialog.test 既有形态：
// 在真实 jsdom window 上装 window.api 属性，ipc.client 走真通道（Proxy）经桩。
// vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';
import type { AgentDefinition } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 agent.createFromYaml）----
const agentCreateFromYaml = vi.fn();

const mockApi = {
  agent: { createFromYaml: agentCreateFromYaml },
};

// ---- 测试载荷 ----
const VALID_YAML =
  'apiVersion: v1\nkind: AgentDefinition\nmetadata:\n  name: 审查员\n  slug: reviewer\nspec:\n  declarative:\n    systemPrompt: 你是审查员\n    model:\n      provider: openai\n      model: gpt-4o\n';

const CREATED_DEF: AgentDefinition = {
  id: 'u1',
  name: '审查员',
  slug: 'reviewer',
  version: '1.0.0',
  runtime: 'declarative',
  systemPrompt: '你是审查员',
  defaultTools: [],
  source: 'custom',
  description: '',
  iconEmoji: '',
  workspaceId: null,
  modelProviderId: null,
  modelName: 'gpt-4o',
};

beforeEach(() => {
  agentCreateFromYaml.mockReset().mockResolvedValue(CREATED_DEF);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('ImportAgentYamlDialog', () => {
  it('选择文件后读取文本并展示文件名', async () => {
    render(<ImportAgentYamlDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'reviewer.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    expect(await screen.findByText('reviewer.yaml')).toBeTruthy();
  });

  it('导入调 agent.createFromYaml（原文透传），成功展示名称', async () => {
    render(<ImportAgentYamlDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'reviewer.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(agentCreateFromYaml).toHaveBeenCalledWith(VALID_YAML));
    expect(await screen.findByText(/已导入：审查员/)).toBeTruthy();
  });

  it('校验失败错误内联且弹窗不关', async () => {
    agentCreateFromYaml.mockRejectedValue(
      new Error('Agent manifest 校验失败:\n  - metadata.slug 不能为空'),
    );
    const onClose = vi.fn();
    render(<ImportAgentYamlDialog onClose={onClose} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'bad.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(await screen.findByText(/metadata\.slug 不能为空/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
