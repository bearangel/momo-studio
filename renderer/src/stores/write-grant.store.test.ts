// renderer/src/stores/write-grant.store.test.ts
// 通用写授权卡状态（spec 2026-10-03 §5.3/§7）：pending 单卡覆盖去重 + 拒绝记忆。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWriteGrantStore } from './write-grant.store';
import type { WriteBlockedEvent } from '../ipc/types';

const EVT: WriteBlockedEvent = { sessionId: 's-1', workspaceId: 'w-1', dirs: ['/Users/x/.cargo'], command: 'cargo build', streamSessionId: 'ss-1', sourceAgentName: 'coder', sessionTitle: '调试会话' };

beforeEach(() => {
  vi.useFakeTimers();
  useWriteGrantStore.getState().__resetForTest();
});

describe('write-grant.store（spec §5.3/§7）', () => {
  it('receive 置 pending；同 dirs 重复事件覆盖为最新（事件风暴单卡）', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, command: 'cargo run' });
    const p = useWriteGrantStore.getState().pending;
    expect(p?.command).toBe('cargo run');
    expect(p).toBe(useWriteGrantStore.getState().pending);
  });

  it('denyPending 记忆同会话同 dirs：后续同 dirs 事件不再置 pending', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().denyPending();
    expect(useWriteGrantStore.getState().pending).toBeNull();
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).toBeNull(); // 拒绝记忆压下
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, dirs: ['/other'] });
    expect(useWriteGrantStore.getState().pending).not.toBeNull(); // 不同 dirs 仍弹
  });

  it('resolvePending 清 pending 不记忆（授权成功路径）', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().resolvePending();
    expect(useWriteGrantStore.getState().pending).toBeNull();
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).not.toBeNull();
  });
});

// === 2026-10-14 后台链授权卡死根因修复（F1/F2/F3）===
// 真机实录：空 dirs 卡被拒 → `'∅|'` 通配记忆键 → 后续提取失败拦截全部静默 →
// 子链 waitForWriteGrant 无限等 13 分钟靠手动 cancelChain 救援。
describe('write-grant.store 根因修复（F1/F2/F3）', () => {
  it('F1：空 dirs 事件拒绝后不进记忆——再次上报重新弹卡', () => {
    const empty = { ...EVT, dirs: [] as string[], sessionId: null, streamSessionId: 'ss-empty' };
    useWriteGrantStore.getState().receiveWriteBlocked(empty);
    useWriteGrantStore.getState().denyPending();
    useWriteGrantStore.getState().receiveWriteBlocked(empty);
    // 修复前：pending 被通配键 '∅|' 压下（卡死根因）；修复后重新弹卡
    expect(useWriteGrantStore.getState().pending).not.toBeNull();
  });

  it('F2：有明确 dirs 的拒绝记忆带 TTL——5 分钟内压下（防风暴），过期可再弹', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().denyPending();
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).toBeNull(); // TTL 内：防事件风暴
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).not.toBeNull(); // 过期：用户态度可变
  });

  it('F3：waitingByStream 按流登记等待；deny/resolve/clearWaiting 清除对应流', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().waitingByStream.get('ss-1')?.event.command).toBe('cargo build');
    useWriteGrantStore.getState().denyPending();
    expect(useWriteGrantStore.getState().waitingByStream.has('ss-1')).toBe(false);

    // clearWaiting 段换 dirs（F2：上段 denyPending 的记忆在 TTL 内会压制同键重放——
    // 该压制本身是新预期行为，此处用不同 dirs 隔离 clearWaiting 语义）
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, dirs: ['/other'], streamSessionId: 'ss-1' });
    useWriteGrantStore.getState().clearWaiting('ss-1');
    expect(useWriteGrantStore.getState().waitingByStream.has('ss-1')).toBe(false);
    // clearWaiting 不清 pending（行内处置后卡仍在——用户可能改主意再处置卡）
    expect(useWriteGrantStore.getState().pending).not.toBeNull();
  });

  it('F3：streamSessionId null 的事件不进等待位图（防御）', () => {
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, streamSessionId: null });
    expect(useWriteGrantStore.getState().waitingByStream.size).toBe(0);
  });
});
