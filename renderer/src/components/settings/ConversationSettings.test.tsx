// renderer/src/components/settings/ConversationSettings.test.tsx
//
// ConversationSettings 行为测试：
//   - 挂载时通过 ipc.settings.getGlobal 拉取并显示当前 maxToolCalls
//   - 修改输入后点击保存，调用 ipc.settings.updateGlobal({ maxToolCalls })
//   - 加载阶段显示"加载中..."
//   - v2.5：journalQuotaMb 回显 + 修改保存携带（未配置时不随 patch 下发）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConversationSettings } from './ConversationSettings';

const getGlobalMock = vi.fn();
const updateGlobalMock = vi.fn();

// 桩 window.api（仅注入 settings 命名空间）
const mockApi = {
  settings: { getGlobal: getGlobalMock, updateGlobal: updateGlobalMock },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

describe('ConversationSettings', () => {
  beforeEach(() => {
    getGlobalMock.mockReset();
    updateGlobalMock.mockReset();
  });

  it('挂载时显示"加载中..."', () => {
    // 不 resolve，组件停在 loading
    getGlobalMock.mockReturnValue(new Promise(() => {}));
    render(<ConversationSettings />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('加载完成后回显当前 maxToolCalls', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 7 });
    render(<ConversationSettings />);
    await waitFor(() => {
      expect((screen.getByDisplayValue('7') as HTMLInputElement).value).toBe('7');
    });
    expect(getGlobalMock).toHaveBeenCalled();
  });

  it('修改输入并保存，调用 ipc.settings.updateGlobal', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    updateGlobalMock.mockResolvedValue({ maxToolCalls: 25 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('5')).toBeInTheDocument());

    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '25' } });

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ maxToolCalls: 25 });
    });
  });

  it('保存后显示"已保存"提示', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    updateGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('5')).toBeInTheDocument());

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(screen.getByText('已保存')).toBeInTheDocument();
    });
  });

  it('v2.5：回显已配置的 journalQuotaMb', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 7, journalQuotaMb: 300 });
    render(<ConversationSettings />);
    await waitFor(() => {
      expect((screen.getByDisplayValue('300') as HTMLInputElement).value).toBe('300');
    });
  });

  it('v2.5：修改变更保留并保存，updateGlobal 携带 journalQuotaMb', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5, journalQuotaMb: 200 });
    updateGlobalMock.mockResolvedValue({ maxToolCalls: 5, journalQuotaMb: 500 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('200')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('200'), { target: { value: '500' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ maxToolCalls: 5, journalQuotaMb: 500 });
    });
  });

  // 2026-11-09 输入纠正 + 默认无限回归锁
  it('键入负号被即时剥除：-1 → 1，-25 → 25（不允许输入 -1）', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('5')).toBeInTheDocument());

    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '-1' } });
    expect((input as HTMLInputElement).value).toBe('1');

    fireEvent.change(input, { target: { value: '-25' } });
    expect((input as HTMLInputElement).value).toBe('25');
  });

  it('回显 -1（无限）→ 输入留空 + placeholder 无限', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: -1 });
    render(<ConversationSettings />);
    await waitFor(() => {
      const input = screen.getByPlaceholderText('无限') as HTMLInputElement;
      expect(input.value).toBe('');
    });
  });

  it('清空输入保存 → updateGlobal({ maxToolCalls: -1 })（留空=无限）', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    updateGlobalMock.mockResolvedValue({ maxToolCalls: -1 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('5')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ maxToolCalls: -1 });
    });
  });

  it('键入非数字字符全剥除：仅保留数字', async () => {
    getGlobalMock.mockResolvedValue({ maxToolCalls: 5 });
    render(<ConversationSettings />);
    await waitFor(() => expect(screen.getByDisplayValue('5')).toBeInTheDocument());

    const input = screen.getByDisplayValue('5');
    fireEvent.change(input, { target: { value: '1e3' } });
    expect((input as HTMLInputElement).value).toBe('13');
  });
});
