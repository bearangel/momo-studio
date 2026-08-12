// renderer/src/components/resource-library/AddResourceMenu.test.tsx
// AddResourceMenu 行为：默认折叠；点击 + 添加资源 展开三个菜单项；
// 点击菜单项触发对应 callback 并自动关闭菜单；点击菜单外部自动关闭。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AddResourceMenu } from './AddResourceMenu';

describe('AddResourceMenu', () => {
  it('默认折叠，点击 + 添加资源 展开菜单', () => {
    render(
      <AddResourceMenu
        onCreateAgent={() => {}}
        onRegisterMcp={() => {}}
        onUploadSkill={() => {}}
      />,
    );
    // 初始：三个菜单项均不可见
    expect(screen.queryByText(/创建自定义 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/添加 MCP Server/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上传 Skill 包/)).not.toBeInTheDocument();

    // 点击 + 添加资源 按钮
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));
    // 展开后三项均可见
    expect(screen.getByText(/创建自定义 Agent/)).toBeInTheDocument();
    expect(screen.getByText(/添加 MCP Server/)).toBeInTheDocument();
    expect(screen.getByText(/上传 Skill 包/)).toBeInTheDocument();
  });

  it('展开后显示 3 个菜单项', () => {
    render(
      <AddResourceMenu
        onCreateAgent={() => {}}
        onRegisterMcp={() => {}}
        onUploadSkill={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));
    // 通过 role=menuitem 风格的按钮文本校验三项存在
    expect(screen.getByText(/🤖/)).toBeInTheDocument();
    expect(screen.getByText(/🔌/)).toBeInTheDocument();
    expect(screen.getByText(/📦/)).toBeInTheDocument();
  });

  it('点击「创建自定义 Agent」触发 onCreateAgent + 关闭菜单', () => {
    const onCreateAgent = vi.fn();
    render(
      <AddResourceMenu
        onCreateAgent={onCreateAgent}
        onRegisterMcp={() => {}}
        onUploadSkill={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));
    fireEvent.click(screen.getByText(/创建自定义 Agent/));
    expect(onCreateAgent).toHaveBeenCalledTimes(1);
    // 菜单自动关闭——三项均不可见
    expect(screen.queryByText(/创建自定义 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/添加 MCP Server/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上传 Skill 包/)).not.toBeInTheDocument();
  });

  it('点击外部关闭菜单', () => {
    render(
      <AddResourceMenu
        onCreateAgent={() => {}}
        onRegisterMcp={() => {}}
        onUploadSkill={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /添加资源/ }));
    expect(screen.getByText(/创建自定义 Agent/)).toBeInTheDocument();

    // 模拟点击菜单外部——派发一个 mousedown 事件到 document
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // 菜单关闭——三项均不可见
    expect(screen.queryByText(/创建自定义 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/添加 MCP Server/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上传 Skill 包/)).not.toBeInTheDocument();
  });
});
