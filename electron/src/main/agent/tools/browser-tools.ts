// electron/src/main/agent/tools/browser-tools.ts
// BrowserTools——v2.7.0 McpBrowser 12 工具模块（spec 2026-09-11 §4）。
//
// 职责分层（本模块只做三件事）：
//   1. 信任门：每次 execute 先 policy.assertAllowed（spec §5.2——工具入口查信任设置，
//      未信任时 manager 完全不被触碰）；browser_evaluate 额外过 assertEvaluate
//      （§6.2 默认关）。策略错误原样穿透给 LLM（含可行动指引）。
//   2. 参数解析与工具层校验：scroll amount 正整数 1-20 钳制（T3 review 裁定——
//      actions 层对非法值抛裸 Error，工具层绝不让非法值透传）；screenshot filename
//      剥目录段仅留 basename + 无扩展名补 .png（T2 review 裁定）。
//   3. 路由到 BrowserManager 对应方法并串结果（takeover/NoView/导航失败等
//      BrowserError 子类由 manager 抛出，本模块不包装不吞、原样穿透）。
//
// URL 协议/域名/file:// 越界检查不在本模块——manager.navigate 内部经
// policy.assertUrl（T2 已锁），错误自然穿透。
//
// 依赖注入：initBrowserTools(policy, manager) 模块级 setter（boot 在 T10 接线；
// 测试注入 mock）。端口为结构性子集（与 manager.ts 的 ViewFactory 同款契约面模式），
// 真实 BrowserManager / BrowserPolicy 结构性满足；注册中心构建（getDefs / handles）
// 不依赖注入，未初始化只在 execute 时防御性报错。
//
// 本模块不记账（v2.5：browser 工具不改 workspace 文件）；审计走 runtime-entry
// 既有 tool-call 审计（自动，无特判）。

import path from 'node:path';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';
import { SCROLL_DEFAULT_AMOUNT } from '../../browser/actions';
import type { TabInfo } from '../../browser/types';

// =================================================================================
// 注入端口（结构性子集——单测用普通对象满足，真实实现结构性兼容）
// =================================================================================

/** BrowserTools 消费的策略面（T1 BrowserPolicy 的结构性子集） */
export interface BrowserPolicyPort {
  /** 信任门：deny / ask 未授时抛 BrowserError 子类 */
  assertAllowed(wsId: string): void;
  /** evaluate 门：设置关闭时抛 EvaluateDisabledError */
  assertEvaluate(wsId: string): void;
}

/** BrowserTools 消费的浏览器编排面（T2 BrowserManager 的结构性子集——12 工具一一对应） */
export interface BrowserManagerPort {
  navigate(wsId: string, rawUrl: string): Promise<{ url: string; title: string }>;
  snapshot(wsId: string): Promise<string>;
  screenshot(wsId: string, filename?: string): Promise<{ path: string }>;
  click(wsId: string, selector: string): Promise<void>;
  type(wsId: string, selector: string, text: string, submit?: boolean): Promise<void>;
  pressKey(wsId: string, key: string): Promise<void>;
  hover(wsId: string, selector: string): Promise<void>;
  scroll(wsId: string, direction: 'up' | 'down', amount?: number): Promise<void>;
  evaluate(wsId: string, expression: string): Promise<unknown>;
  consoleMessages(wsId: string): Promise<string[]>;
  tabsAction(
    wsId: string,
    action: 'list' | 'open' | 'close' | 'switch',
    index?: number,
    url?: string,
    /** 调用方甄别（G4）：工具路径恒用缺省 'agent'（user 态抛 BrowserTakenOverError）；'user' 仅 IPC 用户路径使用 */
    source?: 'agent' | 'user',
  ): Promise<TabInfo[]>;
  /** source 同 tabsAction——browser_close 工具恒用缺省 'agent' */
  closeBrowser(wsId: string, source?: 'agent' | 'user'): Promise<void>;
}

// =================================================================================
// 模块级注入（boot 在 T10 接线；测试注入 mock）
// =================================================================================

let policyRef: BrowserPolicyPort | null = null;
let managerRef: BrowserManagerPort | null = null;

/** 注入浏览器策略与管理器（模块级单例——boot 启动时调用一次） */
export function initBrowserTools(policy: BrowserPolicyPort, manager: BrowserManagerPort): void {
  policyRef = policy;
  managerRef = manager;
}

/** 测试专用：清空模块级注入（避免用例间串扰） */
export function __resetBrowserToolsForTest(): void {
  policyRef = null;
  managerRef = null;
}

// =================================================================================
// 常量
// =================================================================================

/** 12 工具名（spec §4 表——handles 门 + execute 兜底校验共用） */
const TOOL_NAMES = new Set<string>([
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
]);

/** scroll amount 工具层钳制上限（滚轮格；T3 review 裁定：正整数 1-20） */
const SCROLL_MAX_AMOUNT = 20;

// =================================================================================
// 参数解析辅助（错误信息含字段名，给 LLM 明确的纠正反馈）
// =================================================================================

/** scroll direction：仅 up / down */
function parseScrollDirection(v: unknown): 'up' | 'down' {
  if (v !== 'up' && v !== 'down') {
    throw new Error('参数 "direction" 必须是 "up" 或 "down"');
  }
  return v;
}

/** scroll amount：缺省 undefined（manager 侧默认 3）；正整数、上限 20 钳制（非法值绝不透传 manager） */
function parseScrollAmount(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(`参数 "amount" 必须是不小于 1 的整数（1-${SCROLL_MAX_AMOUNT}）`);
  }
  return Math.min(v, SCROLL_MAX_AMOUNT);
}

/** tabs action：仅 list / open / close / switch */
function parseTabsAction(v: unknown): 'list' | 'open' | 'close' | 'switch' {
  if (v !== 'list' && v !== 'open' && v !== 'close' && v !== 'switch') {
    throw new Error('参数 "action" 必须是 "list" / "open" / "close" / "switch" 之一');
  }
  return v;
}

/** tabs index：缺省 undefined（close 默认当前 tab、switch 由 manager 语义定）；非负整数 */
function parseTabIndex(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error('参数 "index" 缺失或不是非负整数');
  }
  return v;
}

/** 可选字符串参数：缺省 undefined，提供则必须为字符串 */
function parseOptionalString(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  return parseStringArg(v, name);
}

/**
 * screenshot filename 清洗（T2 review 裁定）：
 *   - 目录段一律剥掉仅留 basename（'../../x' → 'x'——路径穿越输入不报错、不落盘越界）
 *   - 无扩展名时补 '.png'
 *   - 缺省 / 空白串 → undefined（manager 侧按时间戳命名）
 */
function sanitizeShotFilename(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = parseStringArg(v, 'filename').trim();
  if (trimmed === '') return undefined;
  const base = path.basename(trimmed);
  if (base === '') return undefined; // 输入形如 '/'——交由 manager 缺省命名
  return path.extname(base) === '' ? `${base}.png` : base;
}

/** evaluate 结果 JSON 序列化（undefined / 环状引用兜底为字符串形式） */
function serializeEvalResult(result: unknown): string {
  if (result === undefined) return 'undefined';
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    // 环状引用等 JSON.stringify 抛错场景——退化为 String() 形式，不阻断工具返回
    return String(result);
  }
}

// =================================================================================
// BrowserTools
// =================================================================================

export class BrowserTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'browser_navigate',
        description:
          '在浏览器中打开 URL 并等待加载完成，返回最终 URL 与页面标题。支持 http(s) 与 workspace 内的 file://（越界路径会被拒绝）。阅读长页面请用 browser_scroll 滚动后再 browser_snapshot 获取可见内容',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '目标 URL（http(s) 或 workspace 内 file://）' },
          },
          required: ['url'],
        },
      },
      {
        name: 'browser_snapshot',
        description:
          '获取当前页面的可访问性(a11y)文本快照——带 selector 提示的元素行列表，是理解页面结构与规划操作的首选。长页面请配合 browser_scroll（滚动 → 再快照）逐段阅读',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_screenshot',
        description:
          '截取当前页面可视区截图并保存为 PNG，返回文件路径。filename 可省略（自动按时间命名）；传入时仅保留文件名部分，且无扩展名时自动补 .png',
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '保存文件名（仅保留 basename；无扩展名自动补 .png）' },
          },
        },
      },
      {
        name: 'browser_click',
        description:
          '点击页面元素。selector 四语法：CSS（默认，如 #id / .cls）、text=可见文本、xpath=表达式、aria/角色（browser_snapshot 提示行可直接复制）',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '元素选择器（CSS / text= / xpath= / aria/）' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_type',
        description:
          '向页面输入框键入文本（先点击聚焦再逐字输入）。submit=true 时末尾补回车提交（如搜索框回车搜索）',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '目标输入框的选择器' },
            text: { type: 'string', description: '要输入的文本' },
            submit: { type: 'boolean', description: 'true 时末尾补 Enter 提交' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'browser_press_key',
        description:
          '按下单个按键（白名单：Enter / Tab / Escape / PageDown / PageUp / ArrowUp / ArrowDown / Home / End）——用于翻页、切换焦点等；输入文本请改用 browser_type',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '按键名（白名单内）' },
          },
          required: ['key'],
        },
      },
      {
        name: 'browser_hover',
        description: '将鼠标悬停到页面元素上（触发下拉菜单、tooltip 等 hover 行为）',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: '目标元素的选择器' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'browser_scroll',
        description:
          '滚动当前页面：direction=down 向下 / up 向上；amount 为滚轮格数（正整数 1-20，默认 3）。长页面阅读的标准组合：browser_scroll 滚动后 browser_snapshot 获取新内容',
        inputSchema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
            amount: { type: 'number', description: '滚轮格数（正整数 1-20，默认 3）' },
          },
          required: ['direction'],
        },
      },
      {
        name: 'browser_evaluate',
        description:
          '在当前页面执行 JavaScript 表达式并返回 JSON 序列化结果（快照无法覆盖的取数/操作）。注意：该工具默认可能被设置禁用——收到报错时请告知用户在「设置 → 浏览器」中开启',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'JavaScript 表达式（返回值需可 JSON 序列化）' },
          },
          required: ['expression'],
        },
      },
      {
        name: 'browser_console_messages',
        description: '读取当前 tab 最近 50 条 console 输出（带 [level] 前缀）——排查页面报错',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'browser_tabs',
        description:
          '管理浏览器标签页：action=list 列出全部；open 新开 tab（可带 url，缺省空白页）；close 关闭（index 缺省为当前 tab；关闭唯一 tab 等同 browser_close）；switch 切换到 index',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'open', 'close', 'switch'],
              description: 'tab 操作类型',
            },
            index: { type: 'number', description: 'close / switch 的目标下标（从 0 起）' },
            url: { type: 'string', description: 'open 携带的 URL（http(s) 或 workspace 内 file://）' },
          },
          required: ['action'],
        },
      },
      {
        name: 'browser_close',
        description:
          '关闭当前工作空间的浏览器（销毁全部标签页；浏览数据与登录态保留）。下次 browser_navigate 会重新打开',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  handles(name: string): boolean {
    return TOOL_NAMES.has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    if (!TOOL_NAMES.has(name)) throw new Error(`未知浏览器工具: ${name}`);

    const policy = policyRef;
    const manager = managerRef;
    if (policy === null || manager === null) {
      throw new Error('BrowserTools 未初始化：需先调用 initBrowserTools(policy, manager) 完成依赖注入');
    }

    const wsId = ctx.workspaceId;

    // 信任门（spec §5.2）：所有 browser_* 工具统一入口——未信任时 manager 零触碰，
    // 错误（含右下角信任卡指引）原样穿透给 LLM。
    policy.assertAllowed(wsId);
    // evaluate 双门（§6.2 默认关）：信任门之后、任何参数处理之前。
    if (name === 'browser_evaluate') policy.assertEvaluate(wsId);

    switch (name) {
      case 'browser_navigate': {
        const url = parseStringArg(args.url, 'url');
        const r = await manager.navigate(wsId, url);
        return `已导航到 ${r.url}\n页面标题: ${r.title}`;
      }
      case 'browser_snapshot': {
        return manager.snapshot(wsId);
      }
      case 'browser_screenshot': {
        const filename = sanitizeShotFilename(args.filename);
        const r = await manager.screenshot(wsId, filename);
        return `截图已保存: ${r.path}`;
      }
      case 'browser_click': {
        const selector = parseStringArg(args.selector, 'selector');
        await manager.click(wsId, selector);
        return `已点击元素（selector="${selector}"）`;
      }
      case 'browser_type': {
        const selector = parseStringArg(args.selector, 'selector');
        const text = parseStringArg(args.text, 'text');
        const submit = typeof args.submit === 'boolean' ? args.submit : undefined;
        await manager.type(wsId, selector, text, submit);
        return `已在元素（selector="${selector}"）输入文本${submit === true ? '并回车提交' : ''}`;
      }
      case 'browser_press_key': {
        const key = parseStringArg(args.key, 'key');
        await manager.pressKey(wsId, key);
        return `已按下按键 ${key}`;
      }
      case 'browser_hover': {
        const selector = parseStringArg(args.selector, 'selector');
        await manager.hover(wsId, selector);
        return `已悬停元素（selector="${selector}"）`;
      }
      case 'browser_scroll': {
        const direction = parseScrollDirection(args.direction);
        const amount = parseScrollAmount(args.amount);
        await manager.scroll(wsId, direction, amount);
        return `已向${direction === 'down' ? '下' : '上'}滚动 ${amount ?? SCROLL_DEFAULT_AMOUNT} 格`;
      }
      case 'browser_evaluate': {
        const expression = parseStringArg(args.expression, 'expression');
        const result = await manager.evaluate(wsId, expression);
        return serializeEvalResult(result);
      }
      case 'browser_console_messages': {
        const lines = await manager.consoleMessages(wsId);
        return lines.length > 0 ? lines.join('\n') : '（当前 tab 暂无 console 输出）';
      }
      case 'browser_tabs': {
        const action = parseTabsAction(args.action);
        const index = parseTabIndex(args.index);
        const url = parseOptionalString(args.url, 'url');
        const tabs = await manager.tabsAction(wsId, action, index, url);
        if (tabs.length === 0) return '（当前无打开的 tab）';
        return tabs.map((t) => `[${t.index}] ${t.title} — ${t.url}`).join('\n');
      }
      case 'browser_close': {
        await manager.closeBrowser(wsId);
        return '已关闭浏览器（浏览数据与登录态保留）';
      }
    }
    // 顶部 TOOL_NAMES 检查 + switch 全覆盖——此处理论不可达
    throw new Error(`未知浏览器工具: ${name}`);
  }
}
