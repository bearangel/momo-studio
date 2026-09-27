// electron/tests/task/board-columns-sync.test.ts
//
// 镜像同步锁(controller 裁决):electron 主进程不能跨 workspace import renderer
// 源码(tsconfig rootDir=src 会 TS6059),故 electron/src/main/task/board-columns.ts
// 是 renderer/src/ipc/board-columns.ts 的复制镜像。本测试同时 import 两侧文件,
// 逐导出断言等值——改任一份不同步改另一份,这里立刻红。
// 注:跨 workspace import 仅在本测试内合法(vitest esbuild 无 rootDir 约束;
// electron tsconfig include 只有 src/**/*,本目录不经 tsc)。
import { describe, it, expect } from 'vitest';
import * as mirror from '../../src/main/task/board-columns';
import * as source from '../../../renderer/src/ipc/board-columns';
import type { TaskStatus } from '../../src/main/storage/tasks/state-machine';

const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'assigned',
  'session_queued',
  'in_progress',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

describe('board-columns 镜像同步(electron ↔ renderer)', () => {
  it('BOARD_COLUMN_KEYS 逐值相等', () => {
    expect(mirror.BOARD_COLUMN_KEYS).toEqual(source.BOARD_COLUMN_KEYS);
  });

  it('BOARD_COLUMNS 全列定义深度相等(key/label/statuses/hint)', () => {
    expect(mirror.BOARD_COLUMNS).toEqual(source.BOARD_COLUMNS);
  });

  it('columnOf 九状态归列一致', () => {
    for (const s of ALL_STATUSES) {
      expect(mirror.columnOf(s)).toBe(source.columnOf(s));
    }
  });

  it('columnOf 未知状态双双抛错(错误路径)', () => {
    expect(() => mirror.columnOf('bogus' as TaskStatus)).toThrow();
    expect(() => source.columnOf('bogus' as TaskStatus)).toThrow();
  });

  it('canDropIntoColumn 9×5 全矩阵一致', () => {
    for (const from of ALL_STATUSES) {
      for (const to of source.BOARD_COLUMN_KEYS) {
        expect(mirror.canDropIntoColumn(from, to)).toBe(source.canDropIntoColumn(from, to));
      }
    }
  });
});
