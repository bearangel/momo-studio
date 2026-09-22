// renderer/src/lib/resource-helpers.test.ts
// renderer 端 sourceLabel 契约锁——与 electron 端 resource/types.ts 的 SOURCE_LABELS
// 保持文案一致（builtin=系统预置 / custom=我的上传 / marketplace=网络资源 /
// p2p=P2P 共享 / smithery=Smithery / modelscope=魔搭社区）。
// 通过导出函数 sourceLabel 逐源断言，锁住「行为面」——不再依赖注释或内部表的手抄断言。
import { describe, it, expect } from 'vitest';
import { sourceLabel } from './resource-helpers';
import type { ResourceSource } from '../ipc/types';

const ALL_SOURCES: ReadonlyArray<{ source: ResourceSource; label: string }> = [
  { source: 'builtin', label: '系统预置' },
  { source: 'custom', label: '我的上传' },
  { source: 'marketplace', label: '网络资源' },
  { source: 'p2p', label: 'P2P 共享' },
  { source: 'smithery', label: 'Smithery' },
  { source: 'modelscope', label: '魔搭社区' },
];

describe('sourceLabel', () => {
  it.each(ALL_SOURCES)('$source → $label', ({ source, label }) => {
    expect(sourceLabel(source)).toBe(label);
  });

  it('六源全部覆盖——与 ResourceSource 类型枚举一一对应', () => {
    const enumerated: ResourceSource[] = [
      'builtin',
      'custom',
      'marketplace',
      'p2p',
      'smithery',
      'modelscope',
    ];
    expect(ALL_SOURCES.map((s) => s.source).sort()).toEqual(enumerated.sort());
  });
});