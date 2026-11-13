// renderer/src/components/AgentOpConfirmCard.test.tsx
//
// 扩权确认卡测试（spec 2026-11-12 §7，P1 预览合同）：
//   - pending null 不渲染；receive → Tier A 居中卡（标题族 / 徽标 / 目标行）
//   - 变体 A：adds only（+ 行 status-success）；变体 B：+ / − 行 + riskNote 高亮
//   - 变体 C：updateProfile → 档案标题 + fieldChanges before 删除线 → after；
//     after-only（主进程构建侧恒省略 before）无箭头无删除线
//   - Tier A：遮罩消费 ui/Dialog 的 OVERLAY_CLASS（关系锁）；点遮罩 / Esc 均不消散
//   - a11y：aria-modal + 挂载后焦点移入卡内（不做 focus trap）
//   - 双按钮 → store.reply → replyAgentOpConfirm；TTL 到点 interval 清扫
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentOpConfirmCard } from './AgentOpConfirmCard';
import { OVERLAY_CLASS } from './ui/Dialog';
import { useAgentOpConfirmStore } from '../stores/agent-op-confirm.store';
import { ipc } from '../ipc/client';
import type { AgentOpConfirmPayload } from '../ipc/types';

vi.mock('../ipc/client', () => ({
  ipc: { agent: { replyAgentOpConfirm: vi.fn(async () => ({ skipped: false })) } },
}));

const replyMock = vi.mocked(ipc.agent.replyAgentOpConfirm);

function payload(overrides?: Partial<AgentOpConfirmPayload>): AgentOpConfirmPayload {
  return {
    requestId: 'req-1',
    workspaceId: 'w1',
    requester: { agentName: 'Momo', op: 'updateCapabilities', toolName: 'update_agent_capabilities' },
    diff: {
      target: { kind: 'member', name: '翻译官', workspaceName: '当前工作空间' },
      scope: 'member',
      adds: [{ field: 'skills', ref: 'weather' }],
      removes: [],
    },
    expiresAt: Date.now() + 10 * 60_000,
    ...overrides,
  };
}

function push(p: AgentOpConfirmPayload): void {
  act(() => {
    useAgentOpConfirmStore.getState().receive(p);
  });
}

beforeEach(() => {
  useAgentOpConfirmStore.getState().__resetForTest();
  replyMock.mockReset();
  replyMock.mockResolvedValue({ skipped: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentOpConfirmCard 显隐与标题族', () => {
  it('pending null 不渲染；receive → 弹卡', () => {
    render(<AgentOpConfirmCard />);
    expect(screen.queryByTestId('agent-op-confirm-card')).not.toBeInTheDocument();
    push(payload());
    expect(screen.getByTestId('agent-op-confirm-card')).toBeInTheDocument();
  });

  it('变体 A：能力标题 + 需确认徽标 + 目标行（member 级）+ meta 双段', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    expect(screen.getByRole('alertdialog', { name: 'Momo 请求变更智能体能力' })).toBeInTheDocument();
    expect(screen.getByText('需确认')).toBeInTheDocument();
    expect(
      screen.getByText('目标：成员「翻译官」 @ 当前工作空间（member 级，仅此实例）'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('确认后自动重启该成员（在途回合结束后生效） · 10 分钟内未处置将自动拒绝'),
    ).toBeInTheDocument();
  });

  it('变体 C：updateProfile → 档案标题；definition 目标行无 @ 工作空间、meta 无重启段', () => {
    render(<AgentOpConfirmCard />);
    push(
      payload({
        requester: { agentName: 'Momo', op: 'updateProfile', toolName: 'update_agent_profile' },
        diff: {
          target: { kind: 'definition', name: '周报助手' },
          adds: [],
          removes: [],
          fieldChanges: [{ field: 'model', before: 'GLM-4.7-Flash', after: 'Claude Sonnet 4.5' }],
        },
      }),
    );
    expect(screen.getByRole('alertdialog', { name: 'Momo 请求编辑智能体档案' })).toBeInTheDocument();
    expect(screen.getByText('目标：定义「周报助手」（definition 级，全部工作空间生效）')).toBeInTheDocument();
    expect(screen.getByText('10 分钟内未处置将自动拒绝')).toBeInTheDocument();
    expect(screen.queryByText(/自动重启该成员/)).not.toBeInTheDocument();
  });

  it('skill / mcp 目标 → 更新技能 / 更新 MCP 标题', () => {
    render(<AgentOpConfirmCard />);
    push(
      payload({
        requester: { agentName: 'weather-skill', op: 'updateSkill', toolName: 'update_skill' },
        diff: { target: { kind: 'skill', name: 'weather' }, adds: [], removes: [] },
      }),
    );
    expect(screen.getByRole('alertdialog', { name: 'weather-skill 请求更新技能' })).toBeInTheDocument();

    push(
      payload({
        requestId: 'req-2',
        requester: { agentName: 'search-mcp', op: 'updateMcp', toolName: 'update_mcp' },
        diff: { target: { kind: 'mcp', name: 'search' }, adds: [], removes: [] },
      }),
    );
    expect(screen.getByRole('alertdialog', { name: 'search-mcp 请求更新 MCP' })).toBeInTheDocument();
  });

  it('目标行 workspaceName 缺席 → 回退「当前工作空间」', () => {
    render(<AgentOpConfirmCard />);
    push(payload({ diff: { ...payload().diff, target: { kind: 'member', name: '翻译官' } } }));
    expect(screen.getByText(/@ 当前工作空间/)).toBeInTheDocument();
  });
});

describe('AgentOpConfirmCard diff 渲染（预览合同定值）', () => {
  it('变体 A：adds only——+ 行 status-success + 字段中文标签', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    expect(screen.getByText('变更内容')).toBeInTheDocument();
    expect(screen.getByText('weather')).toBeInTheDocument();
    const sign = screen.getByText('+');
    expect(sign).toHaveClass('text-status-success');
    expect(sign).toHaveClass('font-bold');
    expect(screen.getByText('技能')).toHaveClass('text-secondary');
  });

  it('变体 B：+ 行 success / − 行 error + riskNote 高亮带', () => {
    render(<AgentOpConfirmCard />);
    push(
      payload({
        diff: {
          target: { kind: 'member', name: '爬虫助手', workspaceName: '产品调研空间' },
          scope: 'member',
          adds: [
            { field: 'tools', ref: 'bash' },
            { field: 'tools', ref: 'browser_navigate' },
          ],
          removes: [{ field: 'tools', ref: 'webfetch' }],
        },
        riskNote: '将授予新工具（扩权）',
      }),
    );
    const signs = screen.getAllByText('+');
    expect(signs).toHaveLength(2);
    for (const s of signs) expect(s).toHaveClass('text-status-success');
    const minus = screen.getByText('−');
    expect(minus).toHaveClass('text-status-error');
    expect(screen.getAllByText('工具')).toHaveLength(3);
    expect(screen.getByText('webfetch')).toBeInTheDocument();
    expect(screen.getByText('将授予新工具（扩权）')).toBeInTheDocument();
  });

  it('变体 C：fieldChanges before 删除线 → after；字段键映射中文标签', () => {
    render(<AgentOpConfirmCard />);
    push(
      payload({
        requester: { agentName: 'Momo', op: 'updateProfile', toolName: 'update_agent_profile' },
        diff: {
          target: { kind: 'definition', name: '周报助手' },
          adds: [],
          removes: [],
          fieldChanges: [
            { field: 'model', before: 'GLM-4.7-Flash', after: 'Claude Sonnet 4.5' },
            { field: 'description', before: '每周五生成周报草稿', after: '每周五生成周报草稿并发送邮件摘要' },
          ],
        },
      }),
    );
    expect(screen.getByText('字段变更')).toBeInTheDocument();
    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getByText('描述')).toBeInTheDocument();
    const old1 = screen.getByText('GLM-4.7-Flash');
    expect(old1).toHaveClass('line-through');
    expect(screen.getAllByText('→')).toHaveLength(2);
    expect(screen.getByText('Claude Sonnet 4.5')).toBeInTheDocument();
    expect(screen.queryByText('变更内容')).not.toBeInTheDocument();
  });

  it('after-only fieldChanges（主进程恒省略 before）→ 无删除线无箭头', () => {
    render(<AgentOpConfirmCard />);
    push(
      payload({
        requester: { agentName: 'Momo', op: 'updateProfile', toolName: 'update_agent_profile' },
        diff: {
          target: { kind: 'definition', name: '周报助手' },
          adds: [],
          removes: [],
          fieldChanges: [{ field: 'model', after: 'glm-4.7 / glm-4.7-flash' }],
        },
      }),
    );
    expect(screen.getByText('glm-4.7 / glm-4.7-flash')).toBeInTheDocument();
    expect(screen.queryByText('→')).not.toBeInTheDocument();
    expect(document.querySelector('.line-through')).toBeNull();
  });

  it('空 diff（adds/removes/fieldChanges 全空）→ 不渲染 diff 框', () => {
    render(<AgentOpConfirmCard />);
    push(payload({ diff: { target: { kind: 'skill', name: 'weather' }, adds: [], removes: [] } }));
    expect(screen.queryByText('变更内容')).not.toBeInTheDocument();
    expect(screen.queryByText('字段变更')).not.toBeInTheDocument();
  });
});

describe('AgentOpConfirmCard Tier A 阻断形态（spec 2026-09-15 §4.2）', () => {
  it('遮罩 class 消费 ui/Dialog 的 OVERLAY_CLASS（关系锁——Dialog 遮罩变更时本卡同源跟随）', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    expect(screen.getByTestId('agent-op-confirm-overlay').className).toBe(OVERLAY_CLASS);
    // 关系锁底线：常量仍是全屏遮罩形态（fixed inset-0 + 遮罩底色），防空串/错串静默通过
    expect(OVERLAY_CLASS).toContain('fixed');
    expect(OVERLAY_CLASS).toContain('inset-0');
  });

  it('a11y：aria-modal + 挂载后焦点移入卡内（T12④——不做 focus trap，BrowserTrustNotice 范式对齐）', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    const card = screen.getByTestId('agent-op-confirm-card');
    expect(card).toHaveAttribute('aria-modal', 'true');
    expect(card).toHaveFocus();
  });

  it('点击遮罩不消散——裁决必须显式', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    fireEvent.click(screen.getByTestId('agent-op-confirm-overlay'));
    expect(screen.getByTestId('agent-op-confirm-card')).toBeInTheDocument();
  });

  it('Esc 不关闭', () => {
    render(<AgentOpConfirmCard />);
    push(payload());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('agent-op-confirm-card')).toBeInTheDocument();
  });
});

describe('AgentOpConfirmCard 回执与超时', () => {
  it('拒绝 → replyAgentOpConfirm(requestId, false) + 卡消散', async () => {
    render(<AgentOpConfirmCard />);
    push(payload({ requestId: 'req-deny' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(replyMock).toHaveBeenCalledWith('req-deny', false));
    await waitFor(() => expect(screen.queryByTestId('agent-op-confirm-card')).not.toBeInTheDocument());
  });

  it('允许 → replyAgentOpConfirm(requestId, true) + 卡消散', async () => {
    render(<AgentOpConfirmCard />);
    push(payload({ requestId: 'req-allow' }));
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => expect(replyMock).toHaveBeenCalledWith('req-allow', true));
    await waitFor(() => expect(screen.queryByTestId('agent-op-confirm-card')).not.toBeInTheDocument());
  });

  it('TTL：expiresAt 到点 interval 清扫（10 分钟超时自动拒绝主进程兜底）', () => {
    vi.useFakeTimers();
    render(<AgentOpConfirmCard />);
    push(payload({ expiresAt: Date.now() + 1500 }));
    expect(screen.getByTestId('agent-op-confirm-card')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId('agent-op-confirm-card')).not.toBeInTheDocument();
  });
});
