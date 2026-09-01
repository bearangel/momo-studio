// renderer/src/stores/agent.store.ts
//
// Agent 状态管理（v25 Task 11，spec §5）：
//   - definitions：agent 定义（v25 定义全局化，workspaceId 恒 null）
//   - members：当前 workspace 内的 agent 成员实例（WorkspaceAgentMember，
//     无 role/parent——v25 去编排；由 v1.3 assignments 更名）
//   - teams：当前 workspace 的团队（spec §3.2）；变更 action 成功后按
//     teamsWorkspaceId 自动 reload（单一真相源 = DB，不做本地 patch）
//   - builtinSuggestions：builtin YAML 的 platform 建议（UI 预填用）
//
// 「agent 在线」唯一权威源 = member.lastRunning（从 DB 同步）；
// startMember/stopMember 后 reload members 反映新状态。
//
// setDefaultAgent 在 workspace.store（Task 6 已实现）——单一入口防漂移。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  AgentDefinition,
  AssignmentDeltas,
  BuiltinSuggestionMap,
  Team,
  WorkspaceAgentMember,
} from '../ipc/types';

/** team:create 入参（与 types.d.ts team.create 对齐） */
export interface CreateTeamInput {
  name: string;
  iconEmoji?: string;
  memberInstanceIds: string[];
  leaderInstanceId: string;
}

interface AgentState {
  definitions: AgentDefinition[];
  members: WorkspaceAgentMember[];
  teams: Team[];
  /** 最近一次 loadTeams 的 workspaceId——team 变更 action 后按它自动刷新 */
  teamsWorkspaceId?: string;
  builtinSuggestions: BuiltinSuggestionMap;
  loading: boolean;
  error: string | null;

  loadDefinitions: (workspaceId?: string) => Promise<void>;
  loadMembers: (workspaceId: string) => Promise<void>;
  loadBuiltinSuggestions: () => Promise<void>;
  addMember: (
    workspaceId: string,
    defId: string,
    apiKeyOverride?: string,
  ) => Promise<WorkspaceAgentMember>;
  /** 移除成员；leader 守卫命中时返回 `{ ok: false, blockedTeams }`（UI 提示先转移/解散） */
  removeMember: (
    instanceId: string,
  ) => Promise<{ ok: true } | { ok: false; blockedTeams: string[] }>;
  deleteDefinition: (defId: string) => Promise<void>;
  updateMemberApiKey: (instanceId: string, apiKey: string | null) => Promise<void>;
  /** v1.6：读取某成员的能力 delta（Layer 3） */
  getMemberDeltas: (instanceId: string) => Promise<AssignmentDeltas>;
  /** v1.6：全量替换某成员的能力 delta（幂等） */
  setMemberDeltas: (instanceId: string, deltas: AssignmentDeltas) => Promise<void>;
  stopMember: (instanceId: string) => Promise<void>;
  startMember: (member: WorkspaceAgentMember, workspaceId: string) => Promise<void>;

  loadTeams: (workspaceId: string) => Promise<void>;
  createTeam: (workspaceId: string, input: CreateTeamInput) => Promise<Team>;
  renameTeam: (teamId: string, name: string, iconEmoji?: string) => Promise<void>;
  deleteTeam: (teamId: string) => Promise<void>;
  setLeader: (teamId: string, leaderInstanceId: string) => Promise<void>;
  addTeamMember: (teamId: string, instanceId: string) => Promise<void>;
  removeTeamMember: (teamId: string, instanceId: string) => Promise<void>;

  reset: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  definitions: [],
  members: [],
  teams: [],
  builtinSuggestions: {},
  loading: false,
  error: null,

  loadDefinitions: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const defs = await ipc.agent.list(workspaceId);
      set({ definitions: defs, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  loadMembers: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const list = await ipc.agent.listMembers(workspaceId);
      set({ members: list, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  loadBuiltinSuggestions: async () => {
    try {
      const map = await ipc.agent.getBuiltinSuggestions();
      set({ builtinSuggestions: map });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addMember: async (workspaceId, defId, apiKeyOverride) => {
    set({ error: null });
    try {
      const member = await ipc.agent.addMember({
        workspaceId,
        agentDefinitionId: defId,
        apiKeyOverride,
      });
      set((state) => ({
        members: [...state.members, member],
      }));
      return member;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  removeMember: async (instanceId) => {
    set({ error: null });
    try {
      const result = await ipc.agent.removeMember(instanceId);
      if (result.ok) {
        const wsId = get().members.find((m) => m.instanceId === instanceId)?.workspaceId;
        if (wsId) await get().loadMembers(wsId);
      }
      return result;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deleteDefinition: async (defId) => {
    set({ error: null });
    try {
      await ipc.agent.deleteDefinition(defId);
      set((state) => ({
        definitions: state.definitions.filter((d) => d.id !== defId),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateMemberApiKey: async (instanceId, apiKey) => {
    set({ error: null });
    try {
      await ipc.agent.setMemberApiKeyOverride(instanceId, apiKey);
      const wsId = get().members.find((m) => m.instanceId === instanceId)?.workspaceId;
      if (wsId) await get().loadMembers(wsId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  getMemberDeltas: async (instanceId) => {
    set({ error: null });
    try {
      return await ipc.agent.getMemberDeltas(instanceId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  setMemberDeltas: async (instanceId, deltas) => {
    set({ error: null });
    try {
      await ipc.agent.setMemberDeltas(instanceId, deltas);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  stopMember: async (instanceId) => {
    set({ error: null });
    try {
      await ipc.agent.stop(instanceId);
      const stopped = get().members.find((m) => m.instanceId === instanceId);
      if (stopped) {
        await get().loadMembers(stopped.workspaceId);
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  startMember: async (member, workspaceId) => {
    set({ error: null });
    try {
      await ipc.agent.start({ member, workspaceId });
      await get().loadMembers(workspaceId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  loadTeams: async (workspaceId) => {
    set({ error: null });
    try {
      const teams = await ipc.team.list(workspaceId);
      set({ teams, teamsWorkspaceId: workspaceId });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  createTeam: async (workspaceId, input) => {
    set({ error: null });
    try {
      const team = await ipc.team.create(workspaceId, input);
      if (get().teamsWorkspaceId === workspaceId) {
        await get().loadTeams(workspaceId);
      }
      return team;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  renameTeam: async (teamId, name, iconEmoji) => {
    set({ error: null });
    try {
      await ipc.team.rename(teamId, name, iconEmoji);
      await refreshTeams(get);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deleteTeam: async (teamId) => {
    set({ error: null });
    try {
      await ipc.team.delete(teamId);
      await refreshTeams(get);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  setLeader: async (teamId, leaderInstanceId) => {
    set({ error: null });
    try {
      await ipc.team.setLeader(teamId, leaderInstanceId);
      await refreshTeams(get);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  addTeamMember: async (teamId, instanceId) => {
    set({ error: null });
    try {
      await ipc.team.addMember(teamId, instanceId);
      await refreshTeams(get);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  removeTeamMember: async (teamId, instanceId) => {
    set({ error: null });
    try {
      await ipc.team.removeMember(teamId, instanceId);
      await refreshTeams(get);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  reset: () =>
    set({
      definitions: [],
      members: [],
      teams: [],
      teamsWorkspaceId: undefined,
      builtinSuggestions: {},
      loading: false,
      error: null,
    }),
}));

/** team 变更后按最近一次 loadTeams 的 workspaceId 刷新（未加载过则跳过） */
async function refreshTeams(get: () => AgentState): Promise<void> {
  const wsId = get().teamsWorkspaceId;
  if (wsId) await get().loadTeams(wsId);
}
