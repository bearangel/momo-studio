// electron/tests/browser/ipc.test.ts
//
// 浏览器命名空间 IPC 接线测试（v2.7 McpBrowser Task 7，spec §3.6）。
//
// mock 收窄在三类边界（momo-test-rules 铁律 5）：
//   - IPC 边界：ipcMainLike（Map 捕获 handler 表）/ webContentsLike（send 数组捕获）
//   - Electron 视图边界：ViewFactory / webContents（mock 形态照抄 manager.test.ts，
//     事件参数序与真实 Electron 一致）
//   - T10 边界：probeDevServers 函数依赖注入 mock（真实现 T10 才有）
// 其余全真实：真 SQLite（runMigrations + workspace 行）+ 真 BrowserSettingsStore +
// 真 BrowserPolicy（readSettings 接真 store.read——T10 boot 同款组合）+ 真 BrowserManager。
//
// 断言清单（brief Step 1 + T6 review 硬性项）：
//   12 通道注册齐全 / browser:state 七字段载荷锁（含 trusted=ask 未授 false）/
//   browser:notice {kind,text} 载荷锁（崩溃自愈真实链路）/ getState 空壳与活跃态 /
//   userNavigate 隐式接管 + 非法 URL 不产生接管副作用 / takeover/release /
//   tabs 三通道 / setSidebarBounds rect 透传 / setSidebarCollapsed 视图销毁+落库 /
//   answerTrust 三值分流（deny 无操作 → session 会话态 → always 落库）/
//   listDevServers probe 注入 + 失败透传 / updateSettings 净化（undefined 键清理 /
//   非数组名单丢弃 / 非法 trust 包装中文结构化错误不裸抛）+ 合法 patch 落库归一化。

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database as DB } from 'better-sqlite3';

vi.mock('../../src/main/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createBrowserSettingsStore } from '../../src/main/browser/settings-store';
import type { BrowserSettingsStore } from '../../src/main/browser/settings-store';
import { BrowserPolicy } from '../../src/main/browser/policy';
import { BrowserManager } from '../../src/main/browser/manager';
import type { ManagedView, ManagedWebContents, ViewFactory } from '../../src/main/browser/manager';
import {
  createBrowserPushHooks,
  registerBrowserIpc,
} from '../../src/main/browser/ipc';
import type { IpcMainLike, WebContentsLike } from '../../src/main/browser/ipc';
import { BrowserProtocolError } from '../../src/main/browser/errors';
import type { BrowserState } from '../../src/main/browser/types';

// =================================================================================
// mock 视图（照抄 manager.test.ts——事件参数序与真实 Electron 一致）
// =================================================================================

type Handler = (...args: unknown[]) => void;

interface MockView {
  view: ManagedView;
  handlers: Map<string, Handler>;
  emit: (ev: string, ...args: unknown[]) => void;
}

function mkMockView(): MockView {
  const handlers = new Map<string, Handler>();
  let currentUrl = '';
  let currentTitle = '';
  const webContents: ManagedWebContents = {
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    on: vi.fn((ev: string, fn: Handler) => {
      handlers.set(ev, fn);
    }),
    executeJavaScript: vi.fn(async () => null),
    sendInputEvent: vi.fn(),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('fake-png') })),
    setWindowOpenHandler: vi.fn((fn: Handler) => {
      handlers.set('--window-open', fn);
    }),
    reload: vi.fn(),
    getURL: () => currentUrl,
    getTitle: () => currentTitle,
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
  };
  const view: ManagedView = {
    webContents,
    bounds: { setBounds: vi.fn() },
  };
  return {
    view,
    handlers,
    emit: (ev, ...args) => handlers.get(ev)?.(...args),
  };
}

interface MockFactory extends ViewFactory {
  views: MockView[];
  destroy: Mock;
}

function mkFactory(): MockFactory {
  const views: MockView[] = [];
  return {
    views,
    create: vi.fn((_: string) => {
      const h = mkMockView();
      views.push(h);
      return h.view;
    }),
    destroy: vi.fn((v: ManagedView) => {
      void v;
    }),
    clearData: vi.fn(async () => undefined),
  };
}

// =================================================================================
// SUT 组装（真 db + 真 store/policy/manager；hooks 经 createBrowserPushHooks 接 send）
// =================================================================================

const tmpRoot = path.join(os.tmpdir(), `ap-browser-ipc-${process.pid}-${Date.now()}`);

let db: DB;
let store: BrowserSettingsStore;
let factory: MockFactory;
let manager: BrowserManager;
let probe: Mock;
/** channel → handler（事件参数序：handler(event, ...invokeArgs)） */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
/** webContentsLike.send 捕获（channel + 参数快照） */
const sends: Array<{ channel: string; args: unknown[] }> = [];
const webContentsLike: WebContentsLike = {
  send: (channel: string, ...args: unknown[]) => {
    sends.push({ channel, args });
  },
};
const ipcMainLike: IpcMainLike = {
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run();

  store = createBrowserSettingsStore(db);
  const policy = new BrowserPolicy((wsId) => store.read(wsId), '/ws/root');
  factory = mkFactory();
  manager = new BrowserManager(factory, policy, createBrowserPushHooks(webContentsLike));
  probe = vi.fn(async () => [{ port: 5173, url: 'http://localhost:5173' }]);

  handlers.clear();
  sends.length = 0;
  registerBrowserIpc(
    { manager, policy, store, probeDevServers: probe },
    ipcMainLike,
    webContentsLike,
  );
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 直呼 handler（模拟 renderer invoke；事件首参对 handler 不可见） */
async function callIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`通道未注册: ${channel}`);
  return (await h({ sender: 'fake' }, ...args)) as T;
}

/** 最近一次 browser:state 推送载荷 */
function lastState(): BrowserState | undefined {
  for (let i = sends.length - 1; i >= 0; i--) {
    const s = sends[i]!;
    if (s.channel === 'browser:state') return s.args[0] as BrowserState;
  }
  return undefined;
}

/** 激活 ws-1 并清空 activate 触发的推送（后续断言只看新事件） */
function activateWs(): void {
  manager.onWorkspaceActivated('ws-1', '/ws/ws-1');
  sends.length = 0;
}

// =================================================================================
// 通道注册
// =================================================================================

describe('registerBrowserIpc 通道注册', () => {
  it('12 通道（§3.6 表 11 通道 + updateSettings）全部注册，无多余通道', () => {
    const expected = [
      'browser:getState',
      'browser:userNavigate',
      'browser:takeover',
      'browser:releaseTakeover',
      'browser:openTab',
      'browser:closeTab',
      'browser:switchTab',
      'browser:setSidebarBounds',
      'browser:setSidebarCollapsed',
      'browser:answerTrust',
      'browser:listDevServers',
      'browser:updateSettings',
    ];
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
  });
});

// =================================================================================
// m→r 推送（hooks → webContents.send）
// =================================================================================

describe('browser:state / browser:notice 统一推送', () => {
  it('createBrowserPushHooks：pushState/pushNotice 一一映射到推送通道与载荷形状', () => {
    const hooks = createBrowserPushHooks(webContentsLike);
    const state: BrowserState = {
      workspaceId: 'ws-1',
      tabs: [],
      current: 0,
      url: '',
      title: '',
      takeover: 'agent',
      trusted: false,
    };
    hooks.pushState(state);
    hooks.pushNotice('trust-request', 'agent 请求使用浏览器');
    const st = sends.at(-2);
    const nt = sends.at(-1);
    expect(st?.channel).toBe('browser:state');
    expect(st?.args[0]).toBe(state);
    expect(nt).toEqual({
      channel: 'browser:notice',
      args: [{ kind: 'trust-request', text: 'agent 请求使用浏览器' }],
    });
  });

  it('workspace 激活经真实 manager 链路推出 browser:state——七字段载荷锁（ask 未授 → trusted=false）', () => {
    manager.onWorkspaceActivated('ws-1', '/ws/ws-1');
    const st = lastState();
    // toEqual 全量比对 = 字段集锁死（多字段/少字段/改名即刻红，momo-boundary-rules）
    expect(st).toEqual({
      workspaceId: 'ws-1',
      tabs: [],
      current: 0,
      url: '',
      title: '',
      takeover: 'agent',
      trusted: false,
    });
  });

  it('崩溃自愈经真实 manager 链路推出 browser:notice {kind:"crash-reloaded", text:中文}', async () => {
    activateWs();
    await callIpc('browser:userNavigate', 'ws-1', 'http://localhost:5173/');
    sends.length = 0;
    factory.views[0]!.emit('render-process-gone', { details: 'killed' });
    const nt = sends.at(-1);
    expect(nt?.channel).toBe('browser:notice');
    expect(nt?.args[0]).toEqual({
      kind: 'crash-reloaded',
      text: '页面渲染进程崩溃，已自动重载',
    });
  });
});

// =================================================================================
// browser:getState
// =================================================================================

describe('browser:getState', () => {
  it('非活跃 wsId → 空壳 state（workspaceId 回显 / trusted 按策略）', async () => {
    const st = await callIpc<BrowserState>('browser:getState', 'ws-other');
    expect(st).toEqual({
      workspaceId: 'ws-other',
      tabs: [],
      current: 0,
      url: '',
      title: '',
      takeover: 'agent',
      trusted: false,
    });
  });

  it('活跃 ws 打开页面后 → 完整状态（tabs/url/title）', async () => {
    activateWs();
    await callIpc('browser:userNavigate', 'ws-1', 'http://localhost:5173/');
    const st = await callIpc<BrowserState>('browser:getState', 'ws-1');
    expect(st.tabs).toEqual([{ index: 0, url: 'http://localhost:5173/', title: '' }]);
    expect(st.url).toBe('http://localhost:5173/');
    expect(st.current).toBe(0);
  });
});

// =================================================================================
// browser:userNavigate（隐式接管）
// =================================================================================

describe('browser:userNavigate', () => {
  it('地址栏回车 → 载入 URL + 隐式接管（takeover: agent → user）', async () => {
    activateWs();
    const res = await callIpc<{ url: string; title: string }>(
      'browser:userNavigate',
      'ws-1',
      'http://localhost:5173/',
    );
    expect(res).toEqual({ url: 'http://localhost:5173/', title: '' });
    expect(factory.views[0]!.view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
    // 隐式接管：推送状态中 takeover 已翻转为 user（§3.2 入口 2）
    const st = await callIpc<BrowserState>('browser:getState', 'ws-1');
    expect(st.takeover).toBe('user');
  });

  it('非法 URL → 拒绝且不产生接管副作用（takeover 仍 agent）', async () => {
    activateWs();
    await expect(callIpc('browser:userNavigate', 'ws-1', 'ftp://example.com/')).rejects.toThrow(
      BrowserProtocolError,
    );
    const st = await callIpc<BrowserState>('browser:getState', 'ws-1');
    expect(st.takeover).toBe('agent');
  });
});

// =================================================================================
// browser:takeover / browser:releaseTakeover
// =================================================================================

describe('browser:takeover / releaseTakeover', () => {
  it('显式接管与释放往返（state 推送随行）', async () => {
    activateWs();
    await callIpc('browser:takeover', 'ws-1');
    expect(lastState()?.takeover).toBe('user');
    await callIpc('browser:releaseTakeover', 'ws-1');
    expect(lastState()?.takeover).toBe('agent');
  });
});

// =================================================================================
// tabs 三通道
// =================================================================================

describe('browser:openTab / closeTab / switchTab', () => {
  it('open ×2 → close → switch 返回 TabInfo[] 且状态一致', async () => {
    activateWs();
    let tabs = await callIpc<Array<{ index: number; url: string; title: string }>>(
      'browser:openTab',
      'ws-1',
      'http://localhost:5173/',
    );
    expect(tabs).toHaveLength(1);
    tabs = await callIpc('browser:openTab', 'ws-1', 'http://localhost:3000/');
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({ index: 1, url: 'http://localhost:3000/', title: '' });

    tabs = await callIpc('browser:closeTab', 'ws-1', 1);
    expect(tabs).toHaveLength(1);

    tabs = await callIpc('browser:switchTab', 'ws-1', 0);
    expect(tabs).toHaveLength(1);
    const st = await callIpc<BrowserState>('browser:getState', 'ws-1');
    expect(st.current).toBe(0);
  });
});

// =================================================================================
// browser:setSidebarBounds
// =================================================================================

describe('browser:setSidebarBounds', () => {
  it('占位区 rect 原样透传到当前视图 setBounds', async () => {
    activateWs();
    await callIpc('browser:userNavigate', 'ws-1', 'http://localhost:5173/');
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    await callIpc('browser:setSidebarBounds', rect);
    expect(factory.views[0]!.view.bounds.setBounds).toHaveBeenCalledWith(rect);
  });

  it('rect 字段缺失 → 中文错误拒绝（IPC 无类型边界防线）', async () => {
    await expect(callIpc('browser:setSidebarBounds', { x: 1 })).rejects.toThrow(
      'browser:setSidebarBounds 参数 rect 需含 x/y/width/height 四个数字',
    );
  });
});

// =================================================================================
// browser:setSidebarCollapsed
// =================================================================================

describe('browser:setSidebarCollapsed', () => {
  it('折叠 → 视图销毁 + 折叠态落库（spec §3.6）', async () => {
    activateWs();
    await callIpc('browser:openTab', 'ws-1', 'http://localhost:5173/');
    await callIpc('browser:setSidebarCollapsed', 'ws-1', true);
    expect(factory.destroy).toHaveBeenCalledTimes(1);
    expect(store.read('ws-1').sidebarCollapsed).toBe(true);
  });
});

// =================================================================================
// browser:answerTrust（三值分流）
// =================================================================================

describe('browser:answerTrust 三值分流', () => {
  it('deny → 无操作（不落库 / 会话不放行）；session → 会话放行不落库；always → 落库', async () => {
    activateWs();

    // 基线：ask 未授 → trusted=false
    expect((await callIpc<BrowserState>('browser:getState', 'ws-1')).trusted).toBe(false);

    // deny：信任卡「拒绝」——无操作
    await callIpc('browser:answerTrust', 'ws-1', 'deny');
    expect((await callIpc<BrowserState>('browser:getState', 'ws-1')).trusted).toBe(false);
    expect(store.read('ws-1').trust).toBe('ask');

    // session：本会话放行（内存态，不落库）
    await callIpc('browser:answerTrust', 'ws-1', 'session');
    expect((await callIpc<BrowserState>('browser:getState', 'ws-1')).trusted).toBe(true);
    expect(store.read('ws-1').trust).toBe('ask');

    // always：写入设置（落库），策略读侧即时生效
    await callIpc('browser:answerTrust', 'ws-1', 'always');
    expect(store.read('ws-1').trust).toBe('always');
    expect((await callIpc<BrowserState>('browser:getState', 'ws-1')).trusted).toBe(true);
  });

  it('非法应答值 → 中文错误拒绝（不落入任何分支）', async () => {
    await expect(callIpc('browser:answerTrust', 'ws-1', 'forever')).rejects.toThrow(
      'browser:answerTrust 应答必须是 session / always / deny',
    );
    expect(store.read('ws-1').trust).toBe('ask');
  });
});

// =================================================================================
// browser:listDevServers（注入 probe）
// =================================================================================

describe('browser:listDevServers', () => {
  it('返回注入 probe 的结果（T10 前接口注入，真实现后端到端）', async () => {
    const servers = await callIpc<Array<{ port: number; url: string }>>(
      'browser:listDevServers',
    );
    expect(servers).toEqual([{ port: 5173, url: 'http://localhost:5173' }]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probe 失败 → 拒绝透传（renderer「未发现」路径）', async () => {
    registerBrowserIpc(
      {
        manager,
        policy: new BrowserPolicy((wsId) => store.read(wsId), '/ws/root'),
        store,
        probeDevServers: vi.fn(async () => {
          throw new Error('probe 网络错误');
        }),
      },
      ipcMainLike,
      webContentsLike,
    );
    await expect(callIpc('browser:listDevServers')).rejects.toThrow('probe 网络错误');
  });
});

// =================================================================================
// browser:updateSettings（T6 review Important：净化 + 结构化错误，硬性项）
// =================================================================================

describe('browser:updateSettings 入参净化', () => {
  it('合法 patch → ok:true 落库（域名条目经真 store 归一化）', async () => {
    const res = await callIpc<{ ok: boolean }>('browser:updateSettings', 'ws-1', {
      trust: 'always',
      evaluateEnabled: true,
      blacklist: [' https://Evil.com:443 ', ''],
    });
    expect(res.ok).toBe(true);
    const s = store.read('ws-1');
    expect(s.trust).toBe('always');
    expect(s.evaluateEnabled).toBe(true);
    // 归一化：去 scheme / 去端口 / trim / 小写 / 丢空（真 store 写侧行为，非 mock）
    expect(s.blacklist).toEqual(['evil.com']);
  });

  it('【专项 1】显式 undefined 键被清理——不触发 normalizeDomainList(undefined) 英文 TypeError', async () => {
    // 无净化时：patch.blacklist=undefined 合并后 merged.blacklist=undefined →
    // .map 抛英文 TypeError（T6 review 指出的边界防线缺口）
    const res = await callIpc<{ ok: boolean; error?: string }>('browser:updateSettings', 'ws-1', {
      trust: undefined,
      blacklist: undefined,
      whitelist: undefined,
      evaluateEnabled: true,
    });
    expect(res.ok).toBe(true);
    const s = store.read('ws-1');
    // 未给的字段保持既有值（undefined 不覆盖、不篡改 trust）
    expect(s.trust).toBe('ask');
    expect(s.blacklist).toEqual([]);
    expect(s.whitelist).toEqual([]);
    expect(s.evaluateEnabled).toBe(true);
  });

  it('【专项 2】非数组名单键被丢弃——其余键仍生效，整体不失败', async () => {
    const res = await callIpc<{ ok: boolean; error?: string }>('browser:updateSettings', 'ws-1', {
      blacklist: 'oops-not-array',
      whitelist: 42,
      trust: 'deny',
    });
    expect(res.ok).toBe(true);
    const s = store.read('ws-1');
    expect(s.blacklist).toEqual([]);
    expect(s.whitelist).toEqual([]);
    expect(s.trust).toBe('deny');
  });

  it('非法 trust 枚举 → { ok:false, error:中文 }（IPC 边界不裸抛；不落库）', async () => {
    const res = await callIpc<{ ok: boolean; error?: string }>('browser:updateSettings', 'ws-1', {
      trust: 'sometimes',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('非法信任级别');
    // store 写侧唯一防线兜底后：设置未被篡改
    expect(store.read('ws-1').trust).toBe('ask');
  });

  it('非对象 patch → ok:true 空改（净化为空 patch，不 throw）', async () => {
    const res = await callIpc<{ ok: boolean }>('browser:updateSettings', 'ws-1', null);
    expect(res.ok).toBe(true);
    expect(store.read('ws-1').trust).toBe('ask');
  });
});
