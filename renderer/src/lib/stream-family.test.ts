import { describe, expect, it } from 'vitest';
import { baseSsi, countFamilyToolCalls } from './stream-family';
import type { ImMessage } from '../ipc/types';

const mk = (id: string, ssi: string | null, parent: string | null, seg: string | null = null): ImMessage =>
  ({ id, sessionId: 's', sender: 'agent-a', eventType: 'm.room.message', body: '', streamSessionId: ssi, parentStreamSessionId: parent, segmentOf: seg, status: 'done', taskId: null, createdAt: 0, workspaceId: null }) as unknown as ImMessage;
const streams = (entries: Array<[string, number]>) => new Map(entries.map(([id, n]) => [id, { toolCalls: new Array(n) }]));

describe('countFamilyToolCalls（spec §8.1 口径）', () => {
  it('own = base ssi 全族（含 roll 行）toolCalls 之和——roll 不归零', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('a2', 'ssi-1#roll1', null)];
    expect(countFamilyToolCalls(msgs, streams([['a1', 95], ['a2', 76]]), 'ssi-1').own).toBe(171);
  });
  it('sub = 直接子链行之和；子链无 streams 条目按 0 计不抛错', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('c1', 'ssi-sub', 'ssi-1'), mk('c2', 'ssi-sub2', 'ssi-1#roll1')];
    const r = countFamilyToolCalls(msgs, streams([['a1', 10], ['c1', 32]]), 'ssi-1');
    expect(r.sub).toBe(32); // c2 无条目 → 0
  });
  it('#seg 分段行排除（事件挂父行，防双计）', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('seg1', 'ssi-1#seg1', null, 'a1')];
    expect(countFamilyToolCalls(msgs, streams([['a1', 8], ['seg1', 99]]), 'ssi-1').own).toBe(8);
  });
  it('孙代（parent=子流）不计入 PM 子链', () => {
    const msgs = [mk('a1', 'ssi-1', null), mk('c1', 'ssi-sub', 'ssi-1'), mk('g1', 'ssi-gc', 'ssi-sub')];
    expect(countFamilyToolCalls(msgs, streams([['a1', 4], ['c1', 5], ['g1', 6]]), 'ssi-1').sub).toBe(5);
  });
});
describe('baseSsi', () => { it('剥 # 后缀', () => { expect(baseSsi('ssi-1#roll2')).toBe('ssi-1'); }); });
