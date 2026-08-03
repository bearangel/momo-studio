// renderer/src/stores/agent.store.ts
//
// Agent 状态管理（v1.3）：
//   - definitions：当前可见的 agent 定义（global + 当前 ws scoped + builtin）
//   - assignments：当前 workspace 内已分配的 agent 实例（含 role + parent）
//   - running：instanceId → 是否运行中
//   - builtinSuggestions：builtin YAML 的角色/platform 建议（UI 预填用）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  AgentDefinition,
  AgentAssignment,
  AgentRole,
  BuiltinSuggestionMap,
} from '../ipc/types';

interface AgentState {
  definitions: AgentDefinition[];
  assignments: AgentAssignment[];
  running: Record<string, boolean>;
  builtinSuggestions: BuiltinSuggestionMap;
  loading: boolean;
  error: string | null;

  loadDefinitions: (workspaceId?: string) => Promise<void>;
  loadAssignments: (workspaceId: string) => Promise<void>;
  loadBuiltinSuggestions: () => Promise<void>;
  syncRunningStates: () => Promise<void>;
  addAgent: (
    workspaceId: string,
    defId: string,
    role: AgentRole,
    parentInstanceId?: string,
    apiKeyOverride?: string,
  ) => Promise<void>;
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
  stopAgent: (instanceId: string) => Promise<void>;
  reset: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  definitions: [],
  assignments: [],
  running: {},
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
      await get().syncRunningStates();
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

  syncRunningStates: async () => {
    const { assignments } = get();
    const entries = await Promise.all(
      assignments.map(async (a) => [a.instanceId, await ipc.agent.isRunning(a.instanceId)] as const),
    );
    const running: Record<string, boolean> = {};
    for (const [id, isRunning] of entries) running[id] = isRunning;
    set({ running });
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
        running: { ...state.running, [assignment.instanceId]: true },
      }));
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
      const newRunning: Record<string, boolean> = {};
      for (const a of newAssignments) newRunning[a.instanceId] = true;
      set((state) => ({
        assignments: [...state.assignments, ...newAssignments],
        running: { ...state.running, ...newRunning },
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

  stopAgent: async (instanceId) => {
    set({ error: null });
    try {
      await ipc.agent.stop(instanceId);
      set((state) => ({
        running: { ...state.running, [instanceId]: false },
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  reset: () =>
    set({
      definitions: [],
      assignments: [],
      running: {},
      builtinSuggestions: {},
      loading: false,
      error: null,
    }),
}));
