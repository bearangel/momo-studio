// renderer/src/lib/turn-segment.test.ts
//
// latestTurn 界定规则测试：owner 锚点 + 其后 agent 行、多组取最后、
// #roll/#seg 后缀归一、纯 agent 会话 / 空列表边界。
import { describe, it, expect } from 'vitest';
import type { ImMessage } from '../ipc/types';
import { latestTurn } from './turn-segment';

function msg(overrides: Partial<ImMessage> & Pick<ImMessage, 'id' | 'sender'>): ImMessage {
  return {
    sessionId: 'ses-1',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: 'ws-1',
    taskId: null,
    contextJson: null,
    createdAt: 1757000000000,
    updatedAt: 1757000000000,
    ...overrides,
  };
}

describe('latestTurn — 组界定', () => {
  it('一组：owner 锚点 + 其后 agent 行（含子 agent 嵌套流）', () => {
    const msgs = [
      msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
      msg({ id: 'a1', sender: 'agent-pm', streamSessionId: 's-pm', createdAt: 2 }),
      msg({ id: 'a2', sender: 'agent-sub', streamSessionId: 's-sub', parentStreamSessionId: 's-pm', createdAt: 3 }),
    ];
    const turn = latestTurn(msgs)!;
    expect(turn.ownerMessageId).toBe('u1');
    expect(turn.messageIds).toEqual(['u1', 'a1', 'a2']);
    expect(turn.streamIds.sort()).toEqual(['s-pm', 's-sub'].sort());
  });

  it('多组取最后一组：更早组不混入', () => {
    const msgs = [
      msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
      msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's1', createdAt: 2 }),
      msg({ id: 'u2', sender: 'owner', createdAt: 3 }),
      msg({ id: 'a2', sender: 'agent-x', streamSessionId: 's2', createdAt: 4 }),
    ];
    const turn = latestTurn(msgs)!;
    expect(turn.ownerMessageId).toBe('u2');
    expect(turn.messageIds).toEqual(['u2', 'a2']);
    expect(turn.streamIds).toEqual(['s2']);
  });

  it('roll/seg 后缀归一到 base ssi（账本匹配面不漏）', () => {
    const msgs = [
      msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
      msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's1', createdAt: 2 }),
      msg({ id: 'a2', sender: 'agent-x', streamSessionId: 's1#roll1', createdAt: 3 }),
      msg({ id: 'a3', sender: 'agent-x', streamSessionId: 's1#seg', segmentOf: 's1', createdAt: 4 }),
    ];
    const turn = latestTurn(msgs)!;
    expect(turn.streamIds).toEqual(['s1']);
    expect(turn.messageIds).toEqual(['u1', 'a1', 'a2', 'a3']);
  });

  it('最后一组是纯提问（agent 未答）→ 仍成组（撤回 = 仅删气泡）', () => {
    const msgs = [
      msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
      msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's1', createdAt: 2 }),
      msg({ id: 'u2', sender: 'owner', createdAt: 3 }),
    ];
    const turn = latestTurn(msgs)!;
    expect(turn.ownerMessageId).toBe('u2');
    expect(turn.messageIds).toEqual(['u2']);
    expect(turn.streamIds).toEqual([]);
  });

  it('边界：空列表与无用户消息（纯 agent）→ null', () => {
    expect(latestTurn([])).toBeNull();
    expect(
      latestTurn([msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's1' })]),
    ).toBeNull();
  });
});
