// renderer/src/components/im/AgentStreamBubble.test.tsx
//
// AgentStreamBubble 渲染行为测试：
//   - 各状态（streaming/done/interrupted/error）的状态文案
//   - thinking / toolCalls / text 渲染分支
//   - streaming 时显示停止按钮且点击触发 ipc.agent.abortStream
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StreamState } from '../../stores/stream.store';
import { useStreamStore } from '../../stores/stream.store';
import { AgentStreamBubble } from './AgentStreamBubble';

const abortStreamMock = vi.fn().mockResolvedValue(undefined);

// 桩 window.api（保留 jsdom window，仅注入 api.agent.abortStream）
const mockApi = { agent: { abortStream: abortStreamMock } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    streamSessionId: 's1',
    roomId: '!room:server',
    botUserId: '@bot:server',
    thinking: '',
    text: '',
    toolCalls: [],
    status: 'streaming',
    dispatchChildren: [],
    ...overrides,
  };
}

describe('AgentStreamBubble', () => {
  beforeEach(() => {
    abortStreamMock.mockClear();
    // 重置 stream store（避免 dispatch chips 测试间的状态泄漏）
    useStreamStore.setState({ streams: new Map() });
  });

  it('streaming 状态显示「流式中」和停止按钮', () => {
    render(<AgentStreamBubble stream={makeStream({ text: '生成中' })} />);
    expect(screen.getByText(/流式中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
    expect(screen.getByText('生成中')).toBeInTheDocument();
  });

  it('done 状态不显示停止按钮', () => {
    render(<AgentStreamBubble stream={makeStream({ status: 'done', text: '完成' })} />);
    expect(screen.getByText(/已完成/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /停止/ })).not.toBeInTheDocument();
  });

  it('interrupted 状态显示「已中断」', () => {
    render(<AgentStreamBubble stream={makeStream({ status: 'interrupted' })} />);
    expect(screen.getByText(/已中断/)).toBeInTheDocument();
  });

  it('error 状态显示「出错」', () => {
    render(<AgentStreamBubble stream={makeStream({ status: 'error', error: 'boom' })} />);
    expect(screen.getByText(/出错/)).toBeInTheDocument();
  });

  it('有 thinking 内容时渲染思考过程折叠区（默认折叠，仅显示 toggle）', () => {
    render(<AgentStreamBubble stream={makeStream({ thinking: '深度推理' })} />);
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    expect(screen.queryByText('深度推理')).not.toBeInTheDocument();
  });

  it('有 toolCalls 时渲染工具卡片', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          toolCalls: [{ toolName: 'read_file', args: { path: 'a.ts' }, isExecuting: true }],
        })}
      />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('点击停止按钮调用 ipc.agent.abortStream(roomId)', () => {
    render(<AgentStreamBubble stream={makeStream({ roomId: '!r:server' })} />);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(abortStreamMock).toHaveBeenCalledWith('!r:server');
  });

  it('streaming 时渲染流式光标', () => {
    render(<AgentStreamBubble stream={makeStream({ text: '文字' })} />);
    // 光标是一个带 animation 的 inline span，用 aria-label 标识便于断言
    expect(screen.getByLabelText('流式光标')).toBeInTheDocument();
  });

  it('senderName 传入 MessageFrame（非自己消息显示名字）', () => {
    render(<AgentStreamBubble stream={makeStream()} senderName="助手-bot" />);
    expect(screen.getByText('助手-bot')).toBeInTheDocument();
  });

  it('text 为空且 streaming 时不渲染正文块（只有光标所在容器不报错）', () => {
    const { container } = render(<AgentStreamBubble stream={makeStream({ text: '' })} />);
    // 没有正文，但组件整体仍应渲染（状态栏存在）
    expect(screen.getByText(/流式中/)).toBeInTheDocument();
    expect(container.firstChild).not.toBeNull();
  });
});

describe('AgentStreamBubble — dispatch chips 集成', () => {
  beforeEach(() => {
    // 重置 stream store（避免 dispatch chips 测试间的状态泄漏）
    useStreamStore.setState({ streams: new Map() });
  });

  it('有 dispatchChildren 时渲染对应的 DispatchChip（显示子 agent 名字）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatchChildren: [
            { subStreamSessionId: 'child-1', subAgentName: '研究员', status: 'executing' },
          ],
        })}
      />,
    );
    expect(screen.getByText('研究员')).toBeInTheDocument();
    // DispatchChip 头行的 📤 标记（ThinkingSection 用 💭，不会冲突）
    expect(screen.getByText('📤')).toBeInTheDocument();
  });

  it('多个 dispatchChildren 时全部渲染', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatchChildren: [
            { subStreamSessionId: 'c1', subAgentName: '研究员', status: 'executing' },
            { subStreamSessionId: 'c2', subAgentName: '码农', status: 'queued' },
          ],
        })}
      />,
    );
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
  });

  it('无 dispatchChildren 时不渲染 dispatch chip', () => {
    render(<AgentStreamBubble stream={makeStream({ dispatchChildren: [] })} />);
    expect(screen.queryByText('📤')).not.toBeInTheDocument();
  });

  it('进度指示器显示已完成/总数计数（等待 1/2 子任务完成）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatchChildren: [
            { subStreamSessionId: 'c1', subAgentName: 'A', status: 'completed' },
            { subStreamSessionId: 'c2', subAgentName: 'B', status: 'executing' },
          ],
        })}
      />,
    );
    expect(screen.getByText(/等待 1\/2 子任务完成/)).toBeInTheDocument();
  });

  it('全部子任务完成时不显示进度指示器', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatchChildren: [
            { subStreamSessionId: 'c1', subAgentName: 'A', status: 'completed' },
            { subStreamSessionId: 'c2', subAgentName: 'B', status: 'failed' },
          ],
        })}
      />,
    );
    expect(screen.queryByText(/子任务完成/)).not.toBeInTheDocument();
  });

  it('从 store 查找子 stream 并透传给 DispatchChip（子 agent 正文可见）', () => {
    // 预置子 agent 的 StreamState 到 store（streams.get(subStreamSessionId) 查找路径）
    const childStream: StreamState = {
      streamSessionId: 'child-1',
      roomId: '!room:server',
      botUserId: '@child:server',
      thinking: '',
      text: '子任务实时输出',
      toolCalls: [],
      status: 'streaming',
      dispatchChildren: [],
    };
    useStreamStore.setState({ streams: new Map([['child-1', childStream]]) });

    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatchChildren: [
            { subStreamSessionId: 'child-1', subAgentName: '码农', status: 'executing' },
          ],
        })}
      />,
    );
    // executing 默认展开 + subStream 已透传 → 子 agent 正文可见
    expect(screen.getByText('子任务实时输出')).toBeInTheDocument();
  });
});
