// renderer/src/components/agent/ToolPickerPanel.test.tsx
//
// 工具选择面板测试（2026-11-04 P1 重构）：搜索 + 折叠分组 + 组级三态 + 插件分组。
// 含旧 PluginToolsSection 的等价回归（受控勾态 + onToggle 语义——组件并入本面板）。
//
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api.tools.getCatalog
// 桩）；useToolCatalog 模块级缓存——beforeEach resetModules + 动态 import 取 fresh
// module（CapabilityTabs.test.tsx 同款模式）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ToolCatalogEntry, PluginToolInfo } from '../../ipc/types';
import type { ToolPickerPanelProps } from './ToolPickerPanel';

const getCatalog = vi.fn();

const MOCK_CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', displayName: '读取文件', description: '读文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'write_file', displayName: '写入文件', description: '写文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'grep', displayName: '内容搜索', description: '搜索', category: '搜索', categoryEmoji: '🔍', defaultOn: true },
  { name: 'bash', displayName: '终端命令', description: '执行命令', category: 'Shell', categoryEmoji: '💻', defaultOn: false },
];

const PLUGIN_TOOLS: PluginToolInfo[] = [
  { pluginId: 'p', pluginName: '插件P', toolName: 'a', fullName: 'plugin:p/a', description: '工具A' },
  { pluginId: 'p', pluginName: '插件P', toolName: 'b', fullName: 'plugin:p/b', description: '工具B' },
  { pluginId: 'q', pluginName: '插件Q', toolName: 'c', fullName: 'plugin:q/c', description: '工具C' },
];

beforeEach(() => {
  vi.resetModules();
  getCatalog.mockReset().mockResolvedValue(MOCK_CATALOG);
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    tools: { getCatalog },
  };
});

/** fresh module 渲染（绕过 useToolCatalog 模块级缓存）；必填项给缺省 */
async function renderPanel(props: Partial<ToolPickerPanelProps> = {}) {
  const { ToolPickerPanel } = await import('./ToolPickerPanel');
  return render(<ToolPickerPanel value={props.value ?? []} onChange={props.onChange ?? vi.fn()} {...props} />);
}

/** 展开指定分组（组行 role=button，aria-label = `${label} 分组`） */
function expandGroup(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: `${label} 分组` }));
}

/** 等目录就绪（异步 IPC → 分组渲染即目录已加载）再继续 */
async function awaitCatalog(): Promise<void> {
  await screen.findByRole('button', { name: '文件 分组' });
}

describe('ToolPickerPanel — 折叠分组（默认全收起，预览合同）', () => {
  it('默认全收起：组头可见（含 n/m 计数），工具行不可见', async () => {
    await renderPanel({ value: [], onChange: vi.fn() });
    expect(await screen.findByRole('button', { name: '文件 分组' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '搜索 分组' })).toBeInTheDocument();
    expect(screen.getByText('0/2')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '读取文件（read_file）' })).toBeNull();
  });

  it('点击组行展开；勾选工具 → onChange 单项', async () => {
    const onChange = vi.fn();
    await renderPanel({ value: [], onChange });
    await awaitCatalog();
    expandGroup('文件');
    const cb = screen.getByRole('checkbox', { name: '读取文件（read_file）' });
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledWith(['read_file']);
  });

  it('组级三态：部分勾选 → indeterminate + 计数 some；组头勾选 → 全组并入', async () => {
    const onChange = vi.fn();
    await renderPanel({ value: ['read_file'], onChange });
    await awaitCatalog();
    const groupCb = screen.getByRole('checkbox', { name: '启用 文件 全类工具' }) as HTMLInputElement;
    expect(groupCb.checked).toBe(false);
    expect(groupCb.indeterminate).toBe(true);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expandGroup('文件');
    fireEvent.click(groupCb);
    expect(onChange).toHaveBeenCalledWith(['read_file', 'write_file']);
  });

  it('组头取消勾选 → 组内已选项全部移除', async () => {
    const onChange = vi.fn();
    await renderPanel({ value: ['read_file', 'write_file', 'grep'], onChange });
    await awaitCatalog();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 文件 全类工具' }));
    expect(onChange).toHaveBeenCalledWith(['grep']);
  });
});

describe('ToolPickerPanel — 搜索（中文名/英文名双通道）', () => {
  it('中文命中：命中组强制展开、无关组隐藏、命中片段高亮', async () => {
    await renderPanel({ value: [], onChange: vi.fn() });
    await awaitCatalog();
    const input = screen.getByRole('searchbox', { name: '搜索工具' });
    fireEvent.change(input, { target: { value: '读取' } });
    // 文件组命中展开（组名未命中、工具命中）
    expect(screen.getByRole('checkbox', { name: '读取文件（read_file）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '搜索 分组' })).toBeNull();
    // 高亮片段（accent 类 span）
    expect(document.querySelector('.text-accent-600')?.textContent).toBe('读取');
  });

  it('英文前缀命中：bash 命中 Shell 组', async () => {
    await renderPanel({ value: [], onChange: vi.fn() });
    await awaitCatalog();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工具' }), { target: { value: 'bash' } });
    expect(screen.getByRole('checkbox', { name: '终端命令（bash）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '文件 分组' })).toBeNull();
  });

  it('无命中 → 空态提示', async () => {
    await renderPanel({ value: [], onChange: vi.fn() });
    await awaitCatalog();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工具' }), { target: { value: 'zzz' } });
    expect(screen.getByText('无匹配工具')).toBeInTheDocument();
  });

  it('搜索可勾选命中项', async () => {
    const onChange = vi.fn();
    await renderPanel({ value: [], onChange });
    await awaitCatalog();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工具' }), { target: { value: 'bash' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '终端命令（bash）' }));
    expect(onChange).toHaveBeenCalledWith(['bash']);
  });
});

describe('ToolPickerPanel — 插件分组（旧 PluginToolsSection 等价回归）', () => {
  it('受控勾态：checked 由 pluginChecked 决定；默认收起，展开后精确名可勾', async () => {
    const onPluginToggle = vi.fn();
    await renderPanel({
      value: [],
      onChange: vi.fn(),
      pluginTools: PLUGIN_TOOLS,
      pluginChecked: [],
      onPluginToggle,
    });
    await screen.findByRole('button', { name: '插件P 分组' });
    expect(screen.getByText('插件 p')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '启用 plugin:p/a' })).toBeNull();
    expandGroup('插件P');
    const a = screen.getByRole('checkbox', { name: '启用 plugin:p/a' }) as HTMLInputElement;
    expect(a.checked).toBe(false);
    fireEvent.click(a);
    expect(onPluginToggle).toHaveBeenCalledWith('plugin:p/a', true);
  });

  it('部分勾选 → 组头 indeterminate；全勾 → 组头 checked；组头点击 → 组模式串', async () => {
    const onPluginToggle = vi.fn();
    const { rerender } = await renderPanel({
      value: [],
      onChange: vi.fn(),
      pluginTools: PLUGIN_TOOLS,
      pluginChecked: ['plugin:p/a'],
      onPluginToggle,
    });
    await screen.findByRole('button', { name: '插件P 分组' });
    const groupP = screen.getByRole('checkbox', { name: '启用插件 插件P 全部工具' }) as HTMLInputElement;
    expect(groupP.checked).toBe(false);
    expect(groupP.indeterminate).toBe(true);
    expect(screen.getByText('1/2')).toBeInTheDocument();

    const { ToolPickerPanel } = await import('./ToolPickerPanel');
    rerender(
      <ToolPickerPanel
        value={[]}
        onChange={vi.fn()}
        pluginTools={PLUGIN_TOOLS}
        pluginChecked={['plugin:p/a', 'plugin:p/b']}
        onPluginToggle={onPluginToggle}
      />,
    );
    expect((screen.getByRole('checkbox', { name: '启用插件 插件P 全部工具' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '启用插件 插件Q 全部工具' }));
    expect(onPluginToggle).toHaveBeenCalledWith('plugin:q/*', true);
  });

  it('搜索命中插件工具短名与描述', async () => {
    await renderPanel({
      value: [],
      onChange: vi.fn(),
      pluginTools: PLUGIN_TOOLS,
      pluginChecked: [],
      onPluginToggle: vi.fn(),
    });
    await screen.findByRole('button', { name: '插件P 分组' });
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工具' }), { target: { value: '工具C' } });
    expect(screen.getByRole('checkbox', { name: '启用 plugin:q/c' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '插件P 分组' })).toBeNull();
  });
});

describe('ToolPickerPanel — 快捷按钮与状态', () => {
  it('quickActions：全选/清空/安全最小集（目录数据驱动）', async () => {
    const onChange = vi.fn();
    await renderPanel({ value: [], onChange, quickActions: true });
    await awaitCatalog();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(onChange).toHaveBeenCalledWith(['read_file', 'write_file', 'grep', 'bash']);
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(onChange).toHaveBeenCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: '安全最小集' }));
    expect(onChange).toHaveBeenCalledWith(['read_file', 'write_file', 'grep']);
  });

  it('disabled：组头与工具 checkbox 均 disabled', async () => {
    await renderPanel({ value: ['read_file'], onChange: vi.fn(), disabled: true });
    await awaitCatalog();
    expect((screen.getByRole('checkbox', { name: '启用 文件 全类工具' }) as HTMLInputElement).disabled).toBe(true);
    expandGroup('文件');
    expect((screen.getByRole('checkbox', { name: '读取文件（read_file）' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('目录加载失败 → 错误提示（不炸渲染树）', async () => {
    getCatalog.mockRejectedValue(new Error('IPC 不可用'));
    await renderPanel({ value: [], onChange: vi.fn() });
    expect(await screen.findByText('工具目录加载失败：IPC 不可用')).toBeInTheDocument();
  });
});
