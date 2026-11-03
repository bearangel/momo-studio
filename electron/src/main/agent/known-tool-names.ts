// 已知工具名集合（spec 2026-11-03 §6.3）：失效 ref 过滤的判定域。
// 必须取自真实工具定义而非文件名推导——插件工具的全名是
// plugin:<id>/<getDefs().name>，模块文件名与工具名可以不同（终审 B2）。
import { ALL_BUILTIN_TOOLS } from './tools/catalog';
import { listAssembledToolDefs } from '../plugin/tool-catalog';

export function collectKnownToolNames(workspaceId: string): Set<string> {
  const names = new Set<string>(ALL_BUILTIN_TOOLS);
  for (const t of listAssembledToolDefs(workspaceId)) names.add(t.fullName);
  return names;
}
