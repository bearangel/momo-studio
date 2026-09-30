// renderer/src/components/im/CompactNotice.test.tsx
//
// CompactNotice 契约 + 渲染测试：
//   - splitCompactBody 文本协议（与主进程 session-service.ts 生产侧成对锁：
//     body = 「统计行 \n\n 摘要正文」——本测试按生产者的真实拼装方式构造输入）
//   - 防御性降级：无空行（LAN 镜像广播行）/ 空行后无内容 → 整体当统计行，
//     不渲染折叠开关
//   - 渲染：默认折叠、点击展开显示摘要、居中通知不归属对话角色
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { CompactNotice, splitCompactBody } from './CompactNotice';

/** 按主进程 handleSessionCommand 的真实拼装方式构造 body（生产→消费契约） */
function producerBody(historyCount: number, summary: string): string {
  return `已压缩 ${historyCount} 条历史消息（摘要自下轮生效）\n\n${summary}`;
}

function makeMessage(body: string): ImMessage {
  return {
    id: 'm-1',
    sessionId: 's1',
    sender: 'owner',
    body,
    eventType: 'io.momo-studio.compact',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: 'w1',
    taskId: null,
    contextJson: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe('splitCompactBody 文本协议', () => {
  it('生产者真实拼装 → 首行统计行 / 空行后摘要全文（摘要含空行不误切）', () => {
    const { title, summary } = splitCompactBody(producerBody(6, '第一段\n\n第二段（摘要内部空行）'));
    expect(title).toBe('已压缩 6 条历史消息（摘要自下轮生效）');
    expect(summary).toBe('第一段\n\n第二段（摘要内部空行）');
  });

  it('无空行（LAN 镜像广播行）→ 整体当统计行、无折叠区', () => {
    const { title, summary } = splitCompactBody('已压缩 3 条历史消息（摘要自下轮生效）');
    expect(title).toBe('已压缩 3 条历史消息（摘要自下轮生效）');
    expect(summary).toBeNull();
  });

  it('空行后仅空白 → 视为无摘要（null，不渲染折叠区）', () => {
    const { title, summary } = splitCompactBody('统计行\n\n  \n');
    expect(title).toBe('统计行');
    expect(summary).toBeNull();
  });

  it('空 body → 空 title、无摘要（异常数据不崩）', () => {
    expect(splitCompactBody('')).toEqual({ title: '', summary: null });
  });
});

describe('CompactNotice 渲染', () => {
  it('默认折叠：显示统计行 + 展开开关；摘要区不渲染', () => {
    render(<CompactNotice message={makeMessage(producerBody(6, '摘要内容甲'))} />);
    expect(screen.getByTestId('compact-notice')).toHaveTextContent('已压缩 6 条历史消息（摘要自下轮生效）');
    expect(screen.getByTestId('compact-summary-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('compact-summary')).toBeNull();
  });

  it('点击展开 → 摘要正文渲染；再点收起', () => {
    render(<CompactNotice message={makeMessage(producerBody(6, '摘要内容甲'))} />);
    fireEvent.click(screen.getByTestId('compact-summary-toggle'));
    expect(screen.getByTestId('compact-summary')).toHaveTextContent('摘要内容甲');
    fireEvent.click(screen.getByTestId('compact-summary-toggle'));
    expect(screen.queryByTestId('compact-summary')).toBeNull();
  });

  it('无摘要（LAN 镜像行）→ 无折叠开关', () => {
    render(<CompactNotice message={makeMessage('已压缩 3 条历史消息（摘要自下轮生效）')} />);
    expect(screen.getByTestId('compact-notice')).toHaveTextContent('已压缩 3 条历史消息');
    expect(screen.queryByTestId('compact-summary-toggle')).toBeNull();
  });
});
