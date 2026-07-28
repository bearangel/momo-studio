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
  },
  file: {
    read: (wsId, path) => invoke('file:read', wsId, path),
    write: (wsId, path, content) => invoke('file:write', wsId, path, content),
    list: (wsId, dir) => invoke('file:list', wsId, dir),
  },
  agent: {
    addToWorkspace: (input) => invoke('agent:addToWorkspace', input),
    createFromYaml: (yaml) => invoke('agent:createFromYaml', yaml),
    list: () => invoke('agent:list'),
    assign: (workspaceId, defId, botUserId) =>
      invoke('agent:assign', workspaceId, defId, botUserId),
    listAssignments: (workspaceId) => invoke('agent:listAssignments', workspaceId),
    start: (opts) => invoke('agent:start', opts),
    stop: (instanceId) => invoke('agent:stop', instanceId),
    isRunning: (instanceId) => invoke('agent:isRunning', instanceId),
  },
  im: {
    startSync: () => invoke('im:startSync'),
    send: (roomId, body) => invoke('im:send', roomId, body),
    getRooms: () => invoke('im:getRooms'),
    getMessages: (roomId) => invoke('im:getMessages', roomId),
    onMessage: (callback) => {
      const handler = (_evt: IpcRendererEvent, msg: ImMessage): void => callback(msg);
      ipcRenderer.on('im:message', handler);
      return () => {
        ipcRenderer.off('im:message', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;