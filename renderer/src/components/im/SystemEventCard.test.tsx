// renderer/src/components/im/SystemEventCard.test.tsx
//
// 系统事件卡三态（spec §5.3）：结构化回执摘要 / 畸形 body 80 字符降级 /
// 点击展开全文。真实组件渲染（无 store / IPC 依赖，mock 收窄为零）。
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SystemEventCard } from './SystemEventCard';
import type { ImMessage } from '../../ipc/types';

// 按类型最小构造：id/sessionId/sender:'system'/eventType:'m.room.message'/body/
// streamSessionId:null/parentStreamSessionId:null/segmentOf:null/status:'done'/
// taskId:'t-1'/createdAt:0/workspaceId:null（cast 补齐其余可空字段）
const base: ImMessage = {
  id: 'm-sys-1',
  sessionId: 'ses-1',
  sender: 'system',
  eventType: 'm.room.message',
  body: '',
  streamSessionId: null,
  parentStreamSessionId: null,
  segmentOf: null,
  status: 'done',
  taskId: 't-1',
  createdAt: 0,
  workspaceId: null,
} as unknown as ImMessage;

describe('SystemEventCard', () => {
  it('标准回执 body → 结构化摘要行', () => {
    render(<SystemEventCard message={{ ...base, body: '【dispatch 回执自动送达】任务链 t-abc-1（第 2 轮）已完成（工具调用 15 次）。\n--- 回执正文 ---\nok' }} />);
    expect(screen.getByText(/子任务回执 · 已完成 · 第 2 轮 · 工具调用 15 次/)).toBeInTheDocument();
  });
  it('畸形 body → 80 字符纯文本降级（错误路径专项，test 规则 3）', () => {
    render(<SystemEventCard message={{ ...base, body: '随便一段没有结构的长文本'.repeat(20) }} />);
    expect(screen.getByText(/^随便一段没有结构的长文本.{0,}$/)).toBeInTheDocument();
  });
  it('点击摘要展开/收起全文', () => {
    render(<SystemEventCard message={{ ...base, body: '【dispatch 回执自动送达】任务链 t-1（第 1 轮）已完成（工具调用 1 次）。' }} />);
    fireEvent.click(screen.getByRole('button', { name: /子任务回执/ }));
    expect(screen.getByText(/【dispatch 回执自动送达】/)).toBeInTheDocument();
  });
});
