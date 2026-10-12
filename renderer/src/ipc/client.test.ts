// renderer/src/ipc/client.test.ts
//
// D11 回归锁：ipc client 代理层的错误归一与透传语义。
//   - 命名空间方法的 rejection 剥 `Error invoking remote method '<channel>': (Error: )?` 前缀
//   - 同步 throw 同样剥前缀；非 Promise 返回值（同步值 / 订阅退订函数）原样透传
//   - 非 Error rejection（裸字符串等）原样返回，不吞不包
//   - 包装引用稳定：同名命名空间/方法多次访问拿到同一实例（React 依赖比较前提）
//
// Mock 策略（momo-test-rules）：mock 收窄到进程边界 window.api——ipc client 本体
// 走真实 Proxy + 真实包装链，被测对象即生产路径。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipc } from './client';

// 仿真真机形态的 Electron IPC 包装错误（真机 D1：三层前缀）
const electronWrapped = (channel: string, msg: string): Error =>
  new Error(`Error invoking remote method '${channel}': Error: ${msg}`);

beforeEach(() => {
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: {
      list: vi.fn(),
    },
    system: {
      getPlatform: vi.fn(() => 'darwin'),
    },
    session: {
      onMessage: vi.fn(() => () => undefined),
    },
  };
});

describe('ipc client — D11 错误前缀剥离', () => {
  it('命名空间方法 rejection：剥双层包装前缀，只留原始正文', async () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    api.provider.list.mockRejectedValue(electronWrapped('provider:list', '供应商不可达'));
    await expect(ipc.provider.list()).rejects.toThrow('供应商不可达');
  });

  it('单层包装形态（无嵌套 Error:）同样剥净', async () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    api.provider.list.mockRejectedValue(
      new Error("Error invoking remote method 'provider:list': 路径越界"),
    );
    await expect(ipc.provider.list()).rejects.toThrow('路径越界');
  });

  it('非 IPC 包装的本地错误 message 原样（不误伤普通错误）', async () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    api.provider.list.mockRejectedValue(new Error('本地错误'));
    await expect(ipc.provider.list()).rejects.toThrow('本地错误');
  });

  it('rejection 保留原始 Error 身份（instanceof 与栈不丢）', async () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    const original = electronWrapped('provider:list', 'boom');
    api.provider.list.mockRejectedValue(original);
    const err = await ipc.provider.list().catch((e: unknown) => e);
    expect(err).toBe(original);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
  });

  it('非 Error rejection（裸字符串）原样返回，不吞不包', async () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    api.provider.list.mockRejectedValue('plain string');
    await expect(ipc.provider.list()).rejects.toBe('plain string');
  });

  it('同步 throw 同样剥前缀（非 invoke 型意外抛错的兜底）', () => {
    const api = (globalThis as unknown as { window: { api: { provider: { list: ReturnType<typeof vi.fn> } } } }).window.api;
    api.provider.list.mockImplementation(() => {
      throw electronWrapped('provider:list', '同步炸了');
    });
    expect(() => ipc.provider.list()).toThrow('同步炸了');
  });
});

describe('ipc client — 非 Promise 返回值透传', () => {
  it('同步值（system.getPlatform）原样返回', () => {
    expect(ipc.system.getPlatform()).toBe('darwin');
  });

  it('订阅型方法的返回值（退订函数）原样透传且可调用', () => {
    const off = ipc.session.onMessage(() => undefined);
    expect(typeof off).toBe('function');
    expect(off).toBeInstanceOf(Function);
  });
});

describe('ipc client — 包装引用稳定性', () => {
  it('同名命名空间多次访问返回同一代理实例', () => {
    expect(ipc.provider).toBe(ipc.provider);
  });

  it('同名方法多次访问返回同一包装函数（React 依赖比较前提）', () => {
    expect(ipc.provider.list).toBe(ipc.provider.list);
  });

  it('window.api 替换后（测试常见形态）取到新桩的包装', () => {
    const first = ipc.provider.list;
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      provider: { list: vi.fn().mockResolvedValue([]) },
    };
    expect(ipc.provider.list).not.toBe(first);
  });
});

// 真机回归锁（2026-10-12 验收 P0）：contextBridge 暴露成员为 non-configurable +
// non-writable——wrapNamespace 若用 Proxy 返回包装函数，首次访问即抛
// TypeError 白屏。mock 必须仿真该 descriptor（momo-test-rules 保真度）。
describe('wrapNamespace contextBridge descriptor 保真（真机白屏回归锁）', () => {
  it('non-configurable + non-writable 的原生函数成员可安全包装（普通对象拷贝，无 Proxy 不变量）', async () => {
    const ns: Record<string, unknown> = {};
    Object.defineProperty(ns, 'getInfo', {
      value: () => 42, writable: false, configurable: false, enumerable: true,
    });
    (globalThis as { window: { api: unknown } }).window = { api: { system: ns } };
    // Proxy 方案在此处直接 TypeError；拷贝方案应正常返回包装
    expect(() => ipc.system.getInfo()).not.toThrow();
    expect(ipc.system.getInfo()).toBe(42);
  });
});
