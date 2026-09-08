// renderer/src/components/task-board/useTaskEntityNames.ts
//
// 任务实体名称解析（K4：详情面板/卡片显示 ID 片段 → 人类可读名称）。
// 三类名称来源：
//   - agent 实例名：agent.store.members（instanceId → agentName，后端 JOIN 产出）
//   - 团队名：agent.store.teams（id → name）
//   - 会话标题：session.store.sessions 优先（IM 已加载时即时可用），
//     看板视图下未加载则本地 ipc.session.list 兜底拉取——不走
//     session.store.loadSessions（其无激活会话时会自动 selectSession
//     加载消息流，对看板视图是不可接受的副作用）
// 看板视图下 members/teams 未必已被其他面板加载，故 mount 时幂等兜底
// 拉取一次；查不到时回退 ID 前 8 位（成员移除/团队解散/会话删除的残留引用）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { useSessionStore } from '../../stores/session.store';
import type { SessionSummary } from '../../ipc/types';

export interface TaskEntityNames {
  agentName: (instanceId: string) => string;
  teamName: (teamId: string) => string;
  sessionTitle: (sessionId: string) => string;
}

const FALLBACK_SLICE = 8;

export function useTaskEntityNames(workspaceId: string | null): TaskEntityNames {
  const members = useAgentStore((s) => s.members);
  const teams = useAgentStore((s) => s.teams);
  const storeSessions = useSessionStore((s) => s.sessions);
  const loadMembers = useAgentStore((s) => s.loadMembers);
  const loadTeams = useAgentStore((s) => s.loadTeams);
  const [fetchedSessions, setFetchedSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadMembers(workspaceId).catch(() => {
      // 兜底拉取失败不阻塞渲染——名称回退 ID 片段
    });
    void loadTeams(workspaceId).catch(() => {});
    // 独立 async 块：ipc Proxy 在 window.api 未挂载时同步抛 TypeError，
    // 直接链 .catch 捕不到——必须整体包 try（测试环境无 window.api 的场景）
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.session.list(workspaceId);
        if (!cancelled) setFetchedSessions(list);
      } catch {
        // 同上：静默回退
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, loadMembers, loadTeams]);

  return useMemo(() => {
    const agentMap = new Map(members.map((m) => [m.instanceId, m.agentName]));
    const teamMap = new Map(teams.map((t) => [t.id, t.name]));
    // store 会话（IM 已加载）优先，本地拉取兜底——两源按 id 去重合并
    const sessionMap = new Map<string, string>();
    for (const s of fetchedSessions) sessionMap.set(s.id, s.title);
    for (const s of storeSessions) sessionMap.set(s.id, s.title);
    return {
      agentName: (id: string): string => agentMap.get(id) ?? id.slice(0, FALLBACK_SLICE),
      teamName: (id: string): string => teamMap.get(id) ?? id.slice(0, FALLBACK_SLICE),
      sessionTitle: (id: string): string => sessionMap.get(id) ?? id.slice(0, FALLBACK_SLICE),
    };
  }, [members, teams, storeSessions, fetchedSessions]);
}
