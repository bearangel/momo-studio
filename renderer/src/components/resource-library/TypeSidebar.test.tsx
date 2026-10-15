// renderer/src/components/resource-library/TypeSidebar.test.tsx
// TypeSidebar 行为：三类型 + 「扩展」分组下的插件第四项（spec 2026-10-15 P1）；
// 点击项触发 onSelect(key)；选中项带 aria-current="page"。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TypeSidebar } from './TypeSidebar';

describe('TypeSidebar', () => {
  it('渲染四个菜单项（Agent/MCP/Skill/插件）+ 「扩展」分隔组', () => {
    render(<TypeSidebar activeType="agent" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /智能体/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /MCP/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Skill/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /插件/ })).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBe(4);
    expect(screen.getByText('扩展')).toBeTruthy();
  });

  it('点击插件项回调 plugin', () => {
    const onSelect = vi.fn();
    render(<TypeSidebar activeType="agent" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /插件/ }));
    expect(onSelect).toHaveBeenCalledWith('plugin');
  });

  it('点击切换回调', () => {
    const onSelect = vi.fn();
    render(<TypeSidebar activeType="mcp" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Skill/ }));
    expect(onSelect).toHaveBeenCalledWith('skill');
  });

  it('选中项带 aria-current="page"，未选中项不带', () => {
    render(<TypeSidebar activeType="mcp" onSelect={vi.fn()} />);
    const mcpBtn = screen.getByRole('button', { name: /MCP/ });
    const agentBtn = screen.getByRole('button', { name: /智能体/ });
    expect(mcpBtn.getAttribute('aria-current')).toBe('page');
    expect(agentBtn.getAttribute('aria-current')).toBeNull();
  });
});
