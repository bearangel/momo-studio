// renderer/src/components/ui/Tooltip.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('渲染 role=tooltip 内容与触发子元素', () => {
    render(
      <Tooltip content="删除该成员">
        <button type="button">删除</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('删除该成员');
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
  });

  it('默认隐藏（opacity-0），hover 态类存在 group-hover 机制', () => {
    render(
      <Tooltip content="提示">
        <span>触发</span>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip');
    expect(tip.className).toContain('opacity-0');
    expect(tip.className).toContain('group-hover:opacity-100');
  });

  it('side=bottom 时定位类切换', () => {
    render(
      <Tooltip content="下侧提示" side="bottom">
        <span>触发</span>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip').className).toContain('top-full');
  });
});
