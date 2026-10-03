// renderer/src/stores/write-grant.store.test.ts
// 通用写授权卡状态（spec 2026-10-03 §5.3/§7）：pending 单卡覆盖去重 + 拒绝记忆。
import { describe, it, expect, beforeEach } from 'vitest';
import { useWriteGrantStore } from './write-grant.store';
import type { WriteBlockedEvent } from '../ipc/types';

const EVT: WriteBlockedEvent = { sessionId: 's-1', workspaceId: 'w-1', dirs: ['/Users/x/.cargo'], command: 'cargo build' };

beforeEach(() => {
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
