// renderer/src/components/im/DispatchChip.test.tsx
//
// DispatchChip 渲染与交互行为测试：
//   - 5 种状态（queued/executing/completed/failed/aborted）渲染正确的文案 + tone 类
//   - 头行 Send 图标 + avatar（emoji 数据 / Avatar bot 兜底）+ 子 agent 名字
//   - 自动展开/折叠默认值（executing/failed 展开；queued/completed/aborted 折叠）
//   - 点击头行切换展开/折叠
//   - 展开且传入 subStream 时渲染 SubAgentSection（子 agent 正文可见）
//   - status 变化触发的自动展开/折叠行为
//   - 用户手动 toggle 后抑制后续自动行为（userToggled 标志）
//
// v2.1：emoji 字形 / inline hex 断言退役，按 tone class + lucide svg 语义断言。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { StreamState } from '../../stores/stream.store';
import type { DispatchChild } from './DispatchChip';
import { DispatchChip } from './DispatchChip';

/** 构造 DispatchChild（默认 queued） */
function makeChild(overrides: Partial<DispatchChild> = {}): DispatchChild {
  return {
    subStreamSessionId: 'sub-1',
    subAgentName: '码农',
    status: 'queued',
    ...overrides,
  };
}

/** 构造子 agent StreamState（未显式给 segments 时从平铺 text 推导 text 段） */
function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  const base = {
    thinking: '',
    text: '子任务输出文本',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming' as const,
    events: [],
    segments: [],
    messageId: 'sub-1',
    startedAt: Date.now(),
    ...overrides,
  };
  const segments =
    overrides.segments ??
    (base.text ? [{ kind: 'text' as const, text: base.text }] : []);
  return { ...base, segments };
}

/** ElapsedTimer 耗时文本形态：「0s」/「1m05s」（v2.1 计时器无字形，按文本断言） */
const ELAPSED_TEXT = /^\d+(m\d{2})?s$/;

/** 头像 emoji 夹具数据（subAgentAvatar 数据流豁免——非 UI 字形，lint 规则只查 JSX 字面量） */
const EMOJI_AVATAR = '🔬';

describe('DispatchChip — 状态渲染', () => {
  it('queued 渲染 排队（neutral tone：bg-surface-3）', () => {
    render(<DispatchChip child={makeChild({ status: 'queued' })} />);
    const status = screen.getByText(/排队/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('bg-surface-3');
  });

  it('executing 渲染 执行中（warning tint：bg-status-warning-tint）', () => {
    render(<DispatchChip child={makeChild({ status: 'executing' })} />);
    const status = screen.getByText(/执行中/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('bg-status-warning-tint');
  });

  it('completed 渲染 完成（success tint：bg-status-success-tint）', () => {
    render(<DispatchChip child={makeChild({ status: 'completed' })} />);
    const status = screen.getByText(/完成/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('bg-status-success-tint');
  });

  it('failed 渲染 失败（error tint：bg-status-error-tint）', () => {
    render(<DispatchChip child={makeChild({ status: 'failed' })} />);
    const status = screen.getByText(/失败/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('bg-status-error-tint');
  });

  it('aborted 渲染 已中断（warning tint），不显示计时器与活动提示', () => {
    // 回归锁（用户报障）：PM 停止后 dispatch 不得停留在 executing——
    // 否则 ElapsedTimer 每秒持续计时
    render(
      <DispatchChip
        child={makeChild({ status: 'aborted' })}
        subStream={makeStream({ segments: [{ kind: 'thinking', text: '做到一半' }] })}
      />,
    );
    const status = screen.getByText(/已中断/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('bg-status-warning-tint');
    expect(screen.queryByText(ELAPSED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispatch-activity')).not.toBeInTheDocument();
  });

  it('头行渲染 Send 图标 + avatar + 子 agent 名字', () => {
    const { container } = render(
      <DispatchChip
        child={makeChild({ subAgentName: '研究员', subAgentAvatar: EMOJI_AVATAR })}
      />,
    );
    // 派单图标（lucide Send）+ 头像 emoji（数据流豁免）和名字都在头行内
    expect(container.querySelector('svg.lucide-send')).not.toBeNull();
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText(EMOJI_AVATAR)).toBeInTheDocument();
  });

  it('subAgentAvatar 缺省时回退 Avatar bot 图标', () => {
    const { container } = render(<DispatchChip child={makeChild({ subAgentAvatar: undefined })} />);
    // Avatar bot 变体：title 挂 agent 名 + Bot 图标（v2.1 取代 🤖 字形兜底）
    expect(screen.getByTitle('码农')).not.toBeNull();
    expect(container.querySelector('svg.lucide-bot')).not.toBeNull();
    expect(screen.queryByText('🤖')).not.toBeInTheDocument();
  });
});

describe('DispatchChip — 自动展开/折叠默认值', () => {
  it('executing 默认展开（subStream 正文可见）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('failed 默认展开（便于查看错误细节）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'failed' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('completed 默认折叠（subStream 正文不可见）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('queued 默认折叠', () => {
    render(
      <DispatchChip child={makeChild({ status: 'queued' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('aborted 默认折叠（中断非异常，减少视觉噪音）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'aborted' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('展开但未传 subStream 时不渲染 SubAgentSection（不报错）', () => {
    render(<DispatchChip child={makeChild({ status: 'executing' })} />);
    // executing 默认展开，但无 subStream → 正文区域为空
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    // 组件本身仍正常渲染（状态文案存在）
    expect(screen.getByText(/执行中/)).toBeInTheDocument();
  });
});

describe('DispatchChip — 点击 toggle', () => {
  it('completed（折叠）点击后展开', () => {
    render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('executing（展开）点击后折叠', () => {
    render(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('连续点击两次回到原状态', () => {
    render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // 展开
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(btn); // 再折叠
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('DispatchChip — status 变化的自动行为', () => {
  it('未手动 toggle 时，completed → executing 自动展开', () => {
    const { rerender } = render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    rerender(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
  });

  it('未手动 toggle 时，executing → completed 自动折叠', () => {
    const { rerender } = render(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    rerender(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
  });

  it('用户手动折叠后，status 变化不再自动展开（userToggled 抑制）', () => {
    // 初始 executing → 自动展开
    const { rerender } = render(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    // 用户手动折叠
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    // status 变为 failed（自动行为应展开，但用户已手动折叠 → 保持折叠）
    rerender(
      <DispatchChip child={makeChild({ status: 'failed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
  });

  it('用户手动展开后，status 变化不再自动折叠（userToggled 抑制）', () => {
    // 初始 completed → 自动折叠
    const { rerender } = render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    // 用户手动展开
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    // status 变为 queued（自动行为应折叠，但用户已手动展开 → 保持展开）
    rerender(
      <DispatchChip child={makeChild({ status: 'queued' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
  });
});

describe('DispatchChip — 执行中活动提示（子 agent 工作过程可见性）', () => {
  it('executing 且 subStream 末段为 thinking → 头行显示「思考中…」+ 计时', () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'executing' })}
        subStream={makeStream({
          segments: [{ kind: 'thinking', text: '正在分析' }],
        })}
      />,
    );
    expect(screen.getByText(/思考中/)).toBeInTheDocument();
    expect(screen.getByText(ELAPSED_TEXT)).toBeInTheDocument();
  });

  it('executing 且末段为执行中工具 → 头行显示工具名', () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'executing' })}
        subStream={makeStream({
          segments: [
            { kind: 'thinking', text: '想' },
            { kind: 'tool_call', callId: 'c1', toolName: 'write_file', args: {}, result: null, success: null },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('dispatch-activity')).toHaveTextContent('write_file');
  });

  it('executing 且末段为 text → 头行显示「输出中…」', () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'executing' })}
        subStream={makeStream({
          segments: [{ kind: 'text', text: '正在写' }],
        })}
      />,
    );
    expect(screen.getByText(/输出中/)).toBeInTheDocument();
  });

  it('executing 但无 subStream → 头行显示「已派出，等待启动…」（无计时）', () => {
    render(<DispatchChip child={makeChild({ status: 'executing' })} />);
    expect(screen.getByText(/等待启动/)).toBeInTheDocument();
    expect(screen.queryByText(ELAPSED_TEXT)).not.toBeInTheDocument();
  });

  it('completed → 不显示活动提示（状态徽标已足够）', () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'completed' })}
        subStream={makeStream({
          status: 'done',
          segments: [{ kind: 'text', text: '完成输出' }],
        })}
      />,
    );
    expect(screen.queryByText(/思考中|输出中|等待启动/)).not.toBeInTheDocument();
  });
});
