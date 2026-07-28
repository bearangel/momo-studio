// renderer/src/ipc/client.ts
import type { ApiSurface } from './types';

declare global {
  interface Window {
    api: ApiSurface;
  }
}

// Proxy so tests can swap window.api at runtime (via Object.assign(globalThis, { window: { api: mock } }))
export const ipc: ApiSurface = new Proxy({} as ApiSurface, {
  get(_target, prop: string) {
    return (globalThis as { window: { api: ApiSurface } }).window.api[
      prop as keyof ApiSurface
    ];
  },
});
