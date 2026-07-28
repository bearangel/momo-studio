// renderer/src/ipc/client.ts
import type { ApiSurface } from './types';

declare global {
  interface Window {
    api: ApiSurface;
  }
}

export const ipc: ApiSurface = window.api;