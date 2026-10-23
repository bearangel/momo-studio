// renderer/src/components/im/MoveToGroupDialog.test.tsx
//
// 「移动到分组」弹窗（spec 2026-10-22 §4.4）回归锁：
// - 渲染分组列表 + 「未分组」项；当前所属组预选
// - 选既有组提交 → moveToGroup(groupId)；内联新名提交 → 先 create 再归组
// - 错误路径：list / create 失败错误文案可见、弹窗不关
//
// Mock 策略（momo-test-rules）：IPC 边界走 window.api 桩（ipc client 是 Proxy 直读
// window.api，与 RoomList.test / AddAgentDialog.test 同范式）；session.store 只桩
// refreshSessionList（弹窗提交后的列表刷新动作）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { SessionGroupRow, SessionSummary } from '../../ipc/types';

const { sessionState } = vi.hoisted(() => ({
  sessionState: {
    refreshSessionList: vi.fn(),
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
}));

import { MoveToGroupDialog } from './MoveToGroupDialog';

const groupList = vi.fn();
const groupCreate = vi.fn();
const sessionMoveToGroup = vi.fn();

/** 便捷读取当前 window.api 桩 */
function api(): {
  sessionGroup: { list: typeof groupList; create: typeof groupCreate };
  session: { moveToGroup: typeof sessionMoveToGroup };
} {
  return (window as unknown as { api: never })['api'];
}

function makeGroup(overrides: Partial<SessionGroupRow> & { id: string }): SessionGroupRow {
  return { workspaceId: 'ws-1', name: '分组', position: 1024, color: '#5E6AD2', createdAt: 0, ...overrides };
}

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workspaceId: 'ws-1',
    title: '会话',
    titleAuto: false,
    kind: 'chat',
    lastMessageAt: null,
    pinnedAt: null,
    groupId: null,
    groupName: null,
    sessionType: null,
    members: [],
    ...overrides,
  };
}

/** 默认场景：会话已属 g1（一组），可选 g2（二组） */
function setup(groups: SessionGroupRow[], sessions?: SessionSummary[]): void {
  groupList.mockResolvedValue(groups);
  render(
    <MoveToGroupDialog
      sessions={sessions ?? [makeSession({ id: 's1', title: '会话A', groupId: 'g1', groupName: '一组' })]}
      workspaceId="ws-1"
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  groupList.mockReset();
  groupCreate.mockReset();
  sessionMoveToGroup.mockReset();
  sessionMoveToGroup.mockResolvedValue(undefined);
  sessionState.refreshSessionList = vi.fn();

  Object.assign(window, {
    api: {
      sessionGroup: { list: groupList, create: groupCreate },
      session: { moveToGroup: sessionMoveToGroup },
    },
  });
});

describe('MoveToGroupDialog — 渲染与预选', () => {
  it('渲染分组列表 + 「未分组」项', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' }), makeGroup({ id: 'g2', name: '二组' })]);
    const dialog = await screen.findByRole('dialog', { name: '移动「会话A」到分组' });
    expect(within(dialog).getByText('一组')).toBeInTheDocument();
    expect(within(dialog).getByText('二组')).toBeInTheDocument();
    expect(within(dialog).getByText('未分组')).toBeInTheDocument();
  });

  it('当前所属组预选（g1 radio checked）', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' }), makeGroup({ id: 'g2', name: '二组' })]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: '一组' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: '二组' })).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: '未分组' })).not.toBeChecked();
  });

  it('未分组会话（groupId NULL）预选「未分组」', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })], [makeSession({ id: 's1', title: '会话A' })]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: '未分组' })).toBeChecked();
  });
});

describe('MoveToGroupDialog — 提交路径', () => {
  it('选中既有组提交 → moveToGroup(sessionId, groupId) + refreshSessionList + 关闭', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' }), makeGroup({ id: 'g2', name: '二组' })]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '二组' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s1', 'g2'));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('选「未分组」提交 → moveToGroup(sessionId, null)', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '未分组' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s1', null));
  });

  it('内联输入新名提交 → 先 sessionGroup.create 再 moveToGroup(新组 id)', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })]);
    groupCreate.mockResolvedValue(makeGroup({ id: 'g9', name: '新组' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新组' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(groupCreate).toHaveBeenCalledWith('ws-1', '新组'));
    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s1', 'g9'));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('输入新名后既有组 radio 取消选中（新名优先语义）', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'x' } });
    expect(within(dialog).getByRole('radio', { name: '一组' })).not.toBeChecked();
  });
});

describe('MoveToGroupDialog — 错误路径', () => {
  it('create 失败 → 错误文案可见、moveToGroup 不调、弹窗不关', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })]);
    groupCreate.mockRejectedValue(new Error('分组名不能为空'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新组' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    expect(await screen.findByText('分组名不能为空')).toBeInTheDocument();
    expect(sessionMoveToGroup).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moveToGroup 失败 → 错误文案可见、refreshSessionList 不调', async () => {
    setup([makeGroup({ id: 'g1', name: '一组' })]);
    sessionMoveToGroup.mockRejectedValue(new Error('分组不存在或不属于当前会话所在工作空间'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() =>
      expect(screen.getByText('分组不存在或不属于当前会话所在工作空间')).toBeInTheDocument(),
    );
    expect(sessionState.refreshSessionList).not.toHaveBeenCalled();
  });

  it('分组列表加载失败 → 错误文案可见（空输入不阻塞渲染）', async () => {
    groupList.mockRejectedValue(new Error('db locked'));
    render(
      <MoveToGroupDialog
        sessions={[makeSession({ id: 's1', title: '会话A' })]}
        workspaceId="ws-1"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText('db locked')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('MoveToGroupDialog — 批量路径（多选 >1）', () => {
  it('标题为「移动 N 个会话到分组」；首个会话所属组预选', async () => {
    setup(
      [makeGroup({ id: 'g1', name: '一组' }), makeGroup({ id: 'g2', name: '二组' })],
      [
        makeSession({ id: 's1', title: '甲', groupId: 'g1' }),
        makeSession({ id: 's2', title: '乙' }),
      ],
    );
    const dialog = await screen.findByRole('dialog', { name: '移动 2 个会话到分组' });
    expect(within(dialog).getByRole('radio', { name: '一组' })).toBeChecked();
  });

  it('选既有组提交 → 整批逐个 moveToGroup + refreshSessionList', async () => {
    setup(
      [makeGroup({ id: 'g1', name: '一组' }), makeGroup({ id: 'g2', name: '二组' })],
      [makeSession({ id: 's1', title: '甲' }), makeSession({ id: 's2', title: '乙' })],
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '二组' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s1', 'g2'));
    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s2', 'g2'));
    expect(sessionMoveToGroup).toHaveBeenCalledTimes(2);
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('内联新名提交 → create 一次 + 整批移入新组', async () => {
    setup(
      [makeGroup({ id: 'g1', name: '一组' })],
      [makeSession({ id: 's1', title: '甲' }), makeSession({ id: 's2', title: '乙' })],
    );
    groupCreate.mockResolvedValue(makeGroup({ id: 'g9', name: '新组' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新组' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => expect(groupCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s1', 'g9'));
    await waitFor(() => expect(sessionMoveToGroup).toHaveBeenCalledWith('s2', 'g9'));
  });
});
