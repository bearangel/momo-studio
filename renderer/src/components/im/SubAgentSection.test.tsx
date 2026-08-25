// renderer/src/components/im/SubAgentSection.test.tsx
//
// SubAgentSection 时间线渲染测试（子 agent 工作过程实时显示）：
//   - segments 按 DOM 顺序线性交错（与 AgentStreamBubble 同构）
//   - 流式光标只跟随最后一个 text 段
//   - 左边框竖线嵌套视觉存在
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StreamState } from '../../stores/stream.store';
import { SubAgentSection } from './SubAgentSection';

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
    messageId: 'sub-1',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('SubAgentSection — segments 时间线', () => {
  it('思考 → 工具 → 正文按 DOM 顺序交错渲染', () => {
    render(
      <SubAgentSection
        stream={makeStream({
          segments: [
            { kind: 'thinking', text: '第一段思考' },
            { kind: 'tool_call', callId: 'c1', toolName: 'grep', args: {}, result: '命中', success: true },
            { kind: 'text', text: '分析结论' },
          ],
        })}
      />,
    );
    const thinking = screen.getByText('思考过程');
    const tool = screen.getByText('grep');
    const text = screen.getByText('分析结论');
    expect(thinking.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('streaming 且末段为 text → 流式光标存在', () => {
    render(
      <SubAgentSection
        stream={makeStream({
          segments: [{ kind: 'text', text: '输出中' }],
        })}
      />,
    );
    expect(screen.getByLabelText('子 agent 流式光标')).toBeInTheDocument();
  });

  it('streaming 但末段为 thinking → 无 text 光标（thinking 流式态）', () => {
    render(
      <SubAgentSection
        stream={makeStream({
          segments: [
            { kind: 'text', text: '前段' },
            { kind: 'thinking', text: '再想想' },
          ],
        })}
      />,
    );
    expect(screen.queryByLabelText('子 agent 流式光标')).not.toBeInTheDocument();
  });

  it('done 状态 → 无流式光标', () => {
    render(
      <SubAgentSection
        stream={makeStream({
          status: 'done',
          segments: [{ kind: 'text', text: '完成' }],
        })}
      />,
    );
    expect(screen.queryByLabelText('子 agent 流式光标')).not.toBeInTheDocument();
  });
});
