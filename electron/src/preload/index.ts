// electron/src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ApiSurface,
  AssignmentDeltas,
  ImMessage,
  MessageEventBatch,
  ResourceFilter,
  ResourceItem,
  StreamChunk,
  TaskRow,
  UploadedSkill,
} from '../../../renderer/src/ipc/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: ApiSurface = {
  system: {
    getInfo: () => invoke('system:getInfo'),
  },
  workspace: {
    create: (input) => invoke('workspace:create', input),
    list: () => invoke('workspace:list'),
    get: (id) => invoke('workspace:get', id),
    delete: (id) => invoke('workspace:delete', id),
    setCoordinator: (id, instanceId) => invoke('workspace:setCoordinator', id, instanceId),
    getCoordinator: (id) => invoke('workspace:getCoordinator', id),
  },
  file: {
    read: (wsId, path) => invoke('file:read', wsId, path),
    write: (wsId, path, content) => invoke('file:write', wsId, path, content),
    list: (wsId, dir) => invoke('file:list', wsId, dir),
    create: (wsId, filePath, type) => invoke('file:create', wsId, filePath, type),
    delete: (wsId, filePath) => invoke('file:delete', wsId, filePath),
    rename: (wsId, srcPath, dstPath) => invoke('file:rename', wsId, srcPath, dstPath),
  },
  agent: {
    addToWorkspace: (input) => invoke('agent:addToWorkspace', input),
    assignMain: (input) => invoke('agent:assignMain', input),
    createFromYaml: (yaml) => invoke('agent:createFromYaml', yaml),
    createCustom: (input) => invoke('agent:createCustom', input),
    list: (workspaceId?: string) => invoke('agent:list', workspaceId),
    assign: (workspaceId, defId, agentUserId) =>
      invoke('agent:assign', workspaceId, defId, agentUserId),
    listAssignments: (workspaceId) => invoke('agent:listAssignments', workspaceId),
    start: (opts) => invoke('agent:start', opts),
    stop: (instanceId) => invoke('agent:stop', instanceId),
    removeAssignment: (instanceId) => invoke('agent:removeAssignment', instanceId),
    isRunning: (instanceId) => invoke('agent:isRunning', instanceId),
    updateDefinition: (input) => invoke('agent:updateDefinition', input),
    updateAssignmentRole: (instanceId: string, role: 'standalone' | 'main' | 'sub', parentInstanceId?: string) =>
      invoke('agent:updateAssignmentRole', instanceId, role, parentInstanceId),
    updateAssignmentApiKey: (instanceId: string, apiKey: string | null) =>
      invoke('agent:updateAssignmentApiKey', instanceId, apiKey),
    deleteDefinition: (defId: string) => invoke('agent:deleteDefinition', defId),
    getBuiltinSuggestions: () => invoke('agent:getBuiltinSuggestions'),
    // v1.6：per-assignment 能力 delta（Layer 3）读写
    getAssignmentDeltas: (instanceId: string) => invoke('agent:getAssignmentDeltas', instanceId),
    setAssignmentDeltas: (instanceId: string, deltas: AssignmentDeltas) =>
      invoke('agent:setAssignmentDeltas', instanceId, deltas),
    onRuntimeChanged: (callback) => {
      const handler = (): void => callback();
      ipcRenderer.on('agent:runtimeChanged', handler);
      return () => {
        ipcRenderer.off('agent:runtimeChanged', handler);
      };
    },
    onStream: (callback) => {
      const handler = (_evt: IpcRendererEvent, chunk: StreamChunk): void => callback(chunk);
      ipcRenderer.on('agent:stream', handler);
      return () => {
        ipcRenderer.off('agent:stream', handler);
      };
    },
    abortStream: (streamSessionId: string) => invoke('agent:abortStream', streamSessionId),
  },
  provider: {
    list: () => invoke('provider:list'),
    get: (id) => invoke('provider:get', id),
    create: (input) => invoke('provider:create', input),
    update: (input) => invoke('provider:update', input),
    delete: (id) => invoke('provider:delete', id),
    setDefault: (id) => invoke('provider:setDefault', id),
    testConnection: (input) => invoke('provider:testConnection', input),
    getApiKey: (id) => invoke('provider:getApiKey', id),
  },
  // v2.0 P1 Task 12：im 命名空间收缩——全部 im:* invoke 通道已随 Matrix 全家删除，
  // 仅保留 im:conflict 推送订阅（发送方 session-service，通道名留待 P2 收敛）。
  im: {
    onConflict: (callback) => {
      const handler = (
        _e: IpcRendererEvent,
        data: { newTaskId: string; currentTaskId: string; currentRoomId: string },
      ): void => callback(data);
      ipcRenderer.on('im:conflict', handler);
      return () => {
        ipcRenderer.off('im:conflict', handler);
      };
    },
  },
  mcp: {
    register: (config) => invoke('mcp:register', config),
    start: (workspaceId, mcpName) => invoke('mcp:start', workspaceId, mcpName),
    listTools: (workspaceId, mcpName) => invoke('mcp:listTools', workspaceId, mcpName),
    callTool: (workspaceId, mcpName, toolName, args) =>
      invoke('mcp:callTool', workspaceId, mcpName, toolName, args),
    stop: (workspaceId, mcpName) => invoke('mcp:stop', workspaceId, mcpName),
  },
  session: {
    // v2.0 P1 Task 8：会话内核命名空间（纯 SQLite，无 Matrix）。
    // invoke 通道 9 个（session.ipc.handlers.ts）+ 推送 2 个
    // （session:message / session:message_event_batch）。
    list: (workspaceId?: string) => invoke('session:list', workspaceId),
    get: (sessionId: string) => invoke('session:get', sessionId),
    create: (input) => invoke('session:create', input),
    rename: (sessionId: string, title: string) => invoke('session:rename', sessionId, title),
    delete: (sessionId: string) => invoke('session:delete', sessionId),
    send: (sessionId: string, body: string, mentionedAssignmentIds?: string[]) =>
      invoke('session:send', sessionId, body, mentionedAssignmentIds),
    getMessages: (sessionId: string) => invoke('session:getMessages', sessionId),
    loadOlder: (sessionId: string, beforeTs: number, count?: number) =>
      invoke('session:loadOlder', sessionId, beforeTs, count),
    exportMessages: (sessionId: string, limit: number) =>
      invoke<{ filename: string; content: string }>('session:exportMessages', sessionId, limit),
    onMessage: (callback) => {
      const handler = (_evt: IpcRendererEvent, msg: ImMessage): void => callback(msg);
      ipcRenderer.on('session:message', handler);
      return () => {
        ipcRenderer.off('session:message', handler);
      };
    },
    onMessageEventBatch: (callback) => {
      const handler = (_e: IpcRendererEvent, batch: MessageEventBatch): void => callback(batch);
      ipcRenderer.on('session:message_event_batch', handler);
      return () => {
        ipcRenderer.off('session:message_event_batch', handler);
      };
    },
  },
  allocation: {
    get: (workspaceId) => invoke('allocation:get', workspaceId),
    add: (workspaceId, type, ref) => invoke('allocation:add', workspaceId, type, ref),
    remove: (workspaceId, type, ref) => invoke('allocation:remove', workspaceId, type, ref),
  },
  gitPolicy: {
    get: (workspaceId) => invoke('gitPolicy:get', workspaceId),
    set: (workspaceId, policy) => invoke('gitPolicy:set', workspaceId, policy),
  },
  audit: {
    getToolCalls: (workspaceId, opts) => invoke('audit:getToolCalls', workspaceId, opts),
  },
  settings: {
    getGlobal: () => invoke('settings:getGlobal'),
    updateGlobal: (patch) => invoke('settings:updateGlobal', patch),
    getSession: (sessionId: string) => invoke('settings:getSession', sessionId),
    updateSession: (sessionId: string, patch) => invoke('settings:updateSession', sessionId, patch),
  },
  skill: {
    // v1.6：上传自定义 skill zip（File.arrayBuffer() → Buffer）。v1.6.2 起返回数组（支持批量安装）
    uploadZip: (buffer: ArrayBuffer, filename: string) =>
      // v1.6.3: 不能用 Buffer.from(buffer)——contextBridge 里 Node Buffer 跨 IPC
      // structured clone 时底层 ArrayBuffer view 关联会断，main 收到的是损坏数据。
      // 用标准 Uint8Array view 让 structured clone 正确拷贝，main process 自己转回 Buffer。
      invoke<UploadedSkill[]>('skill:uploadZip', new Uint8Array(buffer), filename),
  },
  resource: {
    // v1.7：统一资源列表（builtin + marketplace + custom 三源合并），filter 可选
    list: (filter?: ResourceFilter) => invoke<ResourceItem[]>('resource:list', filter),
    // v1.7：按 id 查单个资源详情（找不到返回 null）
    getDetail: (id: string) => invoke<ResourceItem | null>('resource:getDetail', id),
    // v1.7：安装 marketplace 资源（builtin/custom 不可安装）
    install: (id: string) => invoke<void>('resource:install', id),
    // v1.7：删除/卸载资源（builtin 抛错；marketplace→uninstall；custom 三分支）
    delete: (id: string) => invoke<void>('resource:delete', id),
  },
  task: {
    create: (input) => invoke<TaskRow>('task:create', input),
    list: (opts) => invoke<TaskRow[]>('task:list', opts),
    get: (id) => invoke<TaskRow | null>('task:get', id),
    update: (id, patch) => invoke<void>('task:update', id, patch),
    transition: (id, to, extraPatch) => invoke<TaskRow>('task:transition', id, to, extraPatch),
    // B8：execution_session 决策树 + 转 in_progress + 锁定 execution_session
    start: (id, opts) =>
      invoke<{ executionSessionId: string; createdNewRoom: boolean }>('task:start', id, opts),
    cancel: (id) => invoke<void>('task:cancel', id),
    // B9：任务冲突处理（5 策略）
    resolveConflict: (input) => invoke('task:resolveConflict', input),
  },
  dialog: {
    pickDirectory: (opts) => invoke('dialog:pickDirectory', opts),
  },
  p2p: {
    // C8：P2P 节点发现 + 信任管理
    getIdentity: () => invoke('p2p:getIdentity'),
    getDiscoveredNodes: () => invoke('p2p:getDiscoveredNodes'),
    addTrustedNode: (nodeId: string) => invoke('p2p:addTrustedNode', nodeId),
    removeTrustedNode: (nodeId: string) => invoke('p2p:removeTrustedNode', nodeId),
    listTrustedNodes: () => invoke('p2p:listTrustedNodes'),
  },
  window: {
    // P2 Task 1：自绘 titlebar 窗口控制（send 单向 + is-maximized 查询 + maximized 推送）
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => invoke<boolean>('window:is-maximized'),
    onMaximizedChanged: (callback: (maximized: boolean) => void) => {
      const handler = (_evt: IpcRendererEvent, maximized: boolean): void => callback(maximized);
      ipcRenderer.on('window:maximized-changed', handler);
      return () => {
        ipcRenderer.off('window:maximized-changed', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;