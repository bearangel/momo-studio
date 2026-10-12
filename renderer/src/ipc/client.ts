// renderer/src/ipc/client.ts
//
// 2026-10-12 D11：IPC 错误归一收敛在此层——Electron 会把 ipcMain.handle 的
// throw 包成 `Error invoking remote method '<channel>': Error: <原始消息>` 再
// reject，历史上靠各消费点手动调 ipcErrorMessage 剥前缀（漏一处就多层前缀进
// UI）。现代理层统一包装：命名空间对象经 wrapNamespace、方法经 wrapFunction，
// rejection / 同步 throw 的 message 到达消费方前已被剥净。
// 包装结果按原始对象/函数 WeakMap 缓存——多次访问拿到同一实例，引用稳定
// （React 依赖比较、vi.fn 身份断言不受影响）。
//
// ⚠️ wrapNamespace 必须用普通对象拷贝而非 Proxy：contextBridge 暴露的全部成员
// 是 non-configurable + non-writable 数据属性（真机实证 2026-10-12），Proxy get
// 不变量要求此类属性返回原值——返回包装函数会在首次访问时抛 TypeError 白屏
// （单测 mock 是普通对象测不出，真机必崩）。
import type { ApiSurface } from './types';
import { normalizeIpcError } from '../lib/ipc-error';

declare global {
  interface Window {
    api: ApiSurface;
  }
}

type WrappedFn = (...args: unknown[]) => unknown;

const fnCache = new WeakMap<object, WrappedFn>();
const namespaceCache = new WeakMap<object, object>();

/** 包装单个 IPC 方法：Promise rejection 与同步 throw 统一经 normalizeIpcError；
 *  非 Promise 返回值（getPlatform 同步值 / onX 订阅退订函数等）原样透传 */
function wrapFunction(raw: object): WrappedFn {
  const cached = fnCache.get(raw);
  if (cached) return cached;
  const wrapped: WrappedFn = (...args) => {
    const fn = raw as (...a: unknown[]) => unknown;
    try {
      const result = fn(...args);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          throw normalizeIpcError(err);
        });
      }
      return result;
    } catch (err) {
      throw normalizeIpcError(err);
    }
  };
  fnCache.set(raw, wrapped);
  return wrapped;
}

/** 包装命名空间对象：普通对象拷贝 + 方法经 wrapFunction，非函数成员原样复制。
 *  刻意不用 Proxy（见文件头注释——contextBridge 成员属性 descriptor 触发
 *  Proxy get 不变量 TypeError）；contextBridge 表面静态，首次访问时一次拷贝
 *  即完整。own keys 含 symbol；descriptor 以 defineProperty 保留枚举性。 */
function wrapNamespace(raw: object): object {
  const cached = namespaceCache.get(raw);
  if (cached) return cached;
  const copy: Record<string | symbol, unknown> = {};
  for (const key of [
    ...Object.getOwnPropertyNames(raw),
    ...Object.getOwnPropertySymbols(raw),
  ]) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc) continue;
    if ('value' in desc) {
      Object.defineProperty(copy, key, {
        ...desc,
        value: typeof desc.value === 'function' ? wrapFunction(desc.value) : desc.value,
        configurable: true,
      });
    } else {
      Object.defineProperty(copy, key, desc);
    }
  }
  namespaceCache.set(raw, copy);
  return copy;
}

// Proxy so tests can swap window.api at runtime (via Object.assign(globalThis, { window: { api: mock } }))
export const ipc: ApiSurface = new Proxy({} as ApiSurface, {
  get(_target, prop: string) {
    const value = (globalThis as { window: { api: ApiSurface } }).window.api[
      prop as keyof ApiSurface
    ];
    if (typeof value === 'function') return wrapFunction(value);
    if (value && typeof value === 'object') return wrapNamespace(value);
    return value;
  },
});

