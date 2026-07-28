// electron/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { ApiSurface } from '../../../renderer/src/ipc/types';

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
    createFromYaml: (yaml) => invoke('agent:createFromYaml', yaml),
    list: () => invoke('agent:list'),
    assign: (workspaceId, defId, botUserId) =>
      invoke('agent:assign', workspaceId, defId, botUserId),
    listAssignments: (workspaceId) => invoke('agent:listAssignments', workspaceId),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;