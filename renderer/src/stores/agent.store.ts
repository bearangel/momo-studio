// renderer/src/stores/agent.store.ts
//
// Agent 状态管理（v1.3；v25 Task 6 通道面对齐）：
//   - definitions：当前可见的 agent 定义（global + 当前 ws scoped + builtin）
//   - assignments：当前 workspace 内的 agent 成员实例（v25 成员制，无 role/parent；
//     字段更名 members 归 Task 11）
//   - builtinSuggestions：builtin YAML 的 platform 建议（UI 预填用）
//
// v2 修复：删除 running state（Record<string,boolean>），单一数据源 =
// assignment.lastRunning（从 DB 同步）。stopAgent/startAgent 改为 reload assignments。
//
// v25：assignMainAgent / updateAssignmentRole 随 role 概念退役删除；
// assignment 系列通道调用平移到 member 命名。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  AgentDefinition,
  AgentAssignment,
  AssignmentDeltas,
  BuiltinSuggestionMap,
} from '../ipc/types';

interface AgentState {
  definitions: AgentDefinition[];
  assignments: AgentAssignment[];
  builtinSuggestions: BuiltinSuggestionMap;
  loading: boolean;
  error: string | null;

  loadDefinitions: (workspaceId?: string) => Promise<void>;
  loadAssignments: (workspaceId: string) => Promise<void>;
  loadBuiltinSuggestions: () => Promise<void>;
  addAgent: (
    workspaceId: string,
    defId: string,
    apiKeyOverride?: string,
  ) => Promise<AgentAssignment>;
  deleteDefinition: (defId: string) => Promise<void>;
  updateAssignmentApiKey: (instanceId: string, apiKey: string | null) => Promise<void>;
  /** v1.6：读取某成员的能力 delta（Layer 3） */
  getAssignmentDeltas: (instanceId: string) => Promise<AssignmentDeltas>;
  /** v1.6：全量替换某成员的能力 delta（幂等） */
  setAssignmentDeltas: (instanceId: string, deltas: AssignmentDeltas) => Promise<void>;
  stopAgent: (instanceId: string) => Promise<void>;
  startAgent: (assignment: AgentAssignment, workspaceId: string) => Promise<void>;
  reset: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  definitions: [],
  assignments: [],
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

  loadAssignments: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const list = await ipc.agent.listMembers(workspaceId);
      set({ assignments: list, loading: false });
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

  addAgent: async (workspaceId, defId, apiKeyOverride) => {
    set({ error: null });
    try {
      const member = await ipc.agent.addMember({
        workspaceId,
        agentDefinitionId: defId,
        apiKeyOverride,
      });
      set((state) => ({
        assignments: [...state.assignments, member],
      }));
      return member;
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

  updateAssignmentApiKey: async (instanceId, apiKey) => {
    set({ error: null });
    try {
      await ipc.agent.setMemberApiKeyOverride(instanceId, apiKey);
      const wsId = get().assignments.find((a) => a.instanceId === instanceId)?.workspaceId;
      if (wsId) await get().loadAssignments(wsId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  getAssignmentDeltas: async (instanceId) => {
    set({ error: null });
    try {
      return await ipc.agent.getMemberDeltas(instanceId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  setAssignmentDeltas: async (instanceId, deltas) => {
    set({ error: null });
    try {
      await ipc.agent.setMemberDeltas(instanceId, deltas);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  stopAgent: async (instanceId) => {
    set({ error: null });
    try {
      await ipc.agent.stop(instanceId);
      // v2 修复：reload assignments 反映新 lastRunning 状态
      const stopped = get().assignments.find((a) => a.instanceId === instanceId);
      if (stopped) {
        await get().loadAssignments(stopped.workspaceId);
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  startAgent: async (assignment, workspaceId) => {
    set({ error: null });
    try {
      await ipc.agent.start({ member: assignment, workspaceId });
      // v2 修复：reload assignments 反映新 lastRunning 状态
      await get().loadAssignments(workspaceId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  reset: () =>
    set({
      definitions: [],
      assignments: [],
      builtinSuggestions: {},
      loading: false,
      error: null,
    }),
}));
