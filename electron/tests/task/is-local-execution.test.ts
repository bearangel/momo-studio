// electron/tests/task/is-local-execution.test.ts
//
// 判定矩阵锁（与 renderer/src/lib/is-local-execution.test.ts 同矩阵——双侧
// 实现共享同一语义契约，漂移即红）。
import { describe, it, expect } from 'vitest';
import { isLocalExecution } from '../../src/main/task/is-local-execution';
import type { TaskRow } from '../../src/main/storage/tasks/repo';

const t = (routing: TaskRow['routing']): Pick<TaskRow, 'routing'> => ({ routing });

describe('isLocalExecution（2026-11-19，与 renderer 同矩阵）', () => {
  it('mode local → 恒本机（含 hub 未配置）', () => {
    expect(isLocalExecution(t({ mode: 'local' }), 'node-a')).toBe(true);
    expect(isLocalExecution(t({ mode: 'local' }), null)).toBe(true);
  });

  it('group/node 目标 == 本节点 → 本机', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-a' }), 'node-a')).toBe(true);
    expect(isLocalExecution(t({ mode: 'group', groupId: 'g', targetNodeId: 'node-a' }), 'node-a')).toBe(true);
  });

  it('目标 != 本节点 → 远端', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-b' }), 'node-a')).toBe(false);
  });

  it('selfNodeId 未知 → 仅 local 判定（远端目标/group 未解析不误判）', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-b' }), null)).toBe(false);
    expect(isLocalExecution(t({ mode: 'group', groupId: 'g' }), 'node-a')).toBe(false);
  });
});
