// electron/tests/agent/tools/browser-tools.test.ts
// v2.7.0 McpBrowser Task 5：BrowserTools——12 工具 ToolModule + 注册 + 门控。
// 覆盖（brief Step 1）：
//   - getDefs 12 条定义齐全（名字 + 必填 schema：navigate.url / type.selector+text /
//     scroll.direction enum / tabs.action enum；描述文案要点：file://、滚动+快照组合、
//     evaluate 默认禁用提示）
//   - handles 恰好覆盖 12 名（非本模块工具 false）
//   - execute 路由：每个工具名 → manager 对应方法被调（参数透传：type 的 submit、
//     scroll 的 amount 缺省、tabs 的 index/url）
//   - 门控顺序锁：每次 execute 先 policy.assertAllowed（未信任时 manager 全部 12 个
//     方法零调用）；evaluate 额外 assertEvaluate（assertAllowed 先行）；其余 11 工具
//     绝不触碰 assertEvaluate
//   - takeover / policy 错误原样穿透（同一 Error 实例）
//   - screenshot filename 清洗：'../../x' → basename + 无扩展名补 .png
//   - scroll amount 工具层校验：正整数、上限 20 钳制、非法值不透传 manager
//   - browser_close 后 browser_navigate 仍直接透传 manager（懒重建语义 T2 已锁）
//   - 未 initBrowserTools 防御：12 工具全部拒绝（注册中心构建不依赖 deps）
//   - 契约锁：真实 BrowserManager / BrowserPolicy 结构性满足注入端口（编译期）
// mock 仿真真实运行时语义（momo-test-rules）：manager mock 方法签名/返回形态与
// T2 真实实现一致（navigate→{url,title} / snapshot→string / screenshot→{path} /
// tabsAction→TabInfo[] 等）；policy 错误抛真实 BrowserError 子类实例。

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  BrowserTools,
  initBrowserTools,
  __resetBrowserToolsForTest,
  type BrowserManagerPort,
  type BrowserPolicyPort,
} from '../../../src/main/agent/tools/browser-tools';
import { buildToolRegistry, getAllToolDefs, executeTool } from '../../../src/main/agent/tools/index';
import type { LLMToolDef } from '../../../src/main/agent/llm-provider';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import type { TabInfo } from '../../../src/main/browser/types';
import type { BrowserManager } from '../../../src/main/browser/manager';
import type { BrowserPolicy } from '../../../src/main/browser/policy';
import {
  BrowserNotTrustedError,
  BrowserTakenOverError,
  EvaluateDisabledError,
} from '../../../src/main/browser/errors';

// =================================================================================
// 常量与夹具
// =================================================================================

/** spec §4 的 12 个工具名（顺序即表中序） */
const TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_scroll',
  'browser_evaluate',
  'browser_console_messages',
  'browser_tabs',
  'browser_close',
] as const;

type BrowserToolName = (typeof TOOL_NAMES)[number];

/** 每个工具的最小合法参数（门控循环 / 未 init 循环共用） */
const SAMPLE_ARGS: Record<BrowserToolName, Record<string, unknown>> = {
  browser_navigate: { url: 'https://a.dev' },
  browser_snapshot: {},
  browser_screenshot: {},
  browser_click: { selector: '#btn' },
  browser_type: { selector: '#q', text: 'hi' },
  browser_press_key: { key: 'Enter' },
  browser_hover: { selector: '#btn' },
  browser_scroll: { direction: 'down' },
  browser_evaluate: { expression: '1+1' },
  browser_console_messages: {},
  browser_tabs: { action: 'list' },
  browser_close: {},
};

/** manager mock——成员类型收窄为 vitest Mock（可断言调用），接口 extends 保证签名与 T2 真实一致 */
interface ManagerMock extends BrowserManagerPort {
  navigate: Mock;
  snapshot: Mock;
  screenshot: Mock;
  click: Mock;
  type: Mock;
  pressKey: Mock;
  hover: Mock;
  scroll: Mock;
  evaluate: Mock;
  consoleMessages: Mock;
  tabsAction: Mock;
  closeBrowser: Mock;
}

/**
 * manager mock——签名与返回形态对齐 T2 真实 BrowserManager（momo-test-rules：
 * mock 仿真真实运行时语义；返回值形态与 manager.ts 实际返回逐一对应）。
 */
function mkManagerMock(): ManagerMock {
  return {
    navigate: vi.fn(
      async (_wsId: string, _rawUrl: string) => ({ url: 'https://a.dev/', title: 'A 页面' }),
    ),
    snapshot: vi.fn(async (_wsId: string) => '- button "确定" [aria/role=button 名称=确定]'),
    screenshot: vi.fn(
      async (_wsId: string, _filename?: string) => ({ path: '/tmp/momo-browser-shots/ws1/shot.png' }),
    ),
    click: vi.fn(async (_wsId: string, _selector: string) => {}),
    type: vi.fn(async (_wsId: string, _selector: string, _text: string, _submit?: boolean) => {}),
    pressKey: vi.fn(async (_wsId: string, _key: string) => {}),
    hover: vi.fn(async (_wsId: string, _selector: string) => {}),
    scroll: vi.fn(async (_wsId: string, _direction: 'up' | 'down', _amount?: number) => {}),
    evaluate: vi.fn(async (_wsId: string, _expression: string) => ({ n: 1 })),
    consoleMessages: vi.fn(async (_wsId: string) => ['[info] hello', '[error] boom']),
    tabsAction: vi.fn(
      async (
        _wsId: string,
        _action: 'list' | 'open' | 'close' | 'switch',
        _index?: number,
        _url?: string,
      ): Promise<TabInfo[]> => [{ index: 0, url: 'https://a.dev/', title: 'A 页面' }],
    ),
    closeBrowser: vi.fn(async (_wsId: string) => {}),
  };
}

/** policy mock——工具层只消费 assertAllowed / assertEvaluate（真实 BrowserPolicy 的消费面） */
interface PolicyMock extends BrowserPolicyPort {
  assertAllowed: Mock;
  assertEvaluate: Mock;
}

function mkPolicyMock(): PolicyMock {
  return {
    assertAllowed: vi.fn((_wsId: string) => {}),
    assertEvaluate: vi.fn((_wsId: string) => {}),
  };
}

let managerMock: ManagerMock;
let policyMock: PolicyMock;
let tools: BrowserTools;
let ctx: ToolContext;

beforeEach(() => {
  __resetBrowserToolsForTest();
  managerMock = mkManagerMock();
  policyMock = mkPolicyMock();
  initBrowserTools(policyMock, managerMock);
  tools = new BrowserTools();
  ctx = {
    wsFs: {} as never,
    workspaceId: 'ws1',
    workspaceDir: '/tmp/ws1',
    skillRegistry: {} as never,
    streamSessionId: 'ssn-agent-1',
    roomId: 'room-1',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'u1',
  };
});

// =================================================================================
// 契约锁（跨模块对接面——momo-test-rules 第 4 条）
// =================================================================================

describe('契约锁', () => {
  it('真实 BrowserManager / BrowserPolicy 结构性满足注入端口（T2/T1 改签名漂移即编译红）', () => {
    // 条件类型不成立时落入 never，'yes' 赋值编译失败——锁住端口与真实实现的对接面
    const managerOk: BrowserManager extends BrowserManagerPort ? 'yes' : never = 'yes';
    const policyOk: BrowserPolicy extends BrowserPolicyPort ? 'yes' : never = 'yes';
    expect(managerOk).toBe('yes');
    expect(policyOk).toBe('yes');
  });
});

// =================================================================================
// getDefs / handles
// =================================================================================

describe('getDefs——12 条定义齐全', () => {
  let defs: LLMToolDef[];

  beforeEach(() => {
    defs = tools.getDefs();
  });

  it('恰好 12 条，名字与 spec §4 完全一致', () => {
    expect(defs).toHaveLength(12);
    expect(defs.map((d) => d.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('每条都有中文描述', () => {
    for (const d of defs) {
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(10);
    }
  });

  it('navigate：url 必填，描述含 http 与 workspace 内 file:// 提示', () => {
    const def = defs.find((d) => d.name === 'browser_navigate')!;
    expect(requiredOf(def)).toContain('url');
    expect(propOf(def, 'url')?.type).toBe('string');
    expect(def.description).toContain('http');
    expect(def.description).toContain('file://');
  });

  it('type：selector + text 必填，submit 为 boolean', () => {
    const def = defs.find((d) => d.name === 'browser_type')!;
    const required = requiredOf(def);
    expect(required).toContain('selector');
    expect(required).toContain('text');
    expect(propOf(def, 'submit')?.type).toBe('boolean');
  });

  it('scroll：direction 必填且 enum 恰为 up/down；amount 为 number', () => {
    const def = defs.find((d) => d.name === 'browser_scroll')!;
    expect(requiredOf(def)).toContain('direction');
    expect(propOf(def, 'direction')?.enum).toEqual(['up', 'down']);
    expect(propOf(def, 'amount')?.type).toBe('number');
  });

  it('tabs：action 必填且 enum 恰为 list/open/close/switch', () => {
    const def = defs.find((d) => d.name === 'browser_tabs')!;
    expect(requiredOf(def)).toContain('action');
    expect(propOf(def, 'action')?.enum).toEqual(['list', 'open', 'close', 'switch']);
  });

  it('click / press_key / evaluate：selector / key / expression 必填', () => {
    expect(requiredOf(defs.find((d) => d.name === 'browser_click')!)).toContain('selector');
    expect(requiredOf(defs.find((d) => d.name === 'browser_press_key')!)).toContain('key');
    expect(requiredOf(defs.find((d) => d.name === 'browser_evaluate')!)).toContain('expression');
  });

  it('evaluate 描述注明「默认可能被设置禁用，报错时提示用户开启」', () => {
    const def = defs.find((d) => d.name === 'browser_evaluate')!;
    expect(def.description).toContain('禁用');
    expect(def.description).toContain('开启');
  });

  it('snapshot / scroll 描述包含长页面阅读的滚动+快照组合指引', () => {
    const snapshot = defs.find((d) => d.name === 'browser_snapshot')!;
    const scroll = defs.find((d) => d.name === 'browser_scroll')!;
    expect(snapshot.description).toContain('browser_scroll');
    expect(scroll.description).toContain('browser_snapshot');
  });
});

describe('handles', () => {
  it('恰好覆盖 12 名', () => {
    for (const name of TOOL_NAMES) expect(tools.handles(name)).toBe(true);
  });

  it('非本模块工具一律 false', () => {
    for (const name of ['webfetch', 'git_status', 'browser_bogus', 'browser', '']) {
      expect(tools.handles(name)).toBe(false);
    }
  });
});

// =================================================================================
// execute 路由与参数透传
// =================================================================================

describe('execute 路由透传', () => {
  it('browser_navigate → manager.navigate(wsId, url)，结果含最终 URL 与标题', async () => {
    const result = await tools.execute('browser_navigate', { url: 'https://a.dev' }, ctx);
    expect(managerMock.navigate).toHaveBeenCalledTimes(1);
    expect(managerMock.navigate).toHaveBeenCalledWith('ws1', 'https://a.dev');
    expect(result).toContain('https://a.dev/');
    expect(result).toContain('A 页面');
  });

  it('browser_snapshot → manager.snapshot(wsId)，a11y 文本原样返回', async () => {
    const result = await tools.execute('browser_snapshot', {}, ctx);
    expect(managerMock.snapshot).toHaveBeenCalledWith('ws1');
    expect(result).toContain('button');
    expect(result).toContain('aria/');
  });

  it('browser_screenshot 无 filename → manager.screenshot(wsId, undefined)，结果含保存路径', async () => {
    const result = await tools.execute('browser_screenshot', {}, ctx);
    expect(managerMock.screenshot).toHaveBeenCalledWith('ws1', undefined);
    expect(result).toContain('/tmp/momo-browser-shots/ws1/shot.png');
  });

  it('browser_click → manager.click(wsId, selector)', async () => {
    await tools.execute('browser_click', { selector: '#btn' }, ctx);
    expect(managerMock.click).toHaveBeenCalledWith('ws1', '#btn');
  });

  it('browser_type submit=true → manager.type 第四参透传 true，结果注明已提交', async () => {
    const result = await tools.execute(
      'browser_type',
      { selector: '#q', text: 'momo', submit: true },
      ctx,
    );
    expect(managerMock.type).toHaveBeenCalledWith('ws1', '#q', 'momo', true);
    expect(result).toContain('提交');
  });

  it('browser_type 缺省 submit → manager.type 第四参 undefined', async () => {
    await tools.execute('browser_type', { selector: '#q', text: 'momo' }, ctx);
    expect(managerMock.type).toHaveBeenCalledWith('ws1', '#q', 'momo', undefined);
  });

  it('browser_press_key → manager.pressKey(wsId, key)', async () => {
    await tools.execute('browser_press_key', { key: 'PageDown' }, ctx);
    expect(managerMock.pressKey).toHaveBeenCalledWith('ws1', 'PageDown');
  });

  it('browser_hover → manager.hover(wsId, selector)', async () => {
    await tools.execute('browser_hover', { selector: 'text=菜单' }, ctx);
    expect(managerMock.hover).toHaveBeenCalledWith('ws1', 'text=菜单');
  });

  it('browser_scroll 缺省 amount → manager.scroll 第三参 undefined（manager 侧默认 3）', async () => {
    await tools.execute('browser_scroll', { direction: 'down' }, ctx);
    expect(managerMock.scroll).toHaveBeenCalledWith('ws1', 'down', undefined);
  });

  it('browser_scroll 显式 amount → 原样透传', async () => {
    await tools.execute('browser_scroll', { direction: 'up', amount: 5 }, ctx);
    expect(managerMock.scroll).toHaveBeenCalledWith('ws1', 'up', 5);
  });

  it('browser_evaluate → manager.evaluate(wsId, expression)，结果 JSON 序列化', async () => {
    const result = await tools.execute('browser_evaluate', { expression: 'document.title' }, ctx);
    expect(managerMock.evaluate).toHaveBeenCalledWith('ws1', 'document.title');
    expect(result).toContain('"n"');
    expect(result).toContain('1');
  });

  it('browser_console_messages → manager.consoleMessages(wsId)，逐条返回', async () => {
    const result = await tools.execute('browser_console_messages', {}, ctx);
    expect(managerMock.consoleMessages).toHaveBeenCalledWith('ws1');
    expect(result).toContain('[info] hello');
    expect(result).toContain('[error] boom');
  });

  it('browser_tabs list → manager.tabsAction(wsId, "list", undefined, undefined)，结果含 tab 行', async () => {
    const result = await tools.execute('browser_tabs', { action: 'list' }, ctx);
    expect(managerMock.tabsAction).toHaveBeenCalledWith('ws1', 'list', undefined, undefined);
    expect(result).toContain('A 页面');
    expect(result).toContain('https://a.dev/');
  });

  it('browser_tabs open 携带 url / switch 携带 index → 透传', async () => {
    await tools.execute('browser_tabs', { action: 'open', url: 'https://b.dev' }, ctx);
    expect(managerMock.tabsAction).toHaveBeenCalledWith('ws1', 'open', undefined, 'https://b.dev');
    await tools.execute('browser_tabs', { action: 'switch', index: 1 }, ctx);
    expect(managerMock.tabsAction).toHaveBeenCalledWith('ws1', 'switch', 1, undefined);
  });

  it('browser_close → manager.closeBrowser(wsId)', async () => {
    const result = await tools.execute('browser_close', {}, ctx);
    expect(managerMock.closeBrowser).toHaveBeenCalledWith('ws1');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('browser_close 后 browser_navigate 仍直接透传 manager（路由层无缓存状态，懒重建由 T2 锁定）', async () => {
    await tools.execute('browser_close', {}, ctx);
    await tools.execute('browser_navigate', { url: 'https://a.dev' }, ctx);
    expect(managerMock.closeBrowser).toHaveBeenCalledWith('ws1');
    expect(managerMock.navigate).toHaveBeenCalledWith('ws1', 'https://a.dev');
    expect(managerMock.closeBrowser.mock.invocationCallOrder[0]!).toBeLessThan(
      managerMock.navigate.mock.invocationCallOrder[0]!,
    );
  });

  it('未知工具名 → 明确报错（防御：handles 门外的兜底）', async () => {
    await expect(tools.execute('browser_bogus', {}, ctx)).rejects.toThrow(/未知浏览器工具/);
  });
});

// =================================================================================
// 门控顺序锁（review lock）
// =================================================================================

describe('门控顺序锁', () => {
  it('每个工具 execute 先过 assertAllowed：未信任时 12 个 manager 方法全部零调用，错误原样穿透', async () => {
    const notTrusted = new BrowserNotTrustedError();
    policyMock.assertAllowed.mockImplementation(() => {
      throw notTrusted;
    });
    for (const name of TOOL_NAMES) {
      await expect(tools.execute(name, SAMPLE_ARGS[name], ctx)).rejects.toBe(notTrusted);
    }
    expect(policyMock.assertAllowed).toHaveBeenCalledTimes(12);
    for (const call of policyMock.assertAllowed.mock.calls) {
      expect(call[0]).toBe('ws1');
    }
    // manager 完全未被触碰——信任门先于一切 manager 交互
    for (const fn of Object.values(managerMock)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('信任放行时 assertAllowed 每工具恰好一次、以 workspaceId 为参', async () => {
    await tools.execute('browser_click', { selector: '#btn' }, ctx);
    expect(policyMock.assertAllowed).toHaveBeenCalledTimes(1);
    expect(policyMock.assertAllowed).toHaveBeenCalledWith('ws1');
  });

  it('evaluate 双门：assertAllowed 先于 assertEvaluate；assertEvaluate 拒绝时 manager.evaluate 零调用', async () => {
    const disabled = new EvaluateDisabledError();
    policyMock.assertEvaluate.mockImplementation(() => {
      throw disabled;
    });
    await expect(tools.execute('browser_evaluate', { expression: '1' }, ctx)).rejects.toBe(disabled);
    expect(managerMock.evaluate).not.toHaveBeenCalled();
    // 顺序锁：信任门必须先于 evaluate 门
    expect(policyMock.assertAllowed.mock.invocationCallOrder[0]!).toBeLessThan(
      policyMock.assertEvaluate.mock.invocationCallOrder[0]!,
    );
  });

  it('evaluate 双门放行 → manager.evaluate 正常调用（两门各一次）', async () => {
    await tools.execute('browser_evaluate', { expression: '1' }, ctx);
    expect(policyMock.assertAllowed).toHaveBeenCalledTimes(1);
    expect(policyMock.assertEvaluate).toHaveBeenCalledTimes(1);
    expect(managerMock.evaluate).toHaveBeenCalledTimes(1);
  });

  it('非 evaluate 的 11 个工具绝不触碰 assertEvaluate', async () => {
    for (const name of TOOL_NAMES) {
      if (name === 'browser_evaluate') continue;
      await tools.execute(name, SAMPLE_ARGS[name], ctx);
    }
    expect(policyMock.assertEvaluate).not.toHaveBeenCalled();
  });

  it('takeover 态错误原样穿透（同一 Error 实例，工具层不包装不吞）', async () => {
    const takenOver = new BrowserTakenOverError();
    managerMock.navigate.mockRejectedValueOnce(takenOver);
    await expect(tools.execute('browser_navigate', { url: 'https://a.dev' }, ctx)).rejects.toBe(
      takenOver,
    );
  });
});

// =================================================================================
// screenshot filename 清洗（T2 review 裁定）
// =================================================================================

describe('screenshot filename 清洗', () => {
  const cases: Array<[unknown, string | undefined]> = [
    ['../../x', 'x.png'], // 目录段剥掉 + 无扩展名补 .png（brief：仅 basename）
    ['../sub/捕获.png', '捕获.png'], // 中文 basename + 已有扩展名原样保留
    ['report', 'report.png'], // 纯文件名无扩展名
    ['shot.png', 'shot.png'], // 已有 .png 不重复追加
    ['  shot.jpeg ', 'shot.jpeg'], // 首尾空白剥掉
    ['', undefined], // 空串 → 视为未提供
    ['   ', undefined], // 纯空白 → 视为未提供
  ];

  it.each(cases)('filename %j → manager 收到 %j', async (input, expected) => {
    await tools.execute('browser_screenshot', { filename: input }, ctx);
    expect(managerMock.screenshot).toHaveBeenCalledWith('ws1', expected);
  });

  it('filename 非字符串 → 参数错误', async () => {
    await expect(tools.execute('browser_screenshot', { filename: 42 }, ctx)).rejects.toThrow(
      /filename/,
    );
    expect(managerMock.screenshot).not.toHaveBeenCalled();
  });
});

// =================================================================================
// scroll amount 工具层校验（T3 review 裁定：非法值绝不透传 manager）
// =================================================================================

describe('scroll amount 校验与钳制', () => {
  it('超过上限 20 → 钳制到 20', async () => {
    await tools.execute('browser_scroll', { direction: 'down', amount: 25 }, ctx);
    expect(managerMock.scroll).toHaveBeenCalledWith('ws1', 'down', 20);
  });

  it('下界 1 合法透传', async () => {
    await tools.execute('browser_scroll', { direction: 'down', amount: 1 }, ctx);
    expect(managerMock.scroll).toHaveBeenCalledWith('ws1', 'down', 1);
  });

  it.each([0, -3, 2.5, '3', null])('非法值 %j → 报错且 manager 不被调', async (bad) => {
    await expect(
      tools.execute('browser_scroll', { direction: 'down', amount: bad }, ctx),
    ).rejects.toThrow(/amount/);
    expect(managerMock.scroll).not.toHaveBeenCalled();
  });

  it('direction 非法 → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_scroll', { direction: 'left' }, ctx)).rejects.toThrow(
      /direction/,
    );
    expect(managerMock.scroll).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 参数错误路径（momo-test-rules：错误路径与空输入专项）
// =================================================================================

describe('参数错误路径', () => {
  it('navigate 缺 url → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_navigate', {}, ctx)).rejects.toThrow(/url/);
    expect(managerMock.navigate).not.toHaveBeenCalled();
  });

  it('type 缺 text → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_type', { selector: '#q' }, ctx)).rejects.toThrow(/text/);
    expect(managerMock.type).not.toHaveBeenCalled();
  });

  it('press_key 缺 key → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_press_key', {}, ctx)).rejects.toThrow(/key/);
    expect(managerMock.pressKey).not.toHaveBeenCalled();
  });

  it('evaluate 缺 expression → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_evaluate', {}, ctx)).rejects.toThrow(/expression/);
    expect(managerMock.evaluate).not.toHaveBeenCalled();
  });

  it('tabs 非法 action → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_tabs', { action: 'reload' }, ctx)).rejects.toThrow(
      /action/,
    );
    expect(managerMock.tabsAction).not.toHaveBeenCalled();
  });

  it('tabs index 非法（负数 / 小数 / 字符串）→ 报错且 manager 不被调', async () => {
    for (const bad of [-1, 1.5, '0']) {
      await expect(tools.execute('browser_tabs', { action: 'switch', index: bad }, ctx)).rejects.toThrow(
        /index/,
      );
    }
    expect(managerMock.tabsAction).not.toHaveBeenCalled();
  });

  it('tabs url 非字符串 → 报错且 manager 不被调', async () => {
    await expect(tools.execute('browser_tabs', { action: 'open', url: 42 }, ctx)).rejects.toThrow(
      /url/,
    );
    expect(managerMock.tabsAction).not.toHaveBeenCalled();
  });
});

// =================================================================================
// 依赖注入防御与注册中心
// =================================================================================

describe('依赖注入防御', () => {
  it('未 initBrowserTools：12 工具全部拒绝（中文错误含 initBrowserTools 指引）', async () => {
    __resetBrowserToolsForTest();
    const bare = new BrowserTools();
    for (const name of TOOL_NAMES) {
      await expect(bare.execute(name, SAMPLE_ARGS[name], ctx)).rejects.toThrow(/initBrowserTools/);
    }
  });

  it('getDefs / handles 不依赖注入（注册中心构建零副作用）', () => {
    __resetBrowserToolsForTest();
    const bare = new BrowserTools();
    expect(bare.getDefs()).toHaveLength(12);
    expect(bare.handles('browser_navigate')).toBe(true);
  });
});

describe('注册中心', () => {
  it('buildToolRegistry 无条件包含 12 个 browser 工具定义', () => {
    const names = getAllToolDefs(buildToolRegistry(ctx)).map((d) => d.name);
    for (const name of TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('executeTool 路由到 BrowserTools：未初始化时防御错误穿透注册中心', async () => {
    __resetBrowserToolsForTest();
    await expect(
      executeTool('browser_navigate', { url: 'https://a.dev' }, ctx, buildToolRegistry(ctx)),
    ).rejects.toThrow(/initBrowserTools/);
  });
});

// =================================================================================
// 测试辅助
// =================================================================================

/** 取 def 的 properties 子项（inputSchema 为 Record<string, unknown>，测试侧结构收窄） */
function propOf(def: LLMToolDef, key: string): Record<string, unknown> | undefined {
  const schema = def.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  return schema.properties?.[key];
}

/** 取 def 的 required 数组 */
function requiredOf(def: LLMToolDef): unknown[] {
  const schema = def.inputSchema as { required?: unknown[] };
  return schema.required ?? [];
}
