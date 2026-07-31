// renderer/src/lib/useBotNames.ts
//
// bot Matrix userId → 配置名称映射（assignments join definitions）。
// 所有展示 agent 身份的 IM 组件共用，确保一致显示配置名称而非 userId。
import { useMemo } from 'react';
import { useAgentStore } from '../stores/agent.store';
import { shortName } from '../components/im/avatars';

export function useBotNameMap(): Map<string, string> {
  const assignments = useAgentStore((s) => s.assignments);
  const definitions = useAgentStore((s) => s.definitions);
  return useMemo(() => {
    const defById = new Map(definitions.map((d) => [d.id, d]));
    const m = new Map<string, string>();
    for (const a of assignments) {
      const def = defById.get(a.agentDefinitionId);
      if (def) m.set(a.botMatrixUserId, def.name);
    }
    return m;
  }, [assignments, definitions]);
}

/** userId → 配置名称（bot 优先取映射，回退 shortName） */
export function resolveBotName(
  userId: string,
  botNameMap: Map<string, string>,
): string {
  return botNameMap.get(userId) ?? shortName(userId);
}
