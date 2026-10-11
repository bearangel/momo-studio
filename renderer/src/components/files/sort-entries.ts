// renderer/src/components/files/sort-entries.ts
//
// 文件区条目排序（功能优化 2026-10-11）：目录在前、文件在后；组内名称自然排序。
// FileTreeView（目录树渲染）与 FileTree（搜索结果）共用；纯函数、不 mutate 入参。
import type { DirEntry, SearchHit } from '../../ipc/types';

/**
 * 组内名称比较：自然排序（数字段按数值，foo2 < foo10）+ 大小写不敏感。
 * localeCompare 平手时（仅大小写差异）按码元序 tiebreak，保证全平台确定性。
 */
function compareName(a: string, b: string): number {
  const byLocale = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (byLocale !== 0) return byLocale;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 目录优先 → 名称自然排序（DirEntry 列表，渲染前调用） */
export function sortDirEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || compareName(a.name, b.name),
  );
}

/** 搜索命中（扁平相对路径）同规则排序：目录在前 → 路径自然排序 */
export function sortSearchHits(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || compareName(a.path, b.path),
  );
}
