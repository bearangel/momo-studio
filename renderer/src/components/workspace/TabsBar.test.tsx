// renderer/src/components/workspace/TabsBar.test.tsx
//
// TabsBar 单元测试（v2.7 Task 8，spec §3.5）：
//   - tab 列表渲染 + 当前高亮（aria-current）
//   - 点击 tab → onSelect(index)；关闭钮 → onClose(index)（不冒泡选中）
//   - 「+」→ onOpen
// TabsBar 是纯展示组件（回调注入），不触 IPC。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabsBar } from './TabsBar';
import type { BrowserTabInfo } from '../../ipc/types';

function mkTabs(): BrowserTabInfo[] {
  return [
    { index: 0, url: 'https://a.example.com/', title: '页面 A' },
    { index: 1, url: 'https://b.example.com/', title: '页面 B' },
  ];
}

describe('TabsBar（v2.7 Task 8）', () => {
  it('渲染全部 tab 标题', () => {
    render(
      <TabsBar tabs={mkTabs()} current={0} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: '页面 A' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '页面 B' })).toBeInTheDocument();
  });

  it('当前 tab 高亮（aria-current），其余不高亮', () => {
    render(
      <TabsBar tabs={mkTabs()} current={1} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: '页面 B' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('tab', { name: '页面 A' })).not.toHaveAttribute('aria-current');
  });

  it('点击 tab → onSelect(index)', () => {
    const onSelect = vi.fn();
    render(
      <TabsBar tabs={mkTabs()} current={0} onSelect={onSelect} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '页面 B' }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('点击关闭钮 → onClose(index) 且不触发 onSelect（stopPropagation）', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabsBar tabs={mkTabs()} current={0} onSelect={onSelect} onClose={onClose} onOpen={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭 页面 B' }));
    expect(onClose).toHaveBeenCalledWith(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('点击「+」→ onOpen', () => {
    const onOpen = vi.fn();
    render(
      <TabsBar tabs={mkTabs()} current={0} onSelect={vi.fn()} onClose={vi.fn()} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '新建标签页' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('空 tab 列表 → 仅「+」可见（无 tab pill）', () => {
    render(<TabsBar tabs={[]} current={0} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: '新建标签页' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('标题缺失时回退显示 url（防御：about:blank 早期无标题）', () => {
    const tabs: BrowserTabInfo[] = [{ index: 0, url: 'about:blank', title: '' }];
    render(
      <TabsBar tabs={tabs} current={0} onSelect={vi.fn()} onClose={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: 'about:blank' })).toBeInTheDocument();
  });
});
