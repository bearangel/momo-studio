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
//   - B5 链级停止按钮：isBusy（executing/queued）渲染；点击 →
//     ipc.dispatch.cancelChain({ subStreamSessionId })；stopPropagation 防误触
//     chip 展开；not_found → toast『子任务已结束』（cancelled 不弹）
//
// v2.1：emoji 字形 / inline hex 断言退役，按 tone class + lucide svg 语义断言。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { StreamState } from '../../stores/stream.store';
import { Toast, dismissToast } from '../ui/Toast';
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

// B5 停止按钮走 ipc 边界 mock（BubbleToolbar 同款：换 window.api，经真实 ipc Proxy）
const cancelChainMock = vi.fn();
const mockApi = { dispatch: { cancelChain: cancelChainMock } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 头行 chip 本体按钮：isBusy 态下 DOM 另有停止按钮，getByRole('button') 会命中
 *  多个——头行是唯一带 aria-expanded 的 button，按该属性精确定位 */
function getHeaderButton(): HTMLElement {
  const btn = document.querySelector<HTMLElement>('[role=button][aria-expanded]');
  if (!btn) throw new Error('头行按钮未渲染（[role=button][aria-expanded]）');
  return btn;
}

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
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('failed 默认展开（便于查看错误细节）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'failed' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('completed 默认折叠（subStream 正文不可见）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('queued 默认折叠', () => {
    render(
      <DispatchChip child={makeChild({ status: 'queued' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('aborted 默认折叠（中断非异常，减少视觉噪音）', () => {
    render(
      <DispatchChip child={makeChild({ status: 'aborted' })} subStream={makeStream()} />,
    );
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'false');
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
    fireEvent.click(getHeaderButton());
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('executing（展开）点击后折叠', () => {
    render(
      <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />,
    );
    expect(screen.getByText('子任务输出文本')).toBeInTheDocument();
    fireEvent.click(getHeaderButton());
    expect(screen.queryByText('子任务输出文本')).not.toBeInTheDocument();
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('连续点击两次回到原状态', () => {
    render(
      <DispatchChip child={makeChild({ status: 'completed' })} subStream={makeStream()} />,
    );
    const btn = getHeaderButton();
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
    fireEvent.click(getHeaderButton());
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
    fireEvent.click(getHeaderButton());
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
    // v2.1：展开的 SubAgentSection 内 ThinkingSection 流式态标签也是「思考中…」，
    // 与头行提示重名——按 dispatch-activity testid 锁头行提示本身
    expect(screen.getByTestId('dispatch-activity')).toHaveTextContent('思考中');
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

// === 委派区背景区分（2026-09-06 UI 修复） ===
// 根因：头行底色 surface-2 与所在 agent 气泡（surface-2）相同，同色叠同色
// 只剩边框可辨。契约：头行改紫色语义 tint（dispatch=紫，与 DispatchCard 同源）。
describe('DispatchChip — 委派区紫色语义底', () => {
  it('头行使用 bg-status-violet-tint + border-strong（与气泡底色区分）', () => {
    render(<DispatchChip child={makeChild({ status: 'completed' })} />);
    const header = getHeaderButton();
    expect(header).toHaveClass('bg-status-violet-tint');
    expect(header).toHaveClass('border-strong');
    expect(header).not.toHaveClass('bg-surface-2');
  });
});

// === B5：链级停止按钮（spec 2026-10-13 §7.6——cancelChain by subStreamSessionId） ===
describe('DispatchChip — 链级停止按钮', () => {
  beforeEach(() => {
    cancelChainMock.mockReset();
    cancelChainMock.mockResolvedValue({ status: 'cancelled' });
    dismissToast(); // Toast 模块级单例复位，防跨用例串扰
  });

  it('executing 渲染停止按钮（aria-label 含子 agent 名）', () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'executing', subAgentName: '研究员' })}
        subStream={makeStream()}
      />,
    );
    expect(screen.getByRole('button', { name: '停止 研究员 的子任务' })).toBeInTheDocument();
  });

  it('queued（isBusy）也渲染停止按钮', () => {
    render(<DispatchChip child={makeChild({ status: 'queued' })} />);
    expect(screen.getByRole('button', { name: '停止 码农 的子任务' })).toBeInTheDocument();
  });

  it.each(['completed', 'failed', 'aborted', 'delegated'] as const)(
    '%s（非 isBusy）不渲染停止按钮',
    (status) => {
      render(<DispatchChip child={makeChild({ status })} subStream={makeStream()} />);
      expect(screen.queryByRole('button', { name: /停止 .+ 的子任务/ })).not.toBeInTheDocument();
    },
  );

  it('点击停止按钮 → cancelChain({ subStreamSessionId })，且不误触 chip 展开（stopPropagation）', async () => {
    render(
      <DispatchChip
        child={makeChild({ status: 'executing', subStreamSessionId: 'sub-stream-9' })}
        subStream={makeStream()}
      />,
    );
    // executing 默认展开——若 stopPropagation 缺失，点击会被外层 handleToggle 折叠
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '停止 码农 的子任务' }));
    await waitFor(() =>
      expect(cancelChainMock).toHaveBeenCalledWith({ subStreamSessionId: 'sub-stream-9' }),
    );
    expect(getHeaderButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('cancelChain 返回 not_found → toast『子任务已结束』', async () => {
    cancelChainMock.mockResolvedValue({ status: 'not_found' });
    render(
      <>
        <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />
        <Toast />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '停止 码农 的子任务' }));
    await waitFor(() =>
      expect(screen.getByTestId('ui-toast')).toHaveTextContent('子任务已结束'),
    );
  });

  it('cancelChain 返回 cancelled → 不弹 toast', async () => {
    render(
      <>
        <DispatchChip child={makeChild({ status: 'executing' })} subStream={makeStream()} />
        <Toast />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '停止 码农 的子任务' }));
    await waitFor(() => expect(cancelChainMock).toHaveBeenCalledTimes(1));
    // 冲刷 async onClick 的微任务链（mockResolvedValue 已决，宏任务边界后判定分支必已执行）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('ui-toast')).not.toBeInTheDocument();
  });
});
