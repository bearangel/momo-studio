// electron/src/main/agent/tools/catalog-entry.ts
// 目录条目类型 + 模块内构造 helper（v2.x 目录自描述，spec §4.2）。
// 独立小文件不 import 任何模块——避免 catalog.ts ↔ 模块 循环依赖。

import type { LLMToolDef } from '../llm-provider';

/** 目录条目：IPC tools:getCatalog 的载荷单元，renderer 据此渲染分组勾选 */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  categoryEmoji: string;
  /** Tier 1 公共默认集 = true（创建时默认勾选，可取消） */
  defaultOn: boolean;
  /** 高危组 UI 提示文案（可选） */
  riskNote?: string;
  /** 条件可用说明（LSP：仅 TS/JS workspace 注册） */
  conditional?: string;
}

/** per-tool 元数据（name/description 从 DEFS 取，不重复） */
export type ToolMeta = Omit<ToolCatalogEntry, 'name' | 'description'>;

/**
 * 按名字表把模块 DEFS 映射为目录条目。缺 meta 直接抛错——fail-fast，
 * 防止「新模块注册了工具但目录漏项」的静默漂移（Task 3 完备性测试双保险）。
 */
export function buildCatalog(
  defs: LLMToolDef[],
  metaByTool: Record<string, ToolMeta>,
): ToolCatalogEntry[] {
  return defs.map((d) => {
    const meta = metaByTool[d.name];
    if (!meta) {
      throw new Error(`工具 ${d.name} 缺少目录元数据（getCatalog meta 表漏项）`);
    }
    return { name: d.name, description: d.description, ...meta };
  });
}
