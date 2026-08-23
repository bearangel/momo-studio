// renderer/src/components/im/ExportChatButton.test.tsx
//
// ExportChatButton 行为测试：
//   - 点击「导出」按钮 → 弹窗打开，数量输入默认 100
//   - 确认 → 调 ipc.session.exportMessages(sessionId, 100)
//   - 成功 → Blob URL + <a download> 触发下载 + 关闭弹窗
//   - 失败 → 红字错误 + 弹窗保持打开
//   - 导出中按钮 disabled（防双击）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportChatButton } from './ExportChatButton';

const exportMock = vi.fn();
const mockApi = {
  session: { exportMessages: exportMock },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// mock URL.createObjectURL + a.click（jsdom 不实现下载）
const clickMock = vi.fn();
const urlMock = 'blob:mock://xxx';

describe('ExportChatButton', () => {
  beforeEach(() => {
    exportMock.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => urlMock),
      revokeObjectURL: vi.fn(),
    });
    // 保存 createElement 原始实现，避免 mock 内递归调用（非 'a' tag 仍走原实现）
    // 对 'a' tag 返回真实 anchor 元素并替换其 click 方法（plain object 通不过
    // body.appendChild 的 Node 类型校验，会让 handleConfirm 走进 catch 分支）。
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(clickMock);
      }
      return el;
    });
    clickMock.mockReset();
  });

  it('点击按钮 → 弹窗（数量输入默认 100）', () => {
    render(<ExportChatButton sessionId="sess-r1" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('确认 → 调 ipc.session.exportMessages(sessionId, 100)', async () => {
    exportMock.mockResolvedValueOnce({ filename: 'momo-session-x.md', content: '# test' });
    render(<ExportChatButton sessionId="sess-r1" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledWith('sess-r1', 100);
    });
  });

  it('成功 → Blob URL + <a download> 触发下载 + 关闭弹窗', async () => {
    exportMock.mockResolvedValueOnce({ filename: 'session.md', content: '# content' });
    render(<ExportChatButton sessionId="sess-r1" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(clickMock).toHaveBeenCalled();
    });
    // 弹窗关闭
    expect(screen.queryByRole('button', { name: '确定' })).not.toBeInTheDocument();
  });

  it('失败 → 红字错误 + 弹窗保持打开', async () => {
    exportMock.mockRejectedValueOnce(new Error('房间不存在'));
    render(<ExportChatButton sessionId="sess-bad" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(screen.getByText(/房间不存在/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('导出中按钮 disabled（防双击）', async () => {
    exportMock.mockImplementationOnce(() => new Promise(() => {})); // never resolve
    render(<ExportChatButton sessionId="sess-r1" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled();
    });
  });
});
