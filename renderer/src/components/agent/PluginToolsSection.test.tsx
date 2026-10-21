// renderer/src/components/agent/PluginToolsSection.test.tsx
// 受控化（spec 2026-10-21 §9③）：checkedFullNames + onToggle(changed, next)——
// changed 可为精确名或组模式串，换算归调用方（Member=授权集 / Definition=denied）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginToolsSection } from './PluginToolsSection';
import type { PluginToolInfo } from '../../ipc/types';

const TOOLS: PluginToolInfo[] = [
  { pluginId: 'p', pluginName: '插件P', toolName: 'a', fullName: 'plugin:p/a', description: '工具A' },
  { pluginId: 'p', pluginName: '插件P', toolName: 'b', fullName: 'plugin:p/b', description: '工具B' },
  { pluginId: 'q', pluginName: '插件Q', toolName: 'c', fullName: 'plugin:q/c', description: '工具C' },
];

describe('PluginToolsSection（受控：checked 由调用方给定）', () => {
  it('勾态完全由 checkedFullNames 决定（默认关语义：空数组 → 全不勾）', () => {
    render(<PluginToolsSection tools={TOOLS} checkedFullNames={[]} onToggle={vi.fn()} disabled={false} />);
    const a = screen.getByRole('checkbox', { name: '启用 plugin:p/a' }) as HTMLInputElement;
    const groupP = screen.getByRole('checkbox', { name: '启用插件 插件P 全部工具' }) as HTMLInputElement;
    expect(a.checked).toBe(false);
    expect(groupP.checked).toBe(false);
    expect(screen.getAllByText('全不启用').length).toBe(2); // 两组各一个组头标注
  });

  it('部分勾 → 组头 indeterminate + 「部分启用」；全勾 → 组头 checked', () => {
    const { rerender } = render(
      <PluginToolsSection tools={TOOLS} checkedFullNames={['plugin:p/a']} onToggle={vi.fn()} disabled={false} />,
    );
    expect(screen.getByText('部分启用')).toBeTruthy();
    rerender(
      <PluginToolsSection
        tools={TOOLS}
        checkedFullNames={['plugin:p/a', 'plugin:p/b']}
        onToggle={vi.fn()}
        disabled={false}
      />,
    );
    const groupP = screen.getByRole('checkbox', { name: '启用插件 插件P 全部工具' }) as HTMLInputElement;
    expect(groupP.checked).toBe(true);
  });

  it('单工具点击 → onToggle(精确名, next)；组头点击 → onToggle(组模式串, next)', () => {
    const onToggle = vi.fn();
    render(<PluginToolsSection tools={TOOLS} checkedFullNames={[]} onToggle={onToggle} disabled={false} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 plugin:p/a' }));
    expect(onToggle).toHaveBeenCalledWith('plugin:p/a', true);
    fireEvent.click(screen.getByRole('checkbox', { name: '启用插件 插件Q 全部工具' }));
    expect(onToggle).toHaveBeenCalledWith('plugin:q/*', true);
  });
});
