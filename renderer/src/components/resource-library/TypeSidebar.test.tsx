// renderer/src/components/resource-library/TypeSidebar.test.tsx
// TypeSidebar 行为：仅渲染 Agent/MCP/Skill 三个菜单项（无总览）；
// 点击项触发 onSelect(key)；选中项带 aria-current="page"。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TypeSidebar } from './TypeSidebar';

describe('TypeSidebar', () => {
  it('渲染三个菜单项（Agent/MCP/Skill），无总览', () => {
    render(<TypeSidebar activeType="agent" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Agent/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /MCP/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Skill/ })).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBe(3);
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
    const agentBtn = screen.getByRole('button', { name: /Agent/ });
    expect(mcpBtn.getAttribute('aria-current')).toBe('page');
    expect(agentBtn.getAttribute('aria-current')).toBeNull();
  });
});
