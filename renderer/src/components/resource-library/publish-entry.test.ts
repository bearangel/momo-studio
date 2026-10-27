// renderer/src/components/resource-library/publish-entry.test.ts
// canPublishToHub 单点门控矩阵锁（M2.2 Task 2，矩阵落
// .omo/feature-matrices/2026-10-27-m22-publish-entry.md）：source × type × installed
// 全格断言——卡面/详情/引导条三处渲染点共用此判定，此处置零即全线一致。
import { describe, it, expect } from 'vitest';
import { canPublishToHub } from './publish-entry';
import type { ResourceItem } from '../../ipc/types';

type MinimalItem = Pick<ResourceItem, 'type' | 'source' | 'installed'>;

function cell(source: ResourceItem['source'], type: ResourceItem['type'], installed: boolean): MinimalItem {
  return { source, type, installed };
}

const TYPES = ['agent', 'skill', 'mcp', 'plugin'] as const;

describe('canPublishToHub 门控矩阵（M2.2 Task 2）', () => {
  it('custom 四类型恒可发布（M1 Task 14 存量语义零变化）', () => {
    for (const type of TYPES) {
      expect(canPublishToHub(cell('custom', type, true)), `custom/${type}`).toBe(true);
    }
  });

  it('marketplace 源仅 skill 且已装可发布（本次开放的唯一扩面格）', () => {
    for (const type of TYPES) {
      expect(canPublishToHub(cell('marketplace', type, true)), `marketplace/${type}/installed`).toBe(
        type === 'skill',
      );
    }
  });

  it('marketplace 未装一律不可发布（无本地包可打——发布语义=本机已装且愿意分发）', () => {
    for (const type of TYPES) {
      expect(canPublishToHub(cell('marketplace', type, false)), `marketplace/${type}/not-installed`).toBe(false);
    }
  });

  it('builtin / smithery / hub / plugin 源四类型一律不可发布（维持）', () => {
    for (const source of ['builtin', 'smithery', 'hub', 'plugin'] as const) {
      for (const type of TYPES) {
        expect(canPublishToHub(cell(source, type, true)), `${source}/${type}`).toBe(false);
      }
    }
  });
});
