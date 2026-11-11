// renderer/src/components/im/ProgressTimelineCard.test.tsx
//
// 进度折叠卡交互单测：默认折叠摘要 / 展开时间线 / 单条非交互 / 解析失败降级。
// body 一律用与主进程 router-service.maybeEmitProgressSegment 逐字一致的生产模板拼出。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { ProgressTimelineCard } from './ProgressTimelineCard';

/** 生产模板拼 body（与主进程输出逐字对齐，防契约漂移） */
function productionBody(label: string, toolCalls: number, changes: number): string {
  return `【进度分段】子任务 ${label} 进行中 · 工具调用累计 ${toolCalls} 次 · 文件变更累计 ${changes} 处`;
}

/** 构造 ImMessage（复制自 MessageList.test.tsx makeMsg，字段对齐 SQLite row） */
function makeMsg(overrides: Partial<ImMessage> & { id: string }): ImMessage {
  return {
    sessionId: 'sess-room',
    sender: '@bot:server',
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

/** 固定本地时刻（2026-11-11），HH:mm 期望值用字面量独立断言（不复用被测实现） */
const T_09_05 = new Date(2026, 10, 11, 9, 5).getTime(); // 09:05
const T_10_42 = new Date(2026, 10, 11, 10, 42).getTime(); // 10:42
const T_23_00 = new Date(2026, 10, 11, 23, 0).getTime(); // 23:00

function makeProgress(
  overrides: Partial<ImMessage> & { id: string; body: string; createdAt: number },
): ImMessage {
  return makeMsg({ sender: 'system', ...overrides });
}

/** 三条生产模板进度行：时间 / 标签 / 计数互异 */
function threeProgressRows(): ImMessage[] {
  return [
    makeProgress({ id: 'p1', createdAt: T_09_05, body: productionBody('重构登录模块', 3, 1) }),
    makeProgress({ id: 'p2', createdAt: T_10_42, body: productionBody('编写单元测试', 7, 4) }),
    makeProgress({ id: 'p3', createdAt: T_23_00, body: productionBody('性能压测回归', 12, 9) }),
  ];
}

beforeEach(() => {
  // jsdom 未实现 Element.scrollTo（展开区滚动容器可能触发）
  window.HTMLElement.prototype.scrollTo = () => {};
});

describe('ProgressTimelineCard N>1 折叠 / 展开', () => {
  it('默认折叠：显示「进度 · 3 条」与最新行摘要，早期行不可见', () => {
    render(<ProgressTimelineCard messages={threeProgressRows()} />);
    expect(screen.getByText('进度 · 3 条')).toBeInTheDocument();
    // 摘要取最新行（p3）：时间 + 标签 + 工具累计
    expect(screen.getByText(/最新 23:00 · 性能压测回归 工具累计 12 次/)).toBeInTheDocument();
    // 早期行标签不出现（未展开）
    expect(screen.queryByText(/重构登录模块/)).not.toBeInTheDocument();
    expect(screen.queryByText(/编写单元测试/)).not.toBeInTheDocument();
    const head = screen.getByRole('button');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('progress-timeline-card')).toHaveAttribute('data-count', '3');
  });

  it('点击展开 → aria-expanded=true，三条时间线行全可见；再点 → 收起', () => {
    render(<ProgressTimelineCard messages={threeProgressRows()} />);
    const head = screen.getByRole('button');
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    // 每行 = HH:mm + label · 工具 n · 变更 m
    expect(screen.getByText('重构登录模块 · 工具 3 · 变更 1')).toBeInTheDocument();
    expect(screen.getByText('编写单元测试 · 工具 7 · 变更 4')).toBeInTheDocument();
    expect(screen.getByText('性能压测回归 · 工具 12 · 变更 9')).toBeInTheDocument();
    expect(screen.getByText('09:05')).toBeInTheDocument();
    expect(screen.getByText('10:42')).toBeInTheDocument();
    expect(screen.getByText('23:00')).toBeInTheDocument();

    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('重构登录模块 · 工具 3 · 变更 1')).not.toBeInTheDocument();
  });
});

describe('ProgressTimelineCard N=1 单行', () => {
  it('渲染单行内容，无按钮角色 / 无 aria-expanded / 无「条」计数', () => {
    render(
      <ProgressTimelineCard
        messages={[makeProgress({ id: 'only', createdAt: T_10_42, body: productionBody('唯一子任务', 5, 2) })]}
      />,
    );
    expect(screen.getByText(/10:42 · 唯一子任务 进行中 · 工具累计 5 次 · 变更累计 2 处/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-expanded]')).toBeNull();
    expect(screen.queryByText(/条/)).not.toBeInTheDocument();
  });
});

describe('ProgressTimelineCard 解析失败降级', () => {
  it('格式漂移 body → 头部降级原始文本切片，不崩', () => {
    render(
      <ProgressTimelineCard
        messages={[makeProgress({ id: 'drift', createdAt: T_09_05, body: '【进度分段】格式漂移了' })]}
      />,
    );
    expect(screen.getByText('【进度分段】格式漂移了')).toBeInTheDocument();
  });

  it('N>1 且最新行解析失败 → 头部摘要降级 60 字符切片，展开行降级 80 字符切片', () => {
    const longDrift = '【进度分段】' + 'x'.repeat(100);
    render(
      <ProgressTimelineCard
        messages={[
          makeProgress({ id: 'd1', createdAt: T_09_05, body: productionBody('正常行', 1, 1) }),
          makeProgress({ id: 'd2', createdAt: T_10_42, body: longDrift }),
        ]}
      />,
    );
    // 头部摘要：最新行原始 body 前 60 字符（前缀 6 + x×54）
    expect(screen.getByText(/最新 10:42 · 【进度分段】x{54}/)).toBeInTheDocument();
    // 展开后：漂移行降级 80 字符切片（前缀 6 + x×74），正常行不受拖累
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('【进度分段】' + 'x'.repeat(74))).toBeInTheDocument();
    expect(screen.getByText('正常行 · 工具 1 · 变更 1')).toBeInTheDocument();
  });
});
