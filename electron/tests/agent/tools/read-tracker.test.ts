// electron/tests/agent/tools/read-tracker.test.ts
// v2.3 Read-before-Edit：维护 streamSession 维度已读取文件集合。
// 子 agent 通过 parentStreamSessionId 判定，永远 fresh（不继承父 agent 已读状态）。

import { describe, it, expect } from 'vitest';
import { ReadTracker } from '../../../src/main/agent/tools/shared/read-tracker';

describe('ReadTracker', () => {
  it('add + has：标记已读后 has 返回 true', () => {
    const t = new ReadTracker();
    expect(t.has('s1', '/a.ts')).toBe(false);
    t.add('s1', '/a.ts');
    expect(t.has('s1', '/a.ts')).toBe(true);
  });

  it('add 不跨 session 共享', () => {
    const t = new ReadTracker();
    t.add('s1', '/a.ts');
    expect(t.has('s2', '/a.ts')).toBe(false);
  });

  it('has 对未 add 的 path 返回 false', () => {
    const t = new ReadTracker();
    expect(t.has('s1', '/b.ts')).toBe(false);
  });

  it('assertRead：未读时抛错，含路径', () => {
    const t = new ReadTracker();
    expect(() => t.assertRead('s1', undefined, '/a.ts')).toThrowError(/a\.ts/);
  });

  it('assertRead：已读时不抛错', () => {
    const t = new ReadTracker();
    t.add('s1', '/a.ts');
    expect(() => t.assertRead('s1', undefined, '/a.ts')).not.toThrow();
  });

  it('assertRead：子 agent（parentStreamSessionId 非空）永远抛错（fresh-session）', () => {
    const t = new ReadTracker();
    t.add('parent', '/a.ts');
    // 即使父 agent 已读，子 agent 仍 fresh
    expect(() => t.assertRead('child', 'parent', '/a.ts')).toThrowError(/a\.ts/);
  });

  it('clear：清理单 session 状态', () => {
    const t = new ReadTracker();
    t.add('s1', '/a.ts');
    t.add('s2', '/b.ts');
    t.clear('s1');
    expect(t.has('s1', '/a.ts')).toBe(false);
    expect(t.has('s2', '/b.ts')).toBe(true); // 不影响其他 session
  });

  it('clear 不存在的 session 不抛错', () => {
    const t = new ReadTracker();
    expect(() => t.clear('not-exists')).not.toThrow();
  });
});