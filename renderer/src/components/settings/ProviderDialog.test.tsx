// renderer/src/components/settings/ProviderDialog.test.tsx
//
// ProviderDialog（创建模式）行为测试（P2 Task 6）：
// - 表单含 platform 下拉（默认 openai），不再含 defaultModel 字段（由模型列表取代）
// - 提交 → ipc.provider.create 携带 platform
// - 测试连接 → ipc.provider.testConnection
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderDialog } from './ProviderDialog';

const create = vi.fn();
const testConnection = vi.fn();

const mockApi = {
  provider: { create, testConnection },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function renderDialog(onSaved = vi.fn()) {
  return render(
    <ProviderDialog open onClose={vi.fn()} onSaved={onSaved} />,
  );
}

describe('ProviderDialog', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'new-p', platform: 'openai' });
    testConnection.mockReset();
  });

  it('platform 下拉默认 openai，且无「默认模型」字段', () => {
    renderDialog();
    const select = screen.getByLabelText('平台') as HTMLSelectElement;
    expect(select.value).toBe('openai');
    expect(screen.queryByText(/默认模型/)).not.toBeInTheDocument();
  });

  it('填写表单提交 → ipc.provider.create 携带 platform', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'GLM' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'GLM', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', platform: 'openai',
    }));
  });

  it('切换 platform 为 anthropic → create 收到 anthropic', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Claude' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.anthropic.com' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-y' } });
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ platform: 'anthropic' }));
  });

  it('测试连接 → ipc.provider.testConnection 携带 baseUrl/apiKey', async () => {
    testConnection.mockResolvedValue({ ok: true });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://x/v1' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-z' } });
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }));

    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://x/v1', apiKey: 'sk-z',
    }));
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument();
  });

  it('测试连接失败：显示后端错误文案与状态色', async () => {
    testConnection.mockResolvedValue({ ok: false, error: '连接超时' });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://x' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('连接超时')).toHaveClass('text-status-error');
  });

  it('创建成功后触发 onSaved 回调', async () => {
    const onSaved = vi.fn();
    renderDialog(onSaved);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'GLM' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://a' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
