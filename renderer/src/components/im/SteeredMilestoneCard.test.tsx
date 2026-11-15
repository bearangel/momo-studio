// renderer/src/components/im/SteeredMilestoneCard.test.tsx
//
// 已下发指令里程碑卡测试（P3 S3，CONTRACT #17）：
// 1. delegation_milestone + kind='steered' → 蓝调卡（已下发指令 + steered 徽标 +
//    摘要引用块 ≤80 字）；MessageBubble system 行路由到本卡
// 2. meta.message 缺席/畸形 → body 80 字切片降级（不崩不空白）
// 3. 非 steered kind（accepted / remote_intervention …）与损坏 contextJson →
//    不进本卡（回落 SystemEventCard 通用形态）
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { SteeredMilestoneCard, parseSteeredSummary } from './SteeredMilestoneCard';
import type { ImMessage } from '../../ipc/types';

function steeredMessage(patch: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm1', sessionId: 's1', sender: 'system', body: '已下发指令：覆盖 seeds 表',
    eventType: 'delegation_milestone', streamSessionId: null, parentStreamSessionId: null,
    segmentOf: null, segmentIndex: null, status: 'done', source: 'local', workspaceId: null,
    taskId: 'T-1042', contextJson: JSON.stringify({ kind: 'steered', message: '覆盖 seeds 表' }),
    createdAt: 1_763_200_000_000, updatedAt: 1_763_200_000_000,
    ...patch,
  };
}

describe('parseSteeredSummary', () => {
  it('kind=steered → meta.message 摘要', () => {
    expect(parseSteeredSummary(steeredMessage())).toBe('覆盖 seeds 表');
  });

  it('meta.message 缺席 → body 80 字切片降级；非 steered / 损坏 JSON / 异 eventType → null', () => {
    expect(parseSteeredSummary(steeredMessage({ contextJson: JSON.stringify({ kind: 'steered' }) })))
      .toBe('已下发指令：覆盖 seeds 表');
    expect(parseSteeredSummary(steeredMessage({ contextJson: JSON.stringify({ kind: 'accepted' }) }))).toBeNull();
    expect(parseSteeredSummary(steeredMessage({ contextJson: 'not-json' }))).toBeNull();
    expect(parseSteeredSummary(steeredMessage({ eventType: 'm.room.message', contextJson: null }))).toBeNull();
  });
});

describe('SteeredMilestoneCard 蓝调卡（CONTRACT #17）', () => {
  it('已下发指令 + steered 徽标 + 摘要引用块 + 时间', () => {
    render(<SteeredMilestoneCard message={steeredMessage()} />);
    const card = screen.getByTestId('steered-milestone-card');
    expect(card).toHaveTextContent('已下发指令');
    expect(card).toHaveTextContent('steered');
    expect(card).toHaveTextContent('覆盖 seeds 表');
    expect(card).toHaveTextContent('指令经 hub task.steer 送达');
    // 蓝调：accent 边框着色（区别 success/warning 系统卡）
    expect(card.className).toContain('border-accent-500/40');
    expect(card.className).toContain('bg-accent-500/10');
  });

  it('摘要超 80 字由生产侧截断——卡面直显 meta.message（≤80 字合同）', () => {
    const summary = '甲'.repeat(80);
    render(<SteeredMilestoneCard message={steeredMessage({
      contextJson: JSON.stringify({ kind: 'steered', message: summary }),
    })} />);
    expect(screen.getByText(summary)).toBeInTheDocument();
  });
});

describe('MessageBubble 路由', () => {
  it("system + delegation_milestone + kind='steered' → 蓝调卡（先于 SystemEventCard）", () => {
    render(<MessageBubble message={steeredMessage()} isSelf={false} />);
    expect(screen.getByTestId('steered-milestone-card')).toBeInTheDocument();
  });

  it('system 其他 milestone kind → 通用系统卡兜底', () => {
    render(
      <MessageBubble
        message={steeredMessage({ contextJson: JSON.stringify({ kind: 'accepted' }) })}
        isSelf={false}
      />,
    );
    expect(screen.queryByTestId('steered-milestone-card')).not.toBeInTheDocument();
  });
});
