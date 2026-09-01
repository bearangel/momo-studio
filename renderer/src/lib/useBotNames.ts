// renderer/src/lib/useBotNames.ts
//
// bot agentUserId → 配置名称映射（members join definitions）。
// 所有展示 agent 身份的 IM 组件共用，确保一致显示配置名称而非 userId。
import { useMemo } from 'react';
import { useAgentStore } from '../stores/agent.store';
import { shortName } from '../components/im/avatars';

export function useBotNameMap(): Map<string, string> {
  const members = useAgentStore((s) => s.members);
  const definitions = useAgentStore((s) => s.definitions);
  return useMemo(() => {
    const defById = new Map(definitions.map((d) => [d.id, d]));
    const m = new Map<string, string>();
    for (const a of members) {
      const def = defById.get(a.agentDefinitionId);
      if (def) m.set(a.agentUserId, def.name);
    }
    return m;
  }, [members, definitions]);
}

/** userId → 配置名称（bot 优先取映射，回退 shortName） */
export function resolveBotName(
  userId: string,
  botNameMap: Map<string, string>,
): string {
  return botNameMap.get(userId) ?? shortName(userId);
}
