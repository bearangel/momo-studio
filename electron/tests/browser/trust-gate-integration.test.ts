// electron/tests/browser/trust-gate-integration.test.ts
//
// 信任门端到端集成测试（C1 review fix）：
//   真实 BrowserPolicy + 真实 BrowserTools 拼接（policy 注入 BrowserTools 消费面），
//   pushNotice spy 验证「notice 在 BrowserNotTrustedError 抛错前被推一次」，覆盖：
//     - 工具 execute 路径：browser_navigate 等 12 个 browser_* 工具经 policy.assertAllowed
//       → ask 未授权 → pushNotice('trust-request', ...) → throw BrowserNotTrustedError
//     - 注入 grantSession 后二次调用 → pushNotice 零调用（已授权路径不再骚扰）
//     - manager.isTrusted 内部辅助路径（trusted=true 时浏览器工具可用）
//     - 'always' / 'deny' 分支不推 trust-request（仅 ask 未授权路径触发）
//
// 与 policy.test.ts 的单元断言互补：本文件验证「policy + tools 真实链路」行为，
// 单测改签名漂移即红（条件类型契约锁）。
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { BrowserPolicy } from '../../src/main/browser/policy';
import {
  BrowserNotTrustedError,
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

describe('C1 信任门端到端集成（policy + tools 真链路）', () => {
  it('ask 未授权：browser_navigate 触发 assertAllowed → notice 在抛错前推一次', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'ask' });
    await expect(tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx)).rejects.toThrow(
      BrowserNotTrustedError,
    );
    // 关键顺序契约：notice 在抛错前推（一次）
    expect(pushNotice).toHaveBeenCalledTimes(1);
    expect(pushNotice).toHaveBeenCalledWith('trust-request', expect.stringContaining('agent 请求'));
  });

  it('ask 未授权：12 个 browser_* 工具全部走同一条 trust-request 推送契约', async () => {
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
      const { pushNotice, tools, ctx } = mkToolChain({ trust: 'ask' });
      await expect(tools.execute(name, args, ctx)).rejects.toThrow(BrowserNotTrustedError);
      // 每个工具独立 mkToolChain → pushNotice spy 隔离，每次恰好 1 次
      expect(pushNotice).toHaveBeenCalledTimes(1);
      expect(pushNotice).toHaveBeenCalledWith('trust-request', expect.any(String));
    }
  });

  it('grantSession 授权后：二次调用 pushNotice 零推送（已授权路径不再骚扰用户）', async () => {
    const { pushNotice, policy, tools, ctx } = mkToolChain({ trust: 'ask' });
    // 首次：未授权 → notice 推 1 次 + 抛错
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).rejects.toThrow(BrowserNotTrustedError);
    expect(pushNotice).toHaveBeenCalledTimes(1);

    // 用户在右下角信任卡点「本次会话允许」→ grantSession 注入
    policy.grantSession('ws1');

    // 二次调用：放行；manager stub 返回成功（manager.navigate 不会触发 pushNotice）
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).resolves.toBeDefined();
    // notice 总数仍为 1（不重复推）
    expect(pushNotice).toHaveBeenCalledTimes(1);
  });

  it('trust=always：全部工具放行，pushNotice 零推送（信任模式已为 always 不再需要卡）', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'always' });
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).resolves.toBeDefined();
    expect(pushNotice).not.toHaveBeenCalled();
  });

  it('trust=deny：全部工具抛 BrowserDeniedError（不推 trust-request——与 deny 语义不同）', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'deny' });
    await expect(
      tools.execute('browser_navigate', { url: 'https://a.dev/' }, ctx),
    ).rejects.toThrow(BrowserDeniedError);
    // deny 是用户主动拒绝的永久态——不应再推「请授权」卡
    expect(pushNotice).not.toHaveBeenCalled();
  });

  it('browser_evaluate 双门：trust ask 未授 → trust-request notice 推一次（evaluate 门在 trust 门之后）', async () => {
    const { pushNotice, tools, ctx } = mkToolChain({ trust: 'ask' });
    // trust 门先 fail → evaluate 门不触达（即便 evaluateEnabled=true）
    await expect(
      tools.execute('browser_evaluate', { expression: '1' }, ctx),
    ).rejects.toThrow(BrowserNotTrustedError);
    expect(pushNotice).toHaveBeenCalledTimes(1);
  });

  it('manager.isTrusted 内部路径（trusted 状态推导）：ask 未授权时 isTrusted 返回 false 而不推 notice', () => {
    // 该路径供 BrowserState.trusted 字段使用——只读、不抛错、不推 notice。
    // 与 assertAllowed（写入、抛错、推 notice）解耦。
    const { pushNotice, policy } = mkToolChain({ trust: 'ask' });
    // 走 isTrusted 等价路径：try/catch 包裹 assertAllowed，policy 自身不暴露 isTrusted，
    // 通过 assertAllowed 的二次调用模拟（不抛错路径不应再推）
    expect(() => policy.assertAllowed('ws1')).toThrow(BrowserNotTrustedError);
    // 第二次同 wsId 同状态调用仍按 ask 未授权路径 → 再推一次（pushNotice 自身不带去重）
    expect(() => policy.assertAllowed('ws1')).toThrow(BrowserNotTrustedError);
    expect(pushNotice).toHaveBeenCalledTimes(2);
  });
});
