// electron/tests/browser/trust-gate-integration.test.ts
//
// 信任门端到端集成测试（阻塞等待语义）：
//   真实 BrowserPolicy + 真实 BrowserTools 拼接（policy 注入 BrowserTools 消费面），
//   覆盖：
//     - 工具 execute 路径：browser_navigate 等 12 个 browser_* 工具经 policy.assertAllowed
//       → ask 未授权 → 推 trust-request notice 后阻塞等待（不立即失败）；
//       用户应答直接驱动工具调用走向：allow → 继续执行；deny → BrowserTrustRefusedError；
//       3 分钟超时 → 超时文案降级拒绝
//     - 等待中授权（grantSession + resolveTrustWait）后二次调用 → 快路径零新卡
//     - manager 状态推送路径（getState / did-navigate 等）：trusted 推导零副作用，
//       pushNotice 零推送（N1——trust notice 副作用只属于 agent 门）
//     - 'always' / 'deny' 分支不推 trust-request 也不等待（快路径）
//
// 与 policy.test.ts 的单元断言互补：本文件验证「policy + tools 真实链路」行为，
// 单测改签名漂移即红（条件类型契约锁）。
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { BrowserPolicy } from '../../src/main/browser/policy';
import { BrowserManager } from '../../src/main/browser/manager';
import type { ManagedView, ManagedWebContents, ViewFactory } from '../../src/main/browser/manager';
import {
  BrowserTrustRefusedError,
  BrowserDeniedError,
} from '../../src/main/browser/errors';
import {
  BrowserTools,
  initBrowserTools,
  __resetBrowserToolsForTest,
} from '../../src/main/agent/tools/browser-tools';
import type { ToolContext } from '../../src/main/agent/tools/types';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';

/** trust-gate 路径最小 ctx 桩：聚焦策略门验证，工具实际不触达 fs / skill / stream */
function mkMinimalCtx(): ToolContext {
  return {
    wsFs: {} as never,
    workspaceId: 'ws1',
    workspaceDir: '/ws/root',
    skillRegistry: {} as never,
    streamSessionId: 'sess-1',
    roomId: 'room-1',
    sendStreamChunk: () => {},
    permissionConfig: {} as never,
    creatorUserId: 'user-1',
  };
}

const baseSettings = (): WorkspaceBrowserSettings => ({
  trust: 'ask',
  evaluateEnabled: false,
  blacklist: [],
  whitelist: [],
});

/** manager 真实链路所需的最小 Electron 视图 mock——完整 ManagedWebContents 结构面
 * （接口演进时 typecheck 强制同步，防 mock 漂移）；事件注册/触发与真实 Electron 同形 */
function mkMockView(): { view: ManagedView; emit: (ev: string) => void } {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let url = '';
  const webContents: ManagedWebContents = {
    loadURL: async (u: string) => {
      url = u;
    },
    on: (ev, fn) => handlers.set(ev, fn),
    executeJavaScript: async () => null,
    sendInputEvent: () => {},
    capturePage: async () => ({ toPNG: () => Buffer.from('x') }),
    setWindowOpenHandler: () => ({ action: 'deny' }),
    reload: () => {},
    getURL: () => url,
    getTitle: () => '',
    debugger: { attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
  };
  return {
    view: { webContents, bounds: { setBounds: () => {} } },
    emit: (ev) => handlers.get(ev)?.(),
  };
}

/** 拼接 BrowserPolicy + pushNotice spy + BrowserTools（policy 注入端口） */
function mkToolChain(over: Partial<WorkspaceBrowserSettings> = {}): {
  pushNotice: Mock;
  policy: BrowserPolicy;
  tools: BrowserTools;
  ctx: ToolContext;
} {
  const pushNotice = vi.fn();
  const settings = { ...baseSettings(), ...over };
  const policy = new BrowserPolicy(() => settings, '/ws/root', pushNotice);
  // BrowserTools 注入面只消费 assertAllowed/assertEvaluate——manager 用 noop stub
  // （trust-gate 测试聚焦策略门，工具内部 manager 不会触达）
  const managerStub = {
    navigate: vi.fn(async () => ({ url: 'https://a.dev/', title: 'A' })),
    snapshot: vi.fn(async () => ''),
    screenshot: vi.fn(async () => ({ path: '/tmp/x.png' })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    pressKey: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ ok: 1 })),
    consoleMessages: vi.fn(async () => []),
    tabsAction: vi.fn(async () => []),
    closeBrowser: vi.fn(async () => {}),
  };
  initBrowserTools(policy, managerStub);
  const tools = new BrowserTools();
  const ctx = mkMinimalCtx();
  return { pushNotice, policy, tools, ctx };
}

beforeEach(() => {
  __resetBrowserToolsForTest();
});

describe('信任门端到端集成（policy + tools 真链路——阻塞等待语义）', () => {
  /** 排空一拍宏任务（含微任务队列）后断言仍未 settle：agent 在等用户点击 */
  async function assertPending(p: Promise<unknown>): Promise<void> {
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  }

  it('ask 未授权：browser_navigate 阻塞等待 + notice 在挂起前推一次；用户拒绝 → BrowserTrustRefusedError', async () => {
    const { pushNotice, policy, tools, ctx } = mkToolChain({ trust: 'ask' });
    const exec = tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx);
    // 阻塞语义核心：工具调用不立即失败，挂起等待用户决定
    await assertPending(exec);
    // 契约：notice 在进入等待前推（一次）；载荷携带 wsId（M7 路由）+ 等待文案
    expect(pushNotice).toHaveBeenCalledTimes(1);
    expect(pushNotice).toHaveBeenCalledWith(
      'trust-request',
      expect.stringContaining('正在等待你授权'),
      'ws1',
    );
    // 用户点「取消」→ 工具以「用户已拒绝」失败，LLM 拿到明确事实自行改道
    policy.resolveTrustWait('ws1', 'deny');
    await expect(exec).rejects.toThrow(BrowserTrustRefusedError);
  });

  it('ask 未授权：12 个 browser_* 工具全部阻塞等待同一张卡；拒绝后全部 BrowserTrustRefusedError', async () => {
    const sampleArgs: Record<string, Record<string, unknown>> = {
      browser_navigate: { url: 'https://a.dev/' },
      browser_snapshot: {},
      browser_screenshot: {},
      browser_click: { selector: 'button' },
      browser_type: { selector: 'input', text: 'x' },
      browser_press_key: { key: 'Enter' },
      browser_hover: { selector: 'div' },
      browser_scroll: { direction: 'down' },
      browser_evaluate: { expression: '1' },
      browser_console_messages: {},
      browser_tabs: { action: 'list' },
      browser_close: {},
    };
    for (const [name, args] of Object.entries(sampleArgs)) {
      const { pushNotice, policy, tools, ctx } = mkToolChain({ trust: 'ask' });
      const exec = tools.execute(name, args, ctx);
      await assertPending(exec);
      // 每个工具独立 mkToolChain → pushNotice spy 隔离，每次恰好 1 次；wsId 携带
      expect(pushNotice).toHaveBeenCalledTimes(1);
      expect(pushNotice).toHaveBeenCalledWith('trust-request', expect.any(String), 'ws1');
      policy.resolveTrustWait('ws1', 'deny');
      await expect(exec).rejects.toThrow(BrowserTrustRefusedError);
    }
  });

  it('等待中用户「本次会话允许」→ 挂起的工具调用继续执行成功；二次调用快路径零新卡', async () => {
    const { pushNotice, policy, tools, ctx } = mkToolChain({ trust: 'ask' });
    const exec = tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx);
    await assertPending(exec);
    expect(pushNotice).toHaveBeenCalledTimes(1);

    // 用户点「本次会话允许」——answerTrust('session') 语义：grantSession + 唤醒等待
    policy.grantSession('ws1');
    policy.resolveTrustWait('ws1', 'allow');

    // 授权与执行挂钩：挂起中的同一次调用继续执行（manager stub 返回成功）
    await expect(exec).resolves.toBeDefined();
    // 二次调用：快路径放行，notice 总数仍为 1（不重复推）
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).resolves.toBeDefined();
    expect(pushNotice).toHaveBeenCalledTimes(1);
  });

  it('等待超时（3 分钟）→ 工具以超时文案失败（降级拒绝 + 设置/重试指引）', async () => {
    vi.useFakeTimers();
    try {
      const { tools, ctx } = mkToolChain({ trust: 'ask' });
      const exec = tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx);
      // 预挂观察者：rejection 在推进计时器时发生，先附 handler 防 unhandledRejection 误报
      const observed = exec.then(
        () => {
          throw new Error('应当 reject');
        },
        (e: Error) => e,
      );
      await vi.advanceTimersByTimeAsync(180_000);
      const err = await observed;
      expect(err).toBeInstanceOf(BrowserTrustRefusedError);
      expect(err.message).toMatch(/等待浏览器授权超时/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('trust=always：全部工具放行，pushNotice 零推送（信任模式已为 always 不再需要卡）', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'always' });
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).resolves.toBeDefined();
    expect(pushNotice).not.toHaveBeenCalled();
  });

  it('trust=deny：全部工具直接抛 BrowserDeniedError（不推卡、不等待——用户主动拒绝的永久态）', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'deny' });
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).rejects.toThrow(BrowserDeniedError);
    expect(pushNotice).not.toHaveBeenCalled();
  });

  it('browser_evaluate 双门：trust 等待未决 → evaluate 门不触达；拒绝后以 BrowserTrustRefusedError 失败', async () => {
    const { policy, tools, ctx } = mkToolChain({ trust: 'ask' });
    const evalSpy = vi.spyOn(policy, 'assertEvaluate');
    const exec = tools.execute('browser_evaluate', { expression: '1' }, ctx);
    await assertPending(exec);
    expect(evalSpy).not.toHaveBeenCalled(); // 信任门未过，evaluate 门未触达
    policy.resolveTrustWait('ws1', 'deny');
    await expect(exec).rejects.toThrow(BrowserTrustRefusedError);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('manager 状态推送路径（getState / emitState）：ask 未授 → trusted=false 且 pushNotice 零推送（N1）', async () => {
    // N1 回归锁：BrowserState.trusted 推导必须零副作用。泄漏面 = getState（侧栏挂载）+
    // buildState→emitState 约 15 处（did-navigate / did-navigate-in-page / page-title-updated 等）。
    // 真实 BrowserManager + 真实 BrowserPolicy（ask 未授）拼接，mock 收窄在 Electron 视图边界
    // （与 manager.test.ts 同形，momo-test-rules）。状态推导若误触阻塞等待面，本例必红/吊死。
    const pushNotice = vi.fn();
    const policy = new BrowserPolicy(() => ({ ...baseSettings(), trust: 'ask' }), '/ws/root', pushNotice);
    const view = mkMockView();
    const factory: ViewFactory = {
      create: () => view.view,
      destroy: () => {},
      clearData: async () => {},
    };
    const pushState = vi.fn();
    const manager = new BrowserManager(factory, policy, { pushState, pushNotice });

    manager.onWorkspaceActivated('ws1', '/ws/ws1');
    // user 路径不过信任门是设计行为（agent 门在 tools 层）——manager.navigate 只过 assertUrl
    await manager.navigate('ws1', 'http://localhost:5173/');
    view.emit('did-navigate');
    view.emit('did-navigate-in-page');
    view.emit('page-title-updated');
    const st = manager.getState('ws1');

    expect(st.trusted).toBe(false);
    // 零推送——trust notice 副作用只属于 agent 门（assertAllowed），绝不泄漏进状态推送
    expect(pushNotice).not.toHaveBeenCalled();
  });
});
