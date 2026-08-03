// electron/src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ApiSurface, ImMessage } from '../../../renderer/src/ipc/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

const api: ApiSurface = {
  auth: {
    register: (opts) => invoke('auth:register', opts),
    login: (opts) => invoke('auth:login', opts),
    getCurrentUser: () => invoke('auth:getCurrentUser'),
    logout: () => invoke('auth:logout'),
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
    onRuntimeChanged: (callback) => {
      const handler = (): void => callback();
      ipcRenderer.on('agent:runtimeChanged', handler);
      return () => {
        ipcRenderer.off('agent:runtimeChanged', handler);
      };
    },
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
  dialog: {
    pickDirectory: (opts) => invoke('dialog:pickDirectory', opts),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;