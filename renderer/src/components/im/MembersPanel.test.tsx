// renderer/src/components/im/MembersPanel.test.tsx
// MembersPanel 成员列表测试（v2.0 P1 Task 9：成员语义 SessionMemberInfo）：
//   - 在线/离线 badge 直接读 lastRunning（不再反查 assignments）
//   - leader 成员显示 Leader 徽标（isLeader；v2.1 P2 Task 13 👑 emoji 改 lucide-react Crown）
//   - 成员图标与名称来自三表 JOIN（iconEmoji / agentName）
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionMemberInfo } from '../../ipc/types';

vi.mock('../../stores/session.store', () => ({
  useSessionStore: vi.fn((selector?: (s: { members: SessionMemberInfo[] }) => unknown) => {
    const state = { members: mockMembers };
    return selector ? selector(state) : state;
  }),
}));

import { MembersPanel } from './MembersPanel';

const mockMembers: SessionMemberInfo[] = [
  { instanceId: 'inst-online', agentName: '在线Agent', iconEmoji: '🤖', lastRunning: true, isLeader: false },
  { instanceId: 'inst-offline', agentName: '离线Agent', iconEmoji: '🧑‍💻', lastRunning: false, isLeader: false },
  { instanceId: 'inst-coord', agentName: '协调Agent', iconEmoji: '🦸', lastRunning: true, isLeader: true },
];

describe('MembersPanel 在线/离线标签', () => {
  it('运行中的成员显示"在线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('在线Agent')).toBeInTheDocument();
    // 在线Agent 与 协调Agent 都 lastRunning=true → 两个「在线」badge
    expect(screen.getAllByText('在线')).toHaveLength(2);
  });

  it('已停止的成员显示"离线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('离线Agent')).toBeInTheDocument();
    expect(screen.getAllByText('离线')).toHaveLength(1);
  });

  it('leader 成员（isLeader）显示 Leader 徽标（v2.1：lucide-react Crown 替代 👑 emoji）', () => {
    render(<MembersPanel />);
    expect(screen.getByText('协调Agent')).toBeInTheDocument();
    // v2.1 P2 Task 13：👑 emoji → lucide-react Crown SVG；徽标文案仅 "Leader"
    expect(screen.getByTestId('leader-badge')).toBeInTheDocument();
    expect(screen.getByText('Leader')).toBeInTheDocument();
  });

  it('成员图标使用 iconEmoji（空值回退 Bot 图标）', () => {
    render(<MembersPanel />);
    expect(screen.getByText('🧑‍💻')).toBeInTheDocument();
    expect(screen.getByText('🦸')).toBeInTheDocument();
  });

  it('显示成员数量标题', () => {
    render(<MembersPanel />);
    expect(screen.getByText(/成员（3）/)).toBeInTheDocument();
  });

  it('浮层定位为 absolute right-0（覆盖模式）', () => {
    const { container } = render(<MembersPanel />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('absolute');
    expect(aside?.className).toContain('right-0');
    expect(aside?.className).toContain('z-30');
  });
});
