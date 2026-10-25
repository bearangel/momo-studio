// renderer/src/components/hub/ViewPanel.test.tsx
//
// 远程查看四视图面板行为测试（M2e T14——task-14-preview 批准稿 + notes §4
// 只读红线断言点清单逐项）：
// 1. 零写控件：四页签 + 回放视图 DOM 无 input/textarea/contenteditable/composer
// 2. 按钮白名单：只存在导航/读分页/读重拉/连接管理类按钮（超出即红线违规）
// 3. 订阅生命周期：进入回放恰好一次 view.subscribe；四路径离开（返回/切页签/
//    关面板/断开按钮）各自恰好一次 view.unsubscribe
// 4. 无轮询断言（MC3）：实时增量只经 onViewAppended 回调驱动（mock 侧断言
//    viewMessages/viewSubscribe 不被反复调用）
// 5. 错误路径：forbidden（对方关闭查看）/ node_offline 人话错误态可见
// 6. 密钥红线：概览/配置渲染数据结构无 key/token 字段（类型面协议已锁，
//    渲染面断言 forbidden 文案不出现凭证词）
// 7. 渲染复用：ViewPanel 引用 MessageFrame/ToolCallChip（同基准消息流）——
//    源码静态断言 import
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ViewPanel } from './ViewPanel';
import { useHubViewStore, VIEW_PAGE_SIZE } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubViewAppendedEvent } from '../../ipc/types';

let appendedCb: ((e: HubViewAppendedEvent) => void) | undefined;

const api = {
  hub: {
    viewWorkspace: vi.fn(),
    viewSessions: vi.fn(),
    viewMessages: vi.fn(),
    viewTasks: vi.fn(),
    viewSubscribe: vi.fn(),
    viewUnsubscribe: vi.fn(),
    onViewAppended: vi.fn((cb: (e: HubViewAppendedEvent) => void) => {
      appendedCb = cb;
      return () => undefined;
    }),
  },
  // 空间选择前置步按需拉本机工作空间（真实运行时语义：picking 时 ViewPanel 触发 load）
  workspace: {
    list: vi.fn(),
    switch: vi.fn(async () => undefined),
  },
};

const OVERVIEW = {
  overview: { name: 'product-dev', description: '', sessionCount: 2 },
  agentMembers: [{ name: 'coder', agentSlug: 'coder' }],
  teams: [{ name: 'crew', leaderName: 'coder', memberNames: ['coder', 'pm'] }],
  mcpEnabled: ['fs'],
  skills: ['deploy'],
  pluginsEnabled: ['analysis'],
  resourcesSummary: { agent: 3, mcp: 1, skill: 2, plugin: 1 },
};

function session(sessionId: string, lastSeq: number): { sessionId: string; title: string; lastSeq: number; updatedAt: number } {
  return { sessionId, title: `会话-${sessionId}`, lastSeq, updatedAt: Date.now() };
}

function message(seq: number, content: string, role = 'assistant'): { seq: number; at: number; role: string; content: string } {
  return { seq, at: 1_700_000_000_000 + seq, role, content };
}

function openPanel(): void {
  useHubViewStore.getState().openPanel({
    targetNodeId: 'node-b',
    targetName: 'studio-mini',
    workspaces: [{ id: 'ws-1', name: 'product-dev' }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appendedCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.viewWorkspace.mockResolvedValue(OVERVIEW);
  api.hub.viewSessions.mockResolvedValue({ sessions: [session('sess-1', 120), session('sess-2', 3)] });
  api.hub.viewTasks.mockResolvedValue({
    tasks: [{ taskId: '#T101', title: '远端任务', status: 'in_progress', updatedAt: Date.now() }],
  });
  api.hub.viewMessages.mockResolvedValue({ messages: [], hasMore: false });
  api.hub.viewSubscribe.mockResolvedValue({ ok: true });
  api.hub.viewUnsubscribe.mockResolvedValue({ ok: true });
  api.workspace.list.mockResolvedValue([
    { id: 'ws-1', name: 'product-dev' },
    { id: 'ws-2', name: 'lab' },
  ]);
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, closedIds: [] });
  useHubViewStore.setState({
    open: false, picking: false, targetNodeId: null, targetName: null,
    workspaceId: null, workspaceName: null, tab: 'overview',
    overview: null, sessions: [], tasks: [], loading: false, error: null, replay: null,
  });
});

describe('ViewPanel 打开与四页签', () => {
  it('打开面板三发（workspace/sessions/tasks）；页签切换不重复拉取（缓存）', async () => {
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    expect(api.hub.viewWorkspace).toHaveBeenCalledTimes(1);
    expect(api.hub.viewSessions).toHaveBeenCalledTimes(1);
    expect(api.hub.viewTasks).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /任务/ }));
    expect(screen.getByText('远端任务')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: /配置/ }));
    expect(screen.getByText('MCP（stdio 引用）')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: /概览/ }));
    expect(screen.getByText('资源统计（四类）')).toBeDefined();
    expect(api.hub.viewWorkspace).toHaveBeenCalledTimes(1); // 页签切换不重拉
  });

  it('多工作空间先出空间下拉（前置步）；选择后进入并拉取', async () => {
    useHubViewStore.getState().openPanel({
      targetNodeId: 'node-b',
      targetName: 'studio-mini',
      workspaces: [
        { id: 'ws-1', name: 'product-dev' },
        { id: 'ws-2', name: 'lab' },
      ],
    });
    render(<ViewPanel />);
    expect(screen.getByRole('combobox', { name: '选择工作空间' })).toBeDefined();
    expect(api.hub.viewWorkspace).not.toHaveBeenCalled();
    // 本机工作空间异步加载——等选项就位再选（占位期 change 会落空值）
    await waitFor(() => {
      expect((screen.getByRole('combobox', { name: '选择工作空间' }) as HTMLSelectElement).options.length).toBe(3);
    });
    fireEvent.change(screen.getByRole('combobox', { name: '选择工作空间' }), { target: { value: 'ws-2' } });
    await waitFor(() => expect(api.hub.viewWorkspace).toHaveBeenCalledWith({ targetNodeId: 'node-b', workspaceName: 'lab' }));
  });
});

describe('只读红线（notes §4 断言点 1/2/6/7）', () => {
  it('断言 1 零写控件：四页签 + 回放视图无 input/textarea/contenteditable/composer', async () => {
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    // 进入回放视图再查一遍
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(screen.getByText('已到最早')).toBeDefined()); // hasMore=false → 锚点 disabled

    const panel = screen.getByLabelText('查看 studio-mini 的工作空间 product-dev');
    expect(panel.querySelector('input, textarea, [contenteditable="true"]')).toBeNull();
  });

  it('断言 2 按钮白名单：只存在导航/读分页/读重拉/连接管理类按钮', async () => {
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(screen.getByText('断开订阅')).toBeDefined());

    const labels = [...screen.getAllByRole('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    const whitelist = ['刷新当前页签', '关闭查看面板', '返回会话列表', '断开订阅', '加载更早'];
    for (const l of labels) {
      const hit = whitelist.some((w) => l.includes(w));
      expect(hit, `白名单外按钮: ${l}`).toBe(true);
    }
    // 白名单明令禁的写动作词一个不出现
    for (const banned of ['发送', '新建', '保存', '删除', '取消任务', '重派', '编辑']) {
      expect(labels.some((l) => l.includes(banned)), `红线违规按钮: ${banned}`).toBe(false);
    }
  });

  it('断言 6 密钥红线：渲染面无凭证字段名（apikey/token/authorization/headers）', async () => {
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByText('资源统计（四类）')).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /配置/ }));
    await waitFor(() => expect(screen.getByText('MCP（stdio 引用）')).toBeDefined());
    const panel = screen.getByLabelText('查看 studio-mini 的工作空间 product-dev');
    const text = panel.textContent ?? '';
    for (const word of ['apikey', 'api_key', 'token', 'authorization', 'headers', 'secret']) {
      expect(text.toLowerCase().includes(word), `凭证词渗入渲染面: ${word}`).toBe(false);
    }
  });

  it('断言 7 渲染复用：ViewPanel 源码引用 MessageFrame/ToolCallChip（同基准消息流，不分叉）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'ViewPanel.tsx'), 'utf-8');
    expect(src).toContain("from '../im/MessageFrame'");
    expect(src).toContain("from '../im/ToolCallChip'");
    const delegationSrc = fs.readFileSync(path.resolve(__dirname, 'DelegationPanel.tsx'), 'utf-8');
    expect(delegationSrc).toContain("from '../im/MessageFrame'");
    expect(delegationSrc).toContain("from '../im/ToolCallChip'");
  });
});

describe('回放视图与订阅生命周期（notes §4 断言点 3/4）', () => {
  it('断言 3a 进入回放：尾部一页（fromSeq=lastSeq-页尺寸）+ 恰好一次 subscribe', async () => {
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(1));
    expect(api.hub.viewMessages).toHaveBeenCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: 120 - VIEW_PAGE_SIZE, limit: VIEW_PAGE_SIZE,
    });
    expect(screen.getByText('实时')).toBeDefined();
  });

  it('断言 3b 四路径离开各恰好一次 unsubscribe：返回 / 切页签 / 关面板 / 断开按钮', async () => {
    // 进入回放至 UI 信号「断开订阅」在场（不以待订阅 spy 计数为等待条件——
    // 四段串行时累计计数会与「恰好一次」语义混淆；每段起止清零隔离计数）
    const enterReplay = async (): Promise<ReturnType<typeof render>> => {
      openPanel();
      const r = render(<ViewPanel />);
      await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
      fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
      fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
      await waitFor(() => expect(screen.getByText('断开订阅')).toBeDefined());
      expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(1);
      return r;
    };

    // 路径 1：返回会话列表
    api.hub.viewSubscribe.mockClear();
    api.hub.viewUnsubscribe.mockClear();
    const r1 = await enterReplay();
    fireEvent.click(screen.getByLabelText('返回会话列表'));
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
    r1.unmount();

    // 路径 2：切页签（回放中页签让位于返回头——先返回再切；退订不重复）
    api.hub.viewSubscribe.mockClear();
    api.hub.viewUnsubscribe.mockClear();
    const r2 = await enterReplay();
    fireEvent.click(screen.getByLabelText('返回会话列表'));
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: /任务/ }));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1); // 已离场不重复退订
    r2.unmount();

    // 路径 3：关面板
    api.hub.viewSubscribe.mockClear();
    api.hub.viewUnsubscribe.mockClear();
    const r3 = await enterReplay();
    fireEvent.click(screen.getByLabelText('关闭查看面板'));
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
    r3.unmount();

    // 路径 4：断开订阅按钮（显式 unsubscribe，按钮转 disabled）
    api.hub.viewSubscribe.mockClear();
    api.hub.viewUnsubscribe.mockClear();
    await enterReplay();
    fireEvent.click(screen.getByText('断开订阅'));
    await waitFor(() => expect(api.hub.viewUnsubscribe).toHaveBeenCalledTimes(1));
    expect((screen.getByText('断开订阅') as HTMLButtonElement).disabled).toBe(true);
  });

  it('断言 4 无轮询（MC3）：view.appended 事件驱动淡入追加，view.* 拉取面不被反复调用', async () => {
    api.hub.viewMessages.mockResolvedValue({ messages: [message(118, '已有'), message(119, '已有2'), message(120, '尾条')], hasMore: true });
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(screen.getByText('尾条')).toBeDefined());

    // 实时增量：事件驱动（不经任何拉取面）
    appendedCb!({ sessionId: 'sess-1', events: [message(121, '新到')] });
    await waitFor(() => expect(screen.getByText('新到')).toBeDefined());
    expect(api.hub.viewMessages).toHaveBeenCalledTimes(1); // 无轮询重拉
    expect(api.hub.viewSubscribe).toHaveBeenCalledTimes(1);

    // 「加载更早」锚顶分页：fromSeq 递减再拉一页
    fireEvent.click(screen.getByText('加载更早'));
    await waitFor(() => expect(api.hub.viewMessages).toHaveBeenCalledTimes(2));
    expect(api.hub.viewMessages).toHaveBeenLastCalledWith({
      targetNodeId: 'node-b', sessionId: 'sess-1', workspaceName: 'product-dev',
      fromSeq: Math.max(0, 118 - VIEW_PAGE_SIZE), limit: VIEW_PAGE_SIZE,
    });
  });

  it('seq 去重：view.appended 重复事件不双渲染（hub 侧重连扇出幂等面）', async () => {
    api.hub.viewMessages.mockResolvedValue({ messages: [message(120, '尾条')], hasMore: false });
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(screen.getByText('尾条')).toBeDefined());
    appendedCb!({ sessionId: 'sess-1', events: [message(121, '唯一')] });
    appendedCb!({ sessionId: 'sess-1', events: [message(121, '唯一')] }); // 重复扇出
    await waitFor(() => expect(screen.getByText('唯一')).toBeDefined());
    expect(screen.getAllByText('唯一')).toHaveLength(1);
    // 非当前回放会话的事件忽略
    appendedCb!({ sessionId: 'sess-2', events: [message(9, '别家')] });
    expect(screen.queryByText('别家')).toBeNull();
  });
});

describe('错误路径（notes §4 断言点 5）', () => {
  it('forbidden → 人话「对方节点关闭了本组查看」呈现（不静默吞）', async () => {
    api.hub.viewWorkspace.mockRejectedValue(new Error('目标节点已关闭本组查看'));
    openPanel();
    render(<ViewPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('对方节点关闭了本组查看');
  });

  it('node_offline → 人话「目标节点不在线」；subscribe 失败 → 回放头降级「已断开」', async () => {
    api.hub.viewMessages.mockResolvedValue({ messages: [message(1, 'x')], hasMore: false });
    api.hub.viewSubscribe.mockRejectedValue(new Error('目标节点不在线'));
    openPanel();
    render(<ViewPanel />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '会话 2' })).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: /会话/ }));
    fireEvent.click(screen.getByLabelText('回放会话 会话-sess-1'));
    await waitFor(() => expect(screen.getByText('已断开')).toBeDefined());
    // liveError 同时呈现在头部徽标与流尾 alert——按 role 锚定流尾人话错误态
    expect(screen.getByRole('alert')).toHaveTextContent('目标节点不在线');
    expect((screen.getByText('断开订阅') as HTMLButtonElement).disabled).toBe(true);
  });
});
