// renderer/src/components/files/FileContextMenu.test.tsx
// FileContextMenu 右键菜单：目录级新建项 + 重命名/移动/删除。
// 纯展示组件，回调由调用方通过 props 注入。
import { describe, it, expect, vi, afterEach } from 'vitest';
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

// 2026-11-11 溢出修复回归锁：文件树撑满屏幕时右击最底部文件，菜单原先直接按
// clientX/clientY 定位、溢出视口下缘/右缘。要求像 SessionContextMenu.MenuShell
// 一样按实际菜单尺寸回移（jsdom 默认视口 1024×768）。
describe('FileContextMenu 视口钳制（溢出屏幕修复）', () => {
  /** 菜单实际尺寸（模拟真实浏览器测量值；jsdom 中 offsetWidth/Height 恒为 0） */
  const MENU_WIDTH = 200;
  const MENU_HEIGHT = 240;

  function mockMenuSize(width: number, height: number): void {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('坐标在视口内时不做位移', () => {
    mockMenuSize(MENU_WIDTH, MENU_HEIGHT);
    render(<FileContextMenu {...baseProps} x={10} y={20} isDirectory={false} />);
    const menu = screen.getByText('重命名').closest('ul');
    expect(parseFloat(menu!.style.left)).toBe(10);
    expect(parseFloat(menu!.style.top)).toBe(20);
  });

  it('底部溢出：y 超出下缘 → 上移到视口内（不溢出屏幕）', () => {
    mockMenuSize(MENU_WIDTH, MENU_HEIGHT);
    render(<FileContextMenu {...baseProps} x={100} y={760} isDirectory={false} />);
    const menu = screen.getByText('重命名').closest('ul');
    const top = parseFloat(menu!.style.top);
    expect(top).toBe(window.innerHeight - MENU_HEIGHT - 8);
    expect(top + MENU_HEIGHT).toBeLessThanOrEqual(window.innerHeight);
  });

  it('右缘溢出：x 超出右缘 → 左移到视口内', () => {
    mockMenuSize(MENU_WIDTH, MENU_HEIGHT);
    render(<FileContextMenu {...baseProps} x={1000} y={100} isDirectory={false} />);
    const menu = screen.getByText('重命名').closest('ul');
    const left = parseFloat(menu!.style.left);
    expect(left).toBe(window.innerWidth - MENU_WIDTH - 8);
    expect(left + MENU_WIDTH).toBeLessThanOrEqual(window.innerWidth);
  });

  it('右下角双溢出同时钳制', () => {
    mockMenuSize(MENU_WIDTH, MENU_HEIGHT);
    render(<FileContextMenu {...baseProps} x={2000} y={2000} isDirectory={false} />);
    const menu = screen.getByText('重命名').closest('ul');
    expect(parseFloat(menu!.style.left)).toBe(window.innerWidth - MENU_WIDTH - 8);
    expect(parseFloat(menu!.style.top)).toBe(window.innerHeight - MENU_HEIGHT - 8);
  });

  it('菜单尺寸大于视口时钳制到 0，不出现负坐标', () => {
    mockMenuSize(2000, 2000);
    render(<FileContextMenu {...baseProps} x={100} y={100} isDirectory={false} />);
    const menu = screen.getByText('重命名').closest('ul');
    expect(parseFloat(menu!.style.left)).toBe(0);
    expect(parseFloat(menu!.style.top)).toBe(0);
  });
});
