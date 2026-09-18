// renderer/src/components/im/MessageBubble.test.tsx
//
// MessageBubble 路由行为：按 eventType 分发到 DispatchCard/TaskReplyCard，
// 并正确透传 isSelf + senderName。用 vi.mock 把卡片替换为可控桩，隔离 store 依赖。
//
// v2.0 A 子系统重写：
//   - 按 message.id 查 stream.store，streaming 时渲染 AgentStreamBubble
//   - 删除旧版从 content 提取 io.momo-studio.* 富字段的测试（逻辑已移除）
//   - 新增 streaming/静态分支测试
//
// v2.11 Task 11：
//   - owner 消息 context chip 渲染（技能纯展示 / 文件点击 file:read 打开编辑器 tab）
//   - 错误路径：读取失败降级 disabled、损坏 JSON 不崩、非法项过滤、workspaceId 缺失
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';

// 可控 mock streams（测试注入 streaming entry）
const mockStreams = new Map<string, StreamState>();

vi.mock('../../stores/stream.store', () => ({
  useStreamStore: (selector: (s: { streams: Map<string, StreamState> }) => unknown) =>
    selector({ streams: mockStreams }),
}));

vi.mock('./DispatchCard', () => ({
  DispatchCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="dispatch" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./TaskReplyCard', () => ({
  TaskReplyCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="task-reply" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./AgentStreamBubble', () => ({
  AgentStreamBubble: (props: { message: ImMessage; senderName?: string }) => (
    <div data-testid="agent-stream" data-msg-id={props.message.id} data-name={props.senderName ?? ''} />
  ),
}));

// window.api mock：文件 chip 点击经 ipc Proxy 直读 window.api.file.read
// （真实契约：read(workspaceId, filePath) → Promise<string>，同 ViewSidebar 用法）。
// 不设置时组件内 ipc.file.read 访问即抛错。
const mockApi = {
  file: {
    read: vi.fn(),
  },
};

import { MessageBubble } from './MessageBubble';
import { useEditorStore } from '../../stores/editor.store';

function makeMsg(id: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id,
    sessionId: '!r',
    sender: '@bot:local',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: null,
    taskId: null,
    contextJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    thinking: '',
    text: '',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming',
    events: [],
    segments: [],
    messageId: 'm1',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('MessageBubble 路由', () => {
  it('io.momo-studio.dispatch → DispatchCard', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.dispatch' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('dispatch')).toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });

  it('dispatch 透传 isSelf + senderName', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.dispatch' });
    render(<MessageBubble message={msg} isSelf={true} senderName="协调员" />);
    const card = screen.getByTestId('dispatch');
    expect(card).toHaveAttribute('data-self', 'true');
    expect(card).toHaveAttribute('data-name', '协调员');
  });

  it('io.momo-studio.task_reply → TaskReplyCard', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.task_reply' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByTestId('task-reply')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
  });

  it('task_reply 透传 isSelf + senderName', () => {
    const msg = makeMsg('m1', { eventType: 'io.momo-studio.task_reply' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    const card = screen.getByTestId('task-reply');
    expect(card).toHaveAttribute('data-self', 'false');
    expect(card).toHaveAttribute('data-name', '码农');
  });

  it('m.room.message 无 stream → 普通气泡（显示 body）', () => {
    mockStreams.clear();
    const msg = makeMsg('m1', { body: '你好' });
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-stream')).not.toBeInTheDocument();
  });
});

describe('MessageBubble streaming 分支（A 子系统）', () => {
  it('stream.status=streaming → AgentStreamBubble', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'streaming' }));
    const msg = makeMsg('m1', { body: '流式中正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
    expect(screen.getByTestId('agent-stream')).toHaveAttribute('data-msg-id', 'm1');
    expect(screen.getByTestId('agent-stream')).toHaveAttribute('data-name', '协调员');
  });

  it('stream.status=done → 静态气泡（不渲染 AgentStreamBubble）', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'done' }));
    const msg = makeMsg('m1', { body: '已完成正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.queryByTestId('agent-stream')).not.toBeInTheDocument();
    expect(screen.getByText('已完成正文')).toBeInTheDocument();
  });

  it('stream.status=failed → AgentStreamBubble（错误文本可见，避免静态气泡吞掉错误）', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({
      messageId: 'm1',
      status: 'failed',
      error: 'LLM 请求无法连接 https://x/v1：ECONNREFUSED',
    }));
    const msg = makeMsg('m1', { body: '失败前的正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
  });
});

describe('MessageBubble 已完成带富信息分支（A9：done 显示富信息）', () => {
  it('stream.status=done 且有 thinking → AgentStreamBubble', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({ messageId: 'm1', status: 'done', thinking: '我在思考' }));
    const msg = makeMsg('m1', { body: '已完成正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
  });

  it('stream.status=done 且有 toolCalls → AgentStreamBubble', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({
      messageId: 'm1',
      status: 'done',
      toolCalls: [{ callId: 'c1', toolName: 'read_file', args: {}, result: 'ok', success: true }],
    }));
    const msg = makeMsg('m1', { body: '已完成正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
  });

  it('stream.status=done 且有 dispatches → AgentStreamBubble', () => {
    mockStreams.clear();
    mockStreams.set('m1', makeStream({
      messageId: 'm1',
      status: 'done',
      dispatches: [{ callId: 'd1', toolName: 'dispatch:coder', subStreamSessionId: 's1', subAgentName: 'coder', task: 't', status: 'completed' }],
    }));
    const msg = makeMsg('m1', { body: '已完成正文' });
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('agent-stream')).toBeInTheDocument();
  });
});

describe('MessageBubble 链接拦截（S2 导航劫持防护）', () => {
  let openSpy: MockInstance<Parameters<typeof window.open>, ReturnType<typeof window.open>>;
  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    openSpy.mockRestore();
  });

  it('markdown 链接渲染为 target=_blank rel=noopener noreferrer', () => {
    mockStreams.clear();
    const msg = makeMsg('m1', { body: '[evil](https://evil.example/x)' });
    render(<MessageBubble message={msg} isSelf={false} />);
    const link = screen.getByRole('link', { name: 'evil' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link).toHaveAttribute('href', 'https://evil.example/x');
  });

  it('点击链接：preventDefault + 委托 window.open（最终走主进程 setWindowOpenHandler）', () => {
    mockStreams.clear();
    const msg = makeMsg('m1', { body: '[evil](https://evil.example/x)' });
    render(<MessageBubble message={msg} isSelf={false} />);
    const link = screen.getByRole('link', { name: 'evil' });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(openSpy).toHaveBeenCalledOnce();
    expect(openSpy.mock.calls[0]![0]).toBe('https://evil.example/x');
  });

  it('javascript: 伪协议链接 → preventDefault 仍生效（但不调 window.open）', () => {
    mockStreams.clear();
    const msg = makeMsg('m1', { body: '[click](javascript:alert(1))' });
    render(<MessageBubble message={msg} isSelf={false} />);
    // react-markdown 解析 javascript: URL；某些版本会过滤。无论如何点击拦截器不执行。
    const link = screen.queryByRole('link', { name: 'click' });
    if (link) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();
    }
  });
});

describe('MessageBubble context chip 渲染（v2.11 Task 11）', () => {
  beforeEach(() => {
    mockStreams.clear();
    // 仅设置 api，不替换整个 window（保留 jsdom Window 的其它属性，避免破坏 react-dom）
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    mockApi.file.read.mockReset();
    // 编辑器是真实 zustand store：逐用例重置，避免 activeTab 跨用例泄漏
    useEditorStore.setState({ tabs: [], activeTab: null });
  });

  it('owner 消息渲染技能与文件 chip', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: '检查这个',
      contextJson: JSON.stringify({
        skills: [{ slug: 'code-review', name: '代码审查' }],
        files: [{ path: 'src/a.ts' }],
      }),
    })} isSelf={true} />);
    expect(screen.getByTestId('message-context-chips')).toBeInTheDocument();
    expect(screen.getByText('代码审查')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('检查这个')).toBeInTheDocument();
  });

  it('文件 chip 点击 file:read 后打开编辑器 tab（workspaceId 取自消息）', async () => {
    mockApi.file.read.mockResolvedValue('const a = 1;');
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x', workspaceId: 'ws-1',
      contextJson: JSON.stringify({ skills: [], files: [{ path: 'src/a.ts' }] }),
    })} isSelf={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    await waitFor(() => {
      expect(useEditorStore.getState().activeTab).toBe('src/a.ts');
    });
    expect(mockApi.file.read).toHaveBeenCalledWith('ws-1', 'src/a.ts');
    expect(useEditorStore.getState().tabs[0]!.content).toBe('const a = 1;');
  });

  it('agent 消息不渲染 context chip（回归锁）', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'agent-x', body: '回复',
      contextJson: JSON.stringify({ skills: [{ slug: 's', name: '技能' }], files: [] }),
    })} isSelf={false} />);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
    expect(screen.queryByText('技能')).not.toBeInTheDocument();
  });

  it('读取失败 chip 降级不可点（错误路径用例）', async () => {
    mockApi.file.read.mockRejectedValue(new Error('不存在'));
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x', workspaceId: 'ws-1',
      contextJson: JSON.stringify({ skills: [], files: [{ path: 'gone.ts' }] }),
    })} isSelf={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'gone.ts' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'gone.ts' })).toBeDisabled();
    });
    expect(useEditorStore.getState().activeTab).toBeNull();
  });

  it('损坏 contextJson 不崩、无 chip 行（解析失败按无上下文兜底）', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: '正文还在',
      contextJson: '{"skills": [ truncated',
    })} isSelf={true} />);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
    expect(screen.getByText('正文还在')).toBeInTheDocument();
  });

  it('contextJson 非数组形状（parseMessageContext 判非法）→ 无 chip 行', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x',
      contextJson: JSON.stringify({ skills: 'nope', files: [] }),
    })} isSelf={true} />);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
  });

  it('非法项（缺 name / 缺 path）过滤不崩，合法项照常渲染（信任边界防御）', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x',
      contextJson: JSON.stringify({
        skills: [{ slug: 'ok', name: '好技能' }, { slug: 'bad' }],
        files: [{ path: 'src/a.ts' }, {}],
      }),
    })} isSelf={true} />);
    expect(screen.getByText('好技能')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.queryByText('bad')).not.toBeInTheDocument();
  });

  it('owner 消息空 context（skills/files 均空数组）→ 不渲染 chip 行', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x',
      contextJson: JSON.stringify({ skills: [], files: [] }),
    })} isSelf={true} />);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
  });

  // I3（终审修复）：P2P 远端镜像的 owner 消息经 sync 改写 sender 为
  // remote:<nodeId>——门控只认 'owner' 令远端 chip 永不渲染。放宽为前缀匹配。
  it('I3：remote:<nodeId> sender 的 owner 消息渲染 context chip（P2P 远端镜像）', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'remote:node-abc123', body: '远端用户消息',
      contextJson: JSON.stringify({
        skills: [{ slug: 'code-review', name: '代码审查' }],
        files: [{ path: 'src/a.ts' }],
      }),
    })} isSelf={false} />);
    expect(screen.getByTestId('message-context-chips')).toBeInTheDocument();
    expect(screen.getByText('代码审查')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('I3：remote: 带原始 sender 尾段的形态（remote:<node>:<sender>）同样渲染', () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'remote:node-1:owner', body: 'x',
      contextJson: JSON.stringify({ skills: [{ slug: 's', name: '技能' }], files: [] }),
    })} isSelf={false} />);
    expect(screen.getByText('技能')).toBeInTheDocument();
  });

  it('workspaceId 缺失（异常数据）：不发 IPC，chip 直接降级不可点', async () => {
    render(<MessageBubble message={makeMsg('m1', {
      sender: 'owner', body: 'x', workspaceId: null,
      contextJson: JSON.stringify({ skills: [], files: [{ path: 'a.ts' }] }),
    })} isSelf={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'a.ts' })).toBeDisabled();
    });
    expect(mockApi.file.read).not.toHaveBeenCalled();
    expect(useEditorStore.getState().activeTab).toBeNull();
  });
});
