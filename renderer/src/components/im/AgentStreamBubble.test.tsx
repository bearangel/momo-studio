// renderer/src/components/im/AgentStreamBubble.test.tsx
//
// AgentStreamBubble 渲染行为测试（v2.0 A 子系统重写后）：
//   - 各状态（streaming/done/failed/aborted）的状态文案
//   - thinking / toolCalls / dispatches / text 渲染分支
//   - streaming 时显示停止按钮且点击触发 ipc.agent.abortStream(message.roomId)
//
// v2.0 A 子系统变化：
//   - StreamState extends AggregatedStream（按字段渲染，不再按 events 时间线）
//   - 加 message props（roomId/sender 从 message 取）
//   - status 枚举改为 streaming/done/failed/aborted
//   - dispatches 替代旧 dispatchChildren（AggregatedDispatch 结构）
//   - subStream 查找留给 A9（本 task 不测嵌套子 agent 正文）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StreamState } from '../../stores/stream.store';
import type { ImMessage } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { AgentStreamBubble } from './AgentStreamBubble';

const abortStreamMock = vi.fn().mockResolvedValue(undefined);

// 桩 window.api（保留 jsdom window，仅注入 api.agent.abortStream）
const mockApi = { agent: { abortStream: abortStreamMock } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造新接口 StreamState（A 子系统：extends AggregatedStream 的字段集） */
function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    thinking: '',
    text: '',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming',
    events: [],
    messageId: 'm-stream',
    startedAt: Date.now(),
    ...overrides,
  };
}

/** 构造 ImMessage（AgentStreamBubble 的 message props） */
function makeMessage(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-stream',
    roomId: '!room:server',
    sender: '@bot:server',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'streaming',
    source: 'local',
    matrixEventId: null,
    workspaceId: null,
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('AgentStreamBubble', () => {
  beforeEach(() => {
    abortStreamMock.mockClear();
    useStreamStore.setState({ streams: new Map() });
  });

  it('streaming 状态显示「流式中」和停止按钮', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ text: '生成中' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/流式中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument();
    expect(screen.getByText('生成中')).toBeInTheDocument();
  });

  it('done 状态不显示停止按钮', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ status: 'done', text: '完成' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/已完成/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /停止/ })).not.toBeInTheDocument();
  });

  it('aborted 状态显示「已中断」', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ status: 'aborted' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/已中断/)).toBeInTheDocument();
  });

  it('failed 状态显示「出错」', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ status: 'failed' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/出错/)).toBeInTheDocument();
  });

  it('有 thinking 内容时渲染思考过程折叠区（默认折叠，仅显示 toggle）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ thinking: '深度推理' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('思考过程')).toBeInTheDocument();
    expect(screen.queryByText('深度推理')).not.toBeInTheDocument();
  });

  it('有 toolCalls 时渲染工具卡片', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          toolCalls: [
            {
              callId: 'c1',
              toolName: 'read_file',
              args: { path: 'a.ts' },
              result: null,
              success: null,
            },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('点击停止按钮调用 ipc.agent.abortStream(message.roomId)', () => {
    render(
      <AgentStreamBubble
        stream={makeStream()}
        message={makeMessage({ roomId: '!r:server' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(abortStreamMock).toHaveBeenCalledWith('!r:server');
  });

  it('streaming 时渲染流式光标', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ text: '文字' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByLabelText('流式光标')).toBeInTheDocument();
  });

  it('senderName 传入 MessageFrame（非自己消息显示名字）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream()}
        message={makeMessage()}
        senderName="助手-bot"
      />,
    );
    expect(screen.getByText('助手-bot')).toBeInTheDocument();
  });

  it('text 为空且 streaming 时不报错（状态栏仍存在）', () => {
    const { container } = render(
      <AgentStreamBubble
        stream={makeStream({ text: '' })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/流式中/)).toBeInTheDocument();
    expect(container.firstChild).not.toBeNull();
  });
});

describe('AgentStreamBubble — dispatch chips 集成', () => {
  beforeEach(() => {
    useStreamStore.setState({ streams: new Map() });
  });

  it('有 dispatches 时渲染对应的 DispatchChip（显示子 agent 名字）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatches: [
            {
              callId: 'd1',
              subStreamSessionId: 'child-1',
              subAgentName: '研究员',
              task: '',
              status: 'executing',
            },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText('📤')).toBeInTheDocument();
  });

  it('多个 dispatches 时全部渲染', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatches: [
            {
              callId: 'd1',
              subStreamSessionId: 'c1',
              subAgentName: '研究员',
              task: '',
              status: 'executing',
            },
            {
              callId: 'd2',
              subStreamSessionId: 'c2',
              subAgentName: '码农',
              task: '',
              status: 'queued',
            },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
  });

  it('无 dispatches 时不渲染 dispatch chip', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({ dispatches: [] })}
        message={makeMessage()}
      />,
    );
    expect(screen.queryByText('📤')).not.toBeInTheDocument();
  });

  it('进度指示器显示已完成/总数计数（等待 1/2 子任务完成）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatches: [
            {
              callId: 'd1',
              subStreamSessionId: 'c1',
              subAgentName: 'A',
              task: '',
              status: 'completed',
            },
            {
              callId: 'd2',
              subStreamSessionId: 'c2',
              subAgentName: 'B',
              task: '',
              status: 'executing',
            },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText(/等待 1\/2 子任务完成/)).toBeInTheDocument();
  });

  it('全部子任务完成时不显示进度指示器', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          dispatches: [
            {
              callId: 'd1',
              subStreamSessionId: 'c1',
              subAgentName: 'A',
              task: '',
              status: 'completed',
            },
            {
              callId: 'd2',
              subStreamSessionId: 'c2',
              subAgentName: 'B',
              task: '',
              status: 'failed',
            },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.queryByText(/子任务完成/)).not.toBeInTheDocument();
  });
});
