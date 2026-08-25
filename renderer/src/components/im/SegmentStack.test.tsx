// renderer/src/components/im/SegmentStack.test.tsx
//
// v1.7.4 Bug 2 测试：SegmentStack 多段纵向堆叠渲染。

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SegmentStack } from './SegmentStack';
import type { SegmentGroup } from './types';
import type { ImMessage } from '../../ipc/types';

// MessageBubble 内部依赖 useStreamStore，提供 mock（需正确应用 selector）
vi.mock('../../stores/stream.store', () => ({
  useStreamStore: (selector: (s: { streams: Map<string, unknown> }) => unknown) =>
    selector({ streams: new Map() }),
}));

import { vi } from 'vitest';

const mkSegMsg = (
  id: string,
  body: string,
  segmentIndex: number,
  segmentOf: string,
): ImMessage => ({
  id,
  sessionId: 'r1',
  sender: '@bot:localhost',
  body,
  eventType: 'm.room.message',
  streamSessionId: null,
  parentStreamSessionId: null,
  segmentOf,
  segmentIndex,
  status: 'done',
  source: 'local',
  workspaceId: null,
  taskId: null,
  createdAt: 100 + segmentIndex * 50,
  updatedAt: 100 + segmentIndex * 50,
});

describe('SegmentStack', () => {
  it('多段消息渲染所有段 + 顶部聚合标签', () => {
    const group: SegmentGroup = {
      kind: 'segment-group',
      streamSessionId: 'sess-1',
      segments: [
        mkSegMsg('e1', '第一段内容', 1, 'sess-1'),
        mkSegMsg('e2', '第二段内容', 2, 'sess-1'),
        mkSegMsg('e3', '第三段内容', 3, 'sess-1'),
      ],
      lastSegmentAt: 250,
    };

    render(<SegmentStack group={group} />);

    expect(screen.getByText('第一段内容')).toBeInTheDocument();
    expect(screen.getByText('第二段内容')).toBeInTheDocument();
    expect(screen.getByText('第三段内容')).toBeInTheDocument();
    expect(screen.getByText(/共 3 段/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 段/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 段/)).toBeInTheDocument();
    expect(screen.getByText(/第 3 段/)).toBeInTheDocument();
  });

  it('多段消息应渲染 segment-stack testid', () => {
    const group: SegmentGroup = {
      kind: 'segment-group',
      streamSessionId: 'sess-2',
      segments: [
        mkSegMsg('e1', '段一', 1, 'sess-2'),
        mkSegMsg('e2', '段二', 2, 'sess-2'),
      ],
      lastSegmentAt: 150,
    };

    const { container } = render(<SegmentStack group={group} />);
    expect(container.querySelector('[data-testid="segment-stack"]')).not.toBeNull();
  });
});
