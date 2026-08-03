// renderer/src/components/files/FileContextMenu.test.tsx
// FileContextMenu 右键菜单：目录级新建项 + 重命名/移动/删除。
// 纯展示组件，回调由调用方通过 props 注入。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileContextMenu } from './FileContextMenu';

const baseProps = {
  x: 100,
  y: 100,
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
  onClose: vi.fn(),
};

describe('FileContextMenu', () => {
  it('isDirectory=true 渲染「新建文件」「新建文件夹」按钮', () => {
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    expect(screen.getByText('新建文件')).toBeInTheDocument();
    expect(screen.getByText('新建文件夹')).toBeInTheDocument();
  });

  it('isDirectory=false 不渲染「新建文件」「新建文件夹」', () => {
    render(<FileContextMenu {...baseProps} isDirectory={false} />);
    expect(screen.queryByText('新建文件')).not.toBeInTheDocument();
    expect(screen.queryByText('新建文件夹')).not.toBeInTheDocument();
  });

  it('点击「新建文件」触发 onNewFile 并关闭菜单', () => {
    const onNewFile = vi.fn();
    const onClose = vi.fn();
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={onNewFile}
        onNewDir={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('新建文件'));
    expect(onNewFile).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('点击「新建文件夹」触发 onNewDir 并关闭菜单', () => {
    const onNewDir = vi.fn();
    const onClose = vi.fn();
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={onNewDir}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('新建文件夹'));
    expect(onNewDir).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('现有「重命名」「移动到…」「删除」按钮仍正常', () => {
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText('移动到…')).toBeInTheDocument();
    expect(screen.getByText(/删除/)).toBeInTheDocument();
  });
});
