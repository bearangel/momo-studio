// renderer/src/components/im/DispatchChip.test.tsx
//
// DispatchChip 渲染与交互行为测试：
//   - 4 种状态（queued/executing/completed/failed）渲染正确的图标/文案/颜色
//   - 自动展开/折叠默认值（executing/failed 展开；queued/completed 折叠）
//   - 点击头行切换展开/折叠
//   - 展开且传入 subStream 时渲染 SubAgentSection（子 agent 正文可见）
//   - status 变化触发的自动展开/折叠行为
//   - 用户手动 toggle 后抑制后续自动行为（userToggled 标志）
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

/** 构造子 agent StreamState（A 子系统：extends AggregatedStream 字段集） */
function makeStream(overrides: Partial<StreamState> = {}): StreamState {
  return {
    thinking: '',
    text: '子任务输出文本',
    toolCalls: [],
    todos: [],
    dispatches: [],
    status: 'streaming',
    events: [],
    messageId: 'sub-1',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('DispatchChip — 状态渲染', () => {
  it('queued 渲染 ⏳ 排队（灰色 #888）', () => {
    render(<DispatchChip child={makeChild({ status: 'queued' })} />);
    const status = screen.getByText(/排队/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveStyle({ color: '#888' });
  });

  it('executing 渲染 ⏳ 执行中（黄色 #fbbf24）', () => {
    render(<DispatchChip child={makeChild({ status: 'executing' })} />);
    const status = screen.getByText(/执行中/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveStyle({ color: '#fbbf24' });
  });

  it('completed 渲染 ✅ 完成（绿色 #4ade80）', () => {
    render(<DispatchChip child={makeChild({ status: 'completed' })} />);
    const status = screen.getByText(/完成/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveStyle({ color: '#4ade80' });
  });

  it('failed 渲染 ❌ 失败（红色 #f87171）', () => {
    render(<DispatchChip child={makeChild({ status: 'failed' })} />);
    const status = screen.getByText(/失败/);
    expect(status).toBeInTheDocument();
    expect(status).toHaveStyle({ color: '#f87171' });
  });

  it('头行渲染 📤 图标 + avatar + 子 agent 名字', () => {
    render(
      <DispatchChip
        child={makeChild({ subAgentName: '研究员', subAgentAvatar: '🔬' })}
      />,
    );
    // 头像 emoji 和名字都在头行内
    expect(screen.getByText('研究员')).toBeInTheDocument();
    expect(screen.getByText('🔬')).toBeInTheDocument();
  });

  it('subAgentAvatar 缺省时回退 🤖', () => {
    render(<DispatchChip child={makeChild({ subAgentAvatar: undefined })} />);
    expect(screen.getByText('🤖')).toBeInTheDocument();
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
