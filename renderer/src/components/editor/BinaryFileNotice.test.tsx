// renderer/src/components/editor/BinaryFileNotice.test.tsx
// 二进制占位卡（④ VS Code 式）测试：按钮显式触发外部打开/文件夹定位，
// IPC 失败文案经 ipcErrorMessage 剥净（D1 回归锁自 ViewSidebar 自动打开链路迁移）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BinaryFileNotice } from './BinaryFileNotice';

const fileApi = {
  openWithDefaultApp: vi.fn(),
  revealInFolder: vi.fn(),
};

describe('BinaryFileNotice', () => {
  beforeEach(() => {
    fileApi.openWithDefaultApp.mockReset();
    fileApi.revealInFolder.mockReset();
    fileApi.openWithDefaultApp.mockResolvedValue({ ok: true });
    fileApi.revealInFolder.mockResolvedValue({ ok: true });
    (globalThis as unknown as { window: { api: unknown } }).window.api = { file: fileApi };
  });

  it('渲染标题、路径与两个操作按钮', () => {
    render(<BinaryFileNotice workspaceId="ws-1" filePath="assets/hero.png" />);
    expect(screen.getByText('二进制文件，无法在编辑器中预览')).toBeInTheDocument();
    expect(screen.getByText('assets/hero.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '用系统默认应用打开' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeInTheDocument();
  });

  it('「用系统默认应用打开」显式触发 IPC（workspaceId + 路径透传）', async () => {
    render(<BinaryFileNotice workspaceId="ws-1" filePath="assets/hero.png" />);
    fireEvent.click(screen.getByRole('button', { name: '用系统默认应用打开' }));
    await waitFor(() => {
      expect(fileApi.openWithDefaultApp).toHaveBeenCalledWith('ws-1', 'assets/hero.png');
    });
    expect(screen.queryByText(/打开失败/)).not.toBeInTheDocument();
  });

  it('外部打开失败 → 占位卡内错误行展示剥净后的单层中文文案（D1 回归锁）', async () => {
    // 真机实测形态（qa-reports/2026-10-11-file-area-real-acceptance cmd#128）：
    // Electron 给 ipcMain.handle 的 throw 包两层前缀后 reject
    fileApi.openWithDefaultApp.mockRejectedValue(
      new Error(
        "Error invoking remote method 'file:openWithDefaultApp': Error: 外部应用打开失败: Failed to open path",
      ),
    );
    render(<BinaryFileNotice workspaceId="ws-1" filePath="docs/设计稿.psd" />);
    fireEvent.click(screen.getByRole('button', { name: '用系统默认应用打开' }));
    await waitFor(() => {
      expect(screen.getByText('外部应用打开失败: Failed to open path')).toBeInTheDocument();
    });
  });

  it('「在文件夹中显示」失败 → 错误行带「打开所在目录失败：」前缀', async () => {
    fileApi.revealInFolder.mockRejectedValue(
      new Error(
        "Error invoking remote method 'file:revealInFolder': Error: 路径校验失败",
      ),
    );
    render(<BinaryFileNotice workspaceId="ws-1" filePath="x.bin" />);
    fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }));
    await waitFor(() => {
      expect(screen.getByText('打开所在目录失败：路径校验失败')).toBeInTheDocument();
    });
  });

  it('无扩展名路径的类型描述兜底为「未知类型文件」', () => {
    render(<BinaryFileNotice workspaceId="ws-1" filePath="Makefile" />);
    expect(screen.getByText(/未知类型文件/)).toBeInTheDocument();
  });
});
