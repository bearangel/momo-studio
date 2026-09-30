// renderer/src/lib/useToolCatalog.ts
// 工具目录 hook（v2.x 单一真相源，spec §4.3）：数据来自 IPC tools:getCatalog，
// 模块级缓存 + 单飞去重——多组件共享一次请求。失败置 error 不抛出，
// 消费方（能力配置区）降级为错误提示，不阻塞表单其余字段。
import { useEffect, useState } from 'react';
import { ipc } from '../ipc/client';
import type { ToolCatalogEntry } from '../ipc/types';

export interface ToolCatalogGroup {
  label: string;
  emoji: string;
  tools: string[];
}

export interface ToolCatalogData {
  entries: ToolCatalogEntry[];
  categories: ToolCatalogGroup[];
  safeMinimum: string[];
  allTools: string[];
}

let cache: ToolCatalogData | null = null;
let inFlight: Promise<ToolCatalogData> | null = null;

function derive(entries: ToolCatalogEntry[]): ToolCatalogData {
  const order: string[] = [];
  const byCat = new Map<string, ToolCatalogGroup>();
  for (const e of entries) {
    let g = byCat.get(e.category);
    if (!g) {
      g = { label: e.category, emoji: e.categoryEmoji, tools: [] };
      byCat.set(e.category, g);
      order.push(e.category);
    }
    g.tools.push(e.name);
  }
  return {
    entries,
    categories: order.map((c) => byCat.get(c)!),
    safeMinimum: entries.filter((e) => e.defaultOn).map((e) => e.name),
    allTools: entries.map((e) => e.name),
  };
}

export function useToolCatalog(): { data: ToolCatalogData | null; error: string | null } {
  const [data, setData] = useState<ToolCatalogData | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) {
      setData(cache);
      return;
    }
    if (!inFlight) {
      // 失败后允许重试：inFlight 复位（缓存只记成功）
      inFlight = ipc.tools
        .getCatalog()
        .then(derive)
        .then((d) => {
          cache = d;
          return d;
        });
      inFlight.catch(() => {
        inFlight = null;
      });
    }
    let cancelled = false;
    void inFlight
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}
