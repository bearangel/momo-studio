// renderer/src/lib/is-local-execution.test.ts
//
// 判定矩阵锁（与 electron/tests/task/is-local-execution.test.ts 同矩阵——
// 双侧实现共享同一语义契约，漂移即红）。
import { describe, it, expect } from 'vitest';
import { isLocalExecution } from './is-local-execution';
import type { TaskRow } from '../ipc/types';

const t = (routing: TaskRow['routing']): Pick<TaskRow, 'routing'> => ({ routing });

describe('isLocalExecution（2026-11-19 任务会话形态分流键）', () => {
  it('mode local → 恒本机（含 hub 未配置 selfNodeId=null）', () => {
    expect(isLocalExecution(t({ mode: 'local' }), 'node-a')).toBe(true);
    expect(isLocalExecution(t({ mode: 'local' }), null)).toBe(true);
  });

  it('group/node 目标 == 本节点 → 本机（自动调度/指定节点落到自己）', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-a' }), 'node-a')).toBe(true);
    expect(isLocalExecution(t({ mode: 'group', groupId: 'g', targetNodeId: 'node-a' }), 'node-a')).toBe(true);
  });

  it('group/node 目标 != 本节点 → 远端（远程跟踪面板）', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-b' }), 'node-a')).toBe(false);
  });

  it('selfNodeId 未知（hub 未配置）→ 仅 local 判定，远端目标不误判', () => {
    expect(isLocalExecution(t({ mode: 'node', groupId: 'g', targetNodeId: 'node-b' }), null)).toBe(false);
    // group 未解析目标（targetNodeId undefined）同理不判本机
    expect(isLocalExecution(t({ mode: 'group', groupId: 'g' }), 'node-a')).toBe(false);
  });
});
