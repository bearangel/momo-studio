// renderer/src/components/workgroup/NodeCard.test.tsx
//
// 节点卡单元测试（momo-hub M2.1 Task 3 + Task 4 解禁）：
// - 「查看」按钮（T4 接线）：canView=true 可点并回调 onOpenView(nodeId, nodeName)；
//   canView=false 禁用（组长×在线×非本机门控由 GroupMonitor 计算）
// - 在跑行两态：running → spinner 行 + violet「执行中」；pending → 警示行 +
//   warning「等待节点确认」；终态任务（done/failed/…）不进行
// - 空闲态：无在跑 + 在线 → success「空闲」；离线 → neutral「离线」；有在跑行时不渲染状态徽标
// - mono 行：node id 前 4…后 4 截断 + 已镜像空间名（按任务史推导，多空间 · 连接）
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NodeCard } from './NodeCard';
import type { HubGroupMember, HubTaskRecord } from '../../ipc/types';

const OFFICE: HubGroupMember = { nodeId: '8f3a00000000c21e', name: 'office-mac', online: true };
const LAB: HubGroupMember = { nodeId: '2b77000000009af0', name: 'lab-node', online: true };
const SELF: HubGroupMember = { nodeId: 'a3f9c2e1deadbeef', name: 'mac-main', online: true };

function task(partial: Partial<HubTaskRecord> & { taskId: string }): HubTaskRecord {
  return {
    workspaceName: 'dev-ws',
    targetNodeId: OFFICE.nodeId,
    status: 'running',
    title: '任务标题',
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

const onOpenView = vi.fn();

describe('NodeCard', () => {
  it('T4 解禁：canView=true 时「查看」可点，回调 onOpenView(nodeId, nodeName)', () => {
    onOpenView.mockClear();
    render(<NodeCard node={OFFICE} tasks={[]} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />);
    const btn = screen.getByRole('button', { name: '查看' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onOpenView).toHaveBeenCalledWith('8f3a00000000c21e', 'office-mac');
  });

  it('canView=false：「查看」禁用（门控原因 title 提示），点击不触发 onOpenView', () => {
    onOpenView.mockClear();
    render(<NodeCard node={OFFICE} tasks={[]} isLeader={false} isSelf={false} canView={false} onOpenView={onOpenView} />);
    const btn = screen.getByRole('button', { name: '查看' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', '仅组长可查看');
    fireEvent.click(btn);
    expect(onOpenView).not.toHaveBeenCalled();
  });

  it('在跑行两态：running→执行中、pending→等待节点确认；终态任务不进行', () => {
    const tasks = [
      task({ taskId: 't1', status: 'running', title: '批量重命名 legacy API 端点' }),
      task({ taskId: 't2', status: 'pending', title: '为支付回调写集成测试' }),
      task({ taskId: 't3', status: 'done', title: '已完成的任务不该出现' }),
      task({ taskId: 't4', status: 'failed', title: '失败的任务不该出现' }),
      task({ taskId: 't5', status: 'interrupted', title: '中断的任务不该出现' }),
    ];
    render(<NodeCard node={OFFICE} tasks={tasks} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />);
    const card = screen.getByLabelText('节点 office-mac');
    expect(within(card).getByText('批量重命名 legacy API 端点')).toBeInTheDocument();
    expect(within(card).getByText('为支付回调写集成测试')).toBeInTheDocument();
    expect(within(card).getAllByText('执行中').length).toBeGreaterThan(0);
    expect(within(card).getByText('等待节点确认')).toBeInTheDocument();
    expect(within(card).queryByText('已完成的任务不该出现')).not.toBeInTheDocument();
    expect(within(card).queryByText('失败的任务不该出现')).not.toBeInTheDocument();
    expect(within(card).queryByText('中断的任务不该出现')).not.toBeInTheDocument();
    // 有在跑行 → 不渲染空闲徽标（状态由行呈现）
    expect(within(card).queryByText('空闲')).not.toBeInTheDocument();
  });

  it('空闲态：无在跑 + 在线 → 空闲徽标；离线节点 → 离线徽标', () => {
    const { rerender } = render(<NodeCard node={LAB} tasks={[]} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />);
    expect(screen.getByText('空闲')).toBeInTheDocument();
    rerender(
      <NodeCard node={{ ...LAB, online: false }} tasks={[]} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />,
    );
    expect(screen.getByText('离线')).toBeInTheDocument();
  });

  it('mono 行：node id 前4…后4 截断 + 已镜像空间名（多空间 · 连接、无名则省略段）', () => {
    const tasks = [
      task({ taskId: 't1', workspaceName: 'dev-ws', status: 'done' }),
      task({ taskId: 't2', workspaceName: '个人笔记', status: 'done' }),
    ];
    const { rerender } = render(<NodeCard node={OFFICE} tasks={tasks} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />);
    expect(screen.getByText('node:8f3a…c21e · 已镜像 dev-ws · 个人笔记')).toBeInTheDocument();
    rerender(<NodeCard node={OFFICE} tasks={[]} isLeader={false} isSelf={false} canView onOpenView={onOpenView} />);
    expect(screen.getByText('node:8f3a…c21e')).toBeInTheDocument();
  });

  it('leader/本机徽标与组头数据对齐（本机节点也渲染节点卡）', () => {
    render(<NodeCard node={SELF} tasks={[]} isLeader isSelf canView onOpenView={onOpenView} />);
    const card = screen.getByLabelText('节点 mac-main');
    expect(within(card).getByText('leader')).toBeInTheDocument();
    expect(within(card).getByText('本机')).toBeInTheDocument();
  });
});
