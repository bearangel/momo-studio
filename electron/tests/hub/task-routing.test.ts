// electron/tests/hub/task-routing.test.ts
//
// M2.1 Task 6：TaskRouting 解析/校验矩阵（plan 契约区逐字）。
// 兜底哲学分两侧（mom-boundary-rules：单模块正确 ≠ 链路正确）：
//   - DB 读侧 parseTaskRouting 永不抛——NULL（旧迁移前行）/非法 JSON/未知 mode/
//     字段异形一律兜底 {mode:'local'}（路由损坏不炸看板，任务永远可本地执行）；
//   - IPC 入参侧 validateTaskRoutingInput 异形人话拒绝——契约违反要响亮，
//     不静默降级（静默 local 会把「想外派」错发本机，错误更晚更贵）。
import { describe, expect, it } from 'vitest';
import {
  isTaskRouting,
  parseTaskRouting,
  serializeTaskRouting,
  validateTaskRoutingInput,
} from '../../src/main/hub/task-routing';

describe('parseTaskRouting：routing_json 列 → TaskRouting（永不抛）', () => {
  it('NULL / undefined → local（迁移 069 前旧行兼容）', () => {
    expect(parseTaskRouting(null)).toEqual({ mode: 'local' });
    expect(parseTaskRouting(undefined)).toEqual({ mode: 'local' });
  });

  it('合法三选一 JSON → 对应形状', () => {
    expect(parseTaskRouting('{"mode":"local"}')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"group","groupId":"g-1"}')).toEqual({
      mode: 'group',
      groupId: 'g-1',
    });
    expect(parseTaskRouting('{"mode":"node","groupId":"g-1","targetNodeId":"n-2"}')).toEqual({
      mode: 'node',
      groupId: 'g-1',
      targetNodeId: 'n-2',
    });
  });

  it('非法 JSON → local 兜底', () => {
    expect(parseTaskRouting('not json')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"group"')).toEqual({ mode: 'local' });
  });

  it('未知 mode / 缺字段 / 字段类型异形 → local 兜底', () => {
    expect(parseTaskRouting('{"mode":"remote"}')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"group"}')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"node","groupId":"g-1"}')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"group","groupId":123}')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('{"mode":"node","groupId":"g","targetNodeId":null}')).toEqual({
      mode: 'local',
    });
    // 顶层非对象
    expect(parseTaskRouting('"local"')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('42')).toEqual({ mode: 'local' });
    expect(parseTaskRouting('null')).toEqual({ mode: 'local' });
  });

  it('未知键容忍且规范化剥除（前向兼容：未来版本附加键不炸旧读取方）', () => {
    expect(parseTaskRouting('{"mode":"group","groupId":"g-1","future":"x"}')).toEqual({
      mode: 'group',
      groupId: 'g-1',
    });
  });
});

describe('serializeTaskRouting：TaskRouting → routing_json（往返一致）', () => {
  it('三形状序列化 → 解析还原 deep equal', () => {
    const shapes = [
      { mode: 'local' },
      { mode: 'group', groupId: 'g-1' },
      { mode: 'node', groupId: 'g-1', targetNodeId: 'n-2' },
    ] as const;
    for (const s of shapes) {
      expect(parseTaskRouting(serializeTaskRouting(s))).toEqual(s);
    }
  });
});

describe('isTaskRouting：类型守卫', () => {
  it('三形状 true；异形 false', () => {
    expect(isTaskRouting({ mode: 'local' })).toBe(true);
    expect(isTaskRouting({ mode: 'group', groupId: 'g' })).toBe(true);
    expect(isTaskRouting({ mode: 'node', groupId: 'g', targetNodeId: 'n' })).toBe(true);
    expect(isTaskRouting(null)).toBe(false);
    expect(isTaskRouting(undefined)).toBe(false);
    expect(isTaskRouting('local')).toBe(false);
    expect(isTaskRouting({ mode: 'remote' })).toBe(false);
    expect(isTaskRouting({ mode: 'group' })).toBe(false);
    expect(isTaskRouting({ mode: 'node', groupId: 'g' })).toBe(false);
    expect(isTaskRouting({ mode: 'group', groupId: 1 })).toBe(false);
  });
});

describe('validateTaskRoutingInput：task.create 入参校验', () => {
  it('undefined → undefined（未指定 = 落列 NULL = 读侧 local 缺省）', () => {
    expect(validateTaskRoutingInput(undefined)).toBeUndefined();
  });

  it('合法三选一 → 规范化返回（未知键剥除）', () => {
    expect(validateTaskRoutingInput({ mode: 'local' })).toEqual({ mode: 'local' });
    expect(validateTaskRoutingInput({ mode: 'group', groupId: 'g-1' })).toEqual({
      mode: 'group',
      groupId: 'g-1',
    });
    expect(
      validateTaskRoutingInput({ mode: 'node', groupId: 'g', targetNodeId: 'n', extra: 1 }),
    ).toEqual({ mode: 'node', groupId: 'g', targetNodeId: 'n' });
  });

  it('异形 → 人话抛错（不静默降级）', () => {
    expect(() => validateTaskRoutingInput({ mode: 'remote' })).toThrow(/routing/i);
    expect(() => validateTaskRoutingInput('local')).toThrow(/routing/i);
    expect(() => validateTaskRoutingInput({ mode: 'group' })).toThrow(/routing/i);
    expect(() => validateTaskRoutingInput(null)).toThrow(/routing/i);
    expect(() => validateTaskRoutingInput(42)).toThrow(/routing/i);
  });
});
