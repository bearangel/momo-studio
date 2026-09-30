// electron/src/main/agent/tools/catalog.ts
// v2.x 起目录常量从注册中心模块派生（单一真相源，spec §4.2）：
//   - 手写清单曾两次漂移（renderer 24 / electron 33 / 运行时 ≈60），
//     模块注册即目录，结构性根除漂移。
//   - 三个导出符号与历史形状兼容（string[] / Array<{label,emoji,tools}>），
//     crud.ts、p2p clamp、marketplace installer 等既有消费者零改动。
// 工具名来源：各模块 getDefs() 的 name 字段（经 getCatalog 自描述聚合）。
import { unconditionalModules } from './index';
import { LSP_CATALOG_ENTRIES } from './lsp-tools';
import type { ToolCatalogEntry } from './catalog-entry';

/** 全部内置工具目录（含 LSP 条目；≈60 个，随模块注册自动扩展） */
export function buildToolCatalog(): ToolCatalogEntry[] {
  return [...unconditionalModules().flatMap((m) => m.getCatalog()), ...LSP_CATALOG_ENTRIES];
}

/** 全部内置工具名全集（派生自 buildToolCatalog，模块注册顺序） */
export const ALL_BUILTIN_TOOLS: string[] = buildToolCatalog().map((e) => e.name);

/**
 * 安全最小集 = Tier 1 公共默认集（spec §3.2，17 个：只读 13 + 文件写 4）。
 * 新建 custom agent 默认勾选；p2p 导入钳制同源派生（天然不含 rm/bash/git 写）。
 */
export const SAFE_MINIMUM_TOOLS: string[] = buildToolCatalog()
  .filter((e) => e.defaultOn)
  .map((e) => e.name);

/** 类别分组（派生：按目录条目首次出现的类别顺序聚合） */
export const TOOL_CATEGORIES: Array<{ label: string; emoji: string; tools: string[] }> = (() => {
  const order: string[] = [];
  const byCat = new Map<string, { label: string; emoji: string; tools: string[] }>();
  for (const e of buildToolCatalog()) {
    let g = byCat.get(e.category);
    if (!g) {
      g = { label: e.category, emoji: e.categoryEmoji, tools: [] };
      byCat.set(e.category, g);
      order.push(e.category);
    }
    g.tools.push(e.name);
  }
  return order.map((c) => byCat.get(c)!);
})();
