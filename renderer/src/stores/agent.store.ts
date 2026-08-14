// renderer/src/stores/agent.store.ts
//
// Agent 状态管理（v1.3）：
//   - definitions：当前可见的 agent 定义（global + 当前 ws scoped + builtin）
//   - assignments：当前 workspace 内已分配的 agent 实例（含 role + parent + lastRunning）
//   - builtinSuggestions：builtin YAML 的角色/platform 建议（UI 预填用）
//
// v2 修复：删除 running state（Record<string,boolean>），单一数据源 =
// assignment.lastRunning（从 DB 同步）。stopAgent/startAgent 改为 reload assignments。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  AgentDefinition,
  AgentAssignment,
  AgentRole,
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
    role: AgentRole,
    parentInstanceId?: string,
    apiKeyOverride?: string,
  ) => Promise<AgentAssignment>;
  assignMainAgent: (
    workspaceId: string,
    mainDefId: string,
    apiKeyOverride?: string,
    selectedSubDefIds?: string[],
  ) => Promise<void>;
  deleteDefinition: (defId: string) => Promise<void>;
  updateAssignmentRole: (
    instanceId: string,
    role: AgentRole,
    parentInstanceId?: string,
  ) => Promise<void>;
  updateAssignmentApiKey: (instanceId: string, apiKey: string | null) => Promise<void>;
  /** v1.6：读取某 assignment 的能力 delta（Layer 3） */
  getAssignmentDeltas: (instanceId: string) => Promise<AssignmentDeltas>;
  /** v1.6：全量替换某 assignment 的能力 delta（幂等） */
  setAssignmentDeltas: (instanceId: string, deltas: AssignmentDeltas) => Promise<void>;
  stopAgent: (instanceId: string) => Promise<void>;
  startAgent: (
    assignment: AgentAssignment,
    workspaceId: string,
    teamRoomId: string,
  ) => Promise<void>;
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
      const list = await ipc.agent.listAssignments(workspaceId);
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

  addAgent: async (workspaceId, defId, role, parentInstanceId, apiKeyOverride) => {
    set({ error: null });
    try {
      const assignment = await ipc.agent.addToWorkspace({
        workspaceId,
        agentDefinitionId: defId,
        role,
        parentInstanceId,
        apiKeyOverride,
      });
      set((state) => ({
        assignments: [...state.assignments, assignment],
      }));
      return assignment;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  assignMainAgent: async (workspaceId, mainDefId, apiKeyOverride, selectedSubDefIds) => {
    set({ error: null });
    try {
      const newAssignments = await ipc.agent.assignMain({
        workspaceId,
        mainDefId,
        apiKeyOverride,
        selectedSubDefIds,
      });
      set((state) => ({
        assignments: [...state.assignments, ...newAssignments],
      }));
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

  updateAssignmentRole: async (instanceId, role, parentInstanceId) => {
    set({ error: null });
    try {
      await ipc.agent.updateAssignmentRole(instanceId, role, parentInstanceId);
      const wsId = get().assignments.find((a) => a.instanceId === instanceId)?.workspaceId;
      if (wsId) await get().loadAssignments(wsId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateAssignmentApiKey: async (instanceId, apiKey) => {
    set({ error: null });
    try {
      await ipc.agent.updateAssignmentApiKey(instanceId, apiKey);
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
      return await ipc.agent.getAssignmentDeltas(instanceId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  setAssignmentDeltas: async (instanceId, deltas) => {
    set({ error: null });
    try {
      await ipc.agent.setAssignmentDeltas(instanceId, deltas);
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

  startAgent: async (assignment, workspaceId, teamRoomId) => {
    set({ error: null });
    try {
      await ipc.agent.start({ assignment, workspaceId, teamRoomId });
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
