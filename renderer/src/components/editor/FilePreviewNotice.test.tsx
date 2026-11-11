// renderer/src/components/editor/FilePreviewNotice.test.tsx
// 不可预览占位卡（④ VS Code 式；2026-11-11 扩 tooLarge 态）测试：按钮显式触发
// 外部打开/文件夹定位，IPC 失败文案经 ipcErrorMessage 剥净（D1 回归锁自
// ViewSidebar 自动打开链路迁移）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePreviewNotice } from './FilePreviewNotice';

const fileApi = {
  openWithDefaultApp: vi.fn(),
  revealInFolder: vi.fn(),
};

describe('FilePreviewNotice', () => {
  beforeEach(() => {
    fileApi.openWithDefaultApp.mockReset();
    fileApi.revealInFolder.mockReset();
    fileApi.openWithDefaultApp.mockResolvedValue({ ok: true });
    fileApi.revealInFolder.mockResolvedValue({ ok: true });
    (globalThis as unknown as { window: { api: unknown } }).window.api = { file: fileApi };
  });

  it('binary：渲染标题、路径与两个操作按钮', () => {
    render(
      <FilePreviewNotice
        workspaceId="ws-1"
        notice={{ kind: 'binary', filePath: 'assets/hero.png' }}
      />,
    );
    expect(screen.getByText('二进制文件，无法在编辑器中预览')).toBeInTheDocument();
    expect(screen.getByText('assets/hero.png')).toBeInTheDocument();
    expect(screen.getByText(/可交由系统默认应用打开/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '用系统默认应用打开' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeInTheDocument();
  });

  it('tooLarge：标题改为「文件过大」并展示格式化大小与预览上限说明', () => {
    render(
      <FilePreviewNotice
        workspaceId="ws-1"
        notice={{ kind: 'tooLarge', filePath: 'docs/深圳二院最终稿 250-160.pdf', size: 28 * 1024 * 1024 }}
      />,
    );
    expect(screen.getByText('文件过大，未加载预览')).toBeInTheDocument();
    expect(screen.getByText('28.0 MB · 超出预览上限', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/「PDF」文件/)).toBeInTheDocument();
    expect(screen.queryByText('二进制文件，无法在编辑器中预览')).not.toBeInTheDocument();
  });

  it('tooLarge：仍是显式按钮才触发外部打开（不自动拉起）', async () => {
    render(
      <FilePreviewNotice
        workspaceId="ws-1"
        notice={{ kind: 'tooLarge', filePath: 'big.pdf', size: 5 * 1024 * 1024 }}
      />,
    );
    expect(fileApi.openWithDefaultApp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '用系统默认应用打开' }));
    await waitFor(() => {
      expect(fileApi.openWithDefaultApp).toHaveBeenCalledWith('ws-1', 'big.pdf');
    });
  });

  it('「用系统默认应用打开」显式触发 IPC（workspaceId + 路径透传）', async () => {
    render(
      <FilePreviewNotice
        workspaceId="ws-1"
        notice={{ kind: 'binary', filePath: 'assets/hero.png' }}
      />,
    );
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
    render(
      <FilePreviewNotice
        workspaceId="ws-1"
        notice={{ kind: 'binary', filePath: 'docs/设计稿.psd' }}
      />,
    );
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
    render(
      <FilePreviewNotice workspaceId="ws-1" notice={{ kind: 'binary', filePath: 'x.bin' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }));
    await waitFor(() => {
      expect(screen.getByText('打开所在目录失败：路径校验失败')).toBeInTheDocument();
    });
  });

  it('无扩展名路径的类型描述兜底为「未知类型文件」', () => {
    render(
      <FilePreviewNotice workspaceId="ws-1" notice={{ kind: 'binary', filePath: 'Makefile' }} />,
    );
    expect(screen.getByText(/未知类型文件/)).toBeInTheDocument();
  });
});
