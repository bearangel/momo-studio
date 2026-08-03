// renderer/src/components/settings/ConversationSettings.test.tsx
//
// ConversationSettings 行为测试：
//   - 挂载时通过 ipc.settings.getGlobal 拉取并显示当前 maxToolCalls
//   - 修改输入后点击保存，调用 ipc.settings.updateGlobal({ maxToolCalls })
//   - 加载阶段显示"加载中..."
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
});
