// renderer/src/components/im/AgentStreamBubble.test.tsx
//
// AgentStreamBubble 渲染行为测试（v2.0 A 子系统重写后）：
//   - 各状态（streaming/done/failed/aborted）的状态文案
//   - thinking / toolCalls / dispatches / text 渲染分支
//   - streaming 时显示停止按钮且点击触发 ipc.agent.abortStream(message.sessionId)
//
// v2.0 A 子系统变化：
//   - StreamState extends AggregatedStream（按字段渲染，不再按 events 时间线）
//   - 加 message props（roomId/sender 从 message 取）
//   - status 枚举改为 streaming/done/failed/aborted
//   - dispatches 替代旧 dispatchChildren（AggregatedDispatch 结构）
//   - subStream 查找留给 A9（本 task 不测嵌套子 agent 正文）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StreamState, StreamSegment } from '../../stores/stream.store';
import type { ImMessage } from '../../ipc/types';
import { useStreamStore } from '../../stores/stream.store';
import { AgentStreamBubble } from './AgentStreamBubble';

const abortStreamMock = vi.fn().mockResolvedValue(undefined);

// 桩 window.api（保留 jsdom window，仅注入 api.agent.abortStream）
const mockApi = { agent: { abortStream: abortStreamMock } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/**
 * 构造新接口 StreamState。
 * 未显式提供 segments 时按旧渲染顺序（thinking → tools → dispatches → text）从
 * 平铺字段推导——多数用例只关心单一字段分支，显式提供 segments 的用例测时序。
 */
function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  const base = {
    thinking: '',
    text: '',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming' as const,
    events: [],
    messageId: 'm-stream',
    startedAt: Date.now(),
    ...overrides,
  };
  const segments: StreamSegment[] =
    overrides.segments ??
    [
      ...(base.thinking ? [{ kind: 'thinking' as const, text: base.thinking }] : []),
      ...base.toolCalls.map((tc) => ({ kind: 'tool_call' as const, ...tc })),
      ...base.dispatches.map((d) => ({ kind: 'dispatch' as const, ...d })),
      ...(base.text ? [{ kind: 'text' as const, text: base.text }] : []),
    ];
  return { ...base, segments };
}

/** 构造 ImMessage（AgentStreamBubble 的 message props） */
function makeMessage(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-stream',
    sessionId: '!room:server',
    sender: '@bot:server',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'streaming',
    source: 'local',
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

  it('点击停止按钮调用 ipc.agent.abortStream(message.streamSessionId)', () => {
    render(
      <AgentStreamBubble
        stream={makeStream()}
        message={makeMessage({ streamSessionId: 'ss-stop-1' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(abortStreamMock).toHaveBeenCalledWith('ss-stop-1');
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

describe('AgentStreamBubble — segments 时间线渲染', () => {
  it('思考 → 工具 → 正文 → 再思考 → 再正文按 DOM 顺序交错（而非分块堆叠）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          status: 'done',
          segments: [
            { kind: 'thinking', text: '第一段思考' },
            { kind: 'tool_call', callId: 'c1', toolName: 'list_files', args: {}, result: 'ok', success: true },
            { kind: 'text', text: '第一段正文' },
            { kind: 'thinking', text: '第二段思考' },
            { kind: 'text', text: '第二段正文' },
          ],
        })}
        message={makeMessage()}
      />,
    );

    // 两个思考折叠 toggle 按出现顺序索引（第一个思考在工具之前）
    const toggles = screen.getAllByText('思考过程');
    const tool = screen.getByText('list_files');
    const text1 = screen.getByText('第一段正文');
    const text2 = screen.getByText('第二段正文');

    expect(toggles[0]!.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(text1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text1.compareDocumentPosition(toggles[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggles[1]!.compareDocumentPosition(text2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('流式光标只出现在最后一个 text 段之后（中间 text 段无光标）', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          status: 'streaming',
          segments: [
            { kind: 'text', text: '前段' },
            { kind: 'thinking', text: '正在想' },
          ],
        })}
        message={makeMessage()}
      />,
    );
    // 最后一段是 thinking：无 text 光标，thinking 区处于流式态
    expect(screen.queryByLabelText('流式光标')).not.toBeInTheDocument();
  });
});
