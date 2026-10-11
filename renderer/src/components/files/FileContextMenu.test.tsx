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

  it('根级空白区菜单：只传 onNewFile/onNewDir 时不渲染重命名/移动/删除', () => {
    render(
      <FileContextMenu
        x={100}
        y={100}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('新建文件')).toBeInTheDocument();
    expect(screen.getByText('新建文件夹')).toBeInTheDocument();
    expect(screen.queryByText('重命名')).not.toBeInTheDocument();
    expect(screen.queryByText('移动到…')).not.toBeInTheDocument();
    expect(screen.queryByText(/删除/)).not.toBeInTheDocument();
  });

  it('不传 shell 回调时不渲染三个新菜单项（旧菜单形态不受影响）', () => {
    render(<FileContextMenu {...baseProps} isDirectory={false} />);
    expect(screen.queryByText('用外部应用打开')).not.toBeInTheDocument();
    expect(screen.queryByText('打开所在目录')).not.toBeInTheDocument();
    expect(screen.queryByText('复制路径')).not.toBeInTheDocument();
  });
});

describe('FileContextMenu shell 组（功能优化 2026-10-11）', () => {
  const shellProps = {
    onOpenExternal: vi.fn(),
    onReveal: vi.fn(),
    onCopyPath: vi.fn(),
  };

  it('传入回调时渲染「用外部应用打开」「打开所在目录」「复制路径」', () => {
    render(<FileContextMenu {...baseProps} {...shellProps} isDirectory={false} />);
    expect(screen.getByText('用外部应用打开')).toBeInTheDocument();
    expect(screen.getByText('打开所在目录')).toBeInTheDocument();
    expect(screen.getByText('复制路径')).toBeInTheDocument();
  });

  it.each([
    ['用外部应用打开', 'onOpenExternal'],
    ['打开所在目录', 'onReveal'],
    ['复制路径', 'onCopyPath'],
  ] as const)('点击「%s」触发对应回调并关闭菜单', (label, key) => {
    const onClose = vi.fn();
    render(
      <FileContextMenu
        {...baseProps}
        {...shellProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(label));
    expect(shellProps[key]).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('目录完整菜单三组条目齐备（新建 / shell / 编辑删除）', () => {
    render(
      <FileContextMenu
        {...baseProps}
        {...shellProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    // 新建组
    expect(screen.getByText('新建文件')).toBeInTheDocument();
    // shell 组
    expect(screen.getByText('复制路径')).toBeInTheDocument();
    // 编辑组
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText(/删除（含子项）/)).toBeInTheDocument();
  });

  it('菜单项 hover 反馈双通道：bg-surface-active 背景 + 文字提亮（真机 D 修复回归锁）', () => {
    render(
      <FileContextMenu
        {...baseProps}
        {...shellProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    const normal = screen.getByText('重命名').closest('button');
    expect(normal?.className).toContain('hover:bg-surface-active');
    expect(normal?.className).toContain('hover:text-primary');
    expect(normal?.className).not.toContain('hover:bg-surface-3');
  });

  it('danger 项 hover 文字保持红（不被 hover:text-primary 覆盖）', () => {
    render(
      <FileContextMenu
        {...baseProps}
        {...shellProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    const danger = screen.getByText(/删除（含子项）/).closest('button');
    expect(danger?.className).toContain('text-status-error');
    expect(danger?.className).toContain('hover:text-status-error');
    expect(danger?.className).not.toContain('hover:text-primary');
  });
});
