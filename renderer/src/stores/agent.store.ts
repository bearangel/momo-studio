// renderer/src/stores/agent.store.ts
//
// Agent 状态管理：
//   - definitions：所有已安装的 agent 定义（builtin + custom）
//   - assignments：当前 workspace 内已分配的 agent 实例
//   - running：instanceId → 是否运行中（主进程 runtime 进程池的本地镜像）
//
// addAgent 是 UI "添加 agent" 的主入口：调用 agent.addToWorkspace 一键编排
// （主进程完成 bot 注册 + 邀请 + 启动），成功后刷新 assignments 并标记为运行中。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { AgentDefinition, AgentAssignment } from '../ipc/types';

interface AgentState {
  definitions: AgentDefinition[];
  assignments: AgentAssignment[];
  running: Record<string, boolean>;
  loading: boolean;
  error: string | null;

  loadDefinitions: () => Promise<void>;
  loadAssignments: (workspaceId: string) => Promise<void>;
  /** 同步各 assignment 的运行状态（主进程是唯一真源） */
  syncRunningStates: () => Promise<void>;
  /** 一键添加 agent 到 workspace（编排由主进程完成），成功后刷新列表 */
  addAgent: (workspaceId: string, defId: string, apiKey: string) => Promise<void>;
  /** 安装 main agent 及其子 agents（编排由主进程完成） */
  assignMainAgent: (
    workspaceId: string,
    mainDefId: string,
    apiKey: string,
    selectedSubDefIds?: string[],
  ) => Promise<void>;
  /** 停止运行中的 agent 实例 */
  stopAgent: (instanceId: string) => Promise<void>;
  reset: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  definitions: [],
  assignments: [],
  running: {},
  loading: false,
  error: null,

  loadDefinitions: async () => {
    set({ loading: true, error: null });
    try {
      const defs = await ipc.agent.list();
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

  syncRunningStates: async () => {
    const { assignments } = get();
    const entries = await Promise.all(
      assignments.map(async (a) => [a.instanceId, await ipc.agent.isRunning(a.instanceId)] as const),
    );
    const running: Record<string, boolean> = {};
    for (const [id, isRunning] of entries) running[id] = isRunning;
    set({ running });
  },

  addAgent: async (workspaceId, defId, apiKey) => {
    set({ error: null });
    try {
      const assignment = await ipc.agent.addToWorkspace({
        workspaceId,
        agentDefinitionId: defId,
        llmApiKey: apiKey,
      });
      // addToWorkspace 已启动 runtime，故直接标记为运行中并追加到列表
      set((state) => ({
        assignments: [...state.assignments, assignment],
        running: { ...state.running, [assignment.instanceId]: true },
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  assignMainAgent: async (workspaceId, mainDefId, apiKey, selectedSubDefIds) => {
    set({ error: null });
    try {
      const newAssignments = await ipc.agent.assignMain({
        workspaceId,
        mainDefId,
        llmApiKey: apiKey,
        selectedSubDefIds,
      });
      // assignMain 已启动 runtime，全部标记为运行中
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
      loading: false,
      error: null,
    }),
}));
