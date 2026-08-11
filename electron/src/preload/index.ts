// electron/src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ApiSurface, AssignmentDeltas, ImMessage, InstalledSkill, StreamChunk, UploadedSkill } from '../../../renderer/src/ipc/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: ApiSurface = {
  auth: {
    register: (opts) => invoke('auth:register', opts),
    login: (opts) => invoke('auth:login', opts),
    getCurrentUser: () => invoke('auth:getCurrentUser'),
    logout: () => invoke('auth:logout'),
    onSessionExpired: (callback: (reason: string) => void) => {
      const handler = (_evt: IpcRendererEvent, data: { reason: string }): void => callback(data.reason);
      ipcRenderer.on('auth:sessionExpired', handler);
      return () => {
        ipcRenderer.off('auth:sessionExpired', handler);
      };
    },
  },
  system: {
    getInfo: () => invoke('system:getInfo'),
    getConduitStatus: () => invoke('system:getConduitStatus'),
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
    // v1.5.6：renderer 拉取 agent_meta（持久化分层）
    getMeta: (metaId: string) => invoke('agent:getMeta', metaId),
    createFromYaml: (yaml) => invoke('agent:createFromYaml', yaml),
    createCustom: (input) => invoke('agent:createCustom', input),
    list: (workspaceId?: string) => invoke('agent:list', workspaceId),
    assign: (workspaceId, defId, botUserId) =>
      invoke('agent:assign', workspaceId, defId, botUserId),
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
    abortStream: (roomId: string) => invoke('agent:abortStream', roomId),
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
  im: {
    startSync: () => invoke('im:startSync'),
    send: (roomId, body) => invoke('im:send', roomId, body),
    sendWithMentions: (roomId, body, userIds) => invoke('im:sendWithMentions', roomId, body, userIds),
    getRooms: (workspaceId) => invoke('im:getRooms', workspaceId),
    getMessages: (roomId) => invoke('im:getMessages', roomId),
  loadOlderMessages: (roomId: string, count?: number) =>
    invoke('im:loadOlderMessages', roomId, count),
    createRoom: (input) => invoke('im:createRoom', input),
    renameRoom: (roomId, name) => invoke('im:renameRoom', roomId, name),
    dissolveRoom: (roomId) => invoke('im:dissolveRoom', roomId),
    getMembers: (roomId) => invoke('im:getMembers', roomId),
    onMessage: (callback) => {
      const handler = (_evt: IpcRendererEvent, msg: ImMessage): void => callback(msg);
      ipcRenderer.on('im:message', handler);
      return () => {
        ipcRenderer.off('im:message', handler);
      };
    },
  },
  mcp: {
    register: (config) => invoke('mcp:register', config),
    // v1.6：列出所有已注册 MCP（含 source 区分）
    listRegistered: () => invoke('mcp:listRegistered'),
    // v1.6：删除自定义 MCP（marketplace 装的会 reject）
    deleteRegistered: (name: string) => invoke('mcp:deleteRegistered', name),
    start: (workspaceId, mcpName) => invoke('mcp:start', workspaceId, mcpName),
    listTools: (workspaceId, mcpName) => invoke('mcp:listTools', workspaceId, mcpName),
    callTool: (workspaceId, mcpName, toolName, args) =>
      invoke('mcp:callTool', workspaceId, mcpName, toolName, args),
    stop: (workspaceId, mcpName) => invoke('mcp:stop', workspaceId, mcpName),
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
  marketplace: {
    getCatalog: (catalogUrl) => invoke('marketplace:getCatalog', catalogUrl),
    search: (query, type) => invoke('marketplace:search', query, type),
    install: (item) => invoke('marketplace:install', item),
    listInstalled: () => invoke('marketplace:listInstalled'),
    uninstall: (itemId) => invoke('marketplace:uninstall', itemId),
  },
  settings: {
    getGlobal: () => invoke('settings:getGlobal'),
    updateGlobal: (patch) => invoke('settings:updateGlobal', patch),
    getRoom: (roomId: string) => invoke('settings:getRoom', roomId),
    updateRoom: (roomId: string, patch) => invoke('settings:updateRoom', roomId, patch),
  },
  skill: {
    // v1.6：列出所有已安装 skill（builtin + marketplace + custom 三类）
    listInstalled: () => invoke<InstalledSkill[]>('skill:listInstalled'),
    // v1.6：上传自定义 skill zip（File.arrayBuffer() → Buffer）。v1.6.2 起返回数组（支持批量安装）
    uploadZip: (buffer: ArrayBuffer, filename: string) =>
      // v1.6.3: 不能用 Buffer.from(buffer)——contextBridge 里 Node Buffer 跨 IPC
      // structured clone 时底层 ArrayBuffer view 关联会断，main 收到的是损坏数据。
      // 用标准 Uint8Array view 让 structured clone 正确拷贝，main process 自己转回 Buffer。
      invoke<UploadedSkill[]>('skill:uploadZip', new Uint8Array(buffer), filename),
    // v1.6：删除自定义上传的 skill（builtin/marketplace 抛错）
    deleteCustom: (slug: string) => invoke('skill:deleteCustom', slug),
  },
  dialog: {
    pickDirectory: (opts) => invoke('dialog:pickDirectory', opts),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;