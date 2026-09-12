// electron/src/main/browser/actions.ts
//
// 输入动作层（spec §3.3 / §4 工具 4-8）——selector 定位 + sendInputEvent 派发。
// 操作对象为 ManagedWebContents 结构性接口（duck-typed——纯 Node 单测用 spy 对象，
// 真实 Electron WebContentsView 由 view-factory.ts 适配满足）。
//
// 【trusted 事件】全部输入经 webContents.sendInputEvent——Chromium trusted 事件
// （isTrusted=true），页面 JS 无法辨别为合成，相比注入 dispatchEvent 的 untrusted
// 事件可触发真实交互语义。事件类型名对齐 electron.d.ts MouseInputEvent/KeyInputEvent
// 联合类型：brief/spec 行文中的 CDP 名称 mousePressed/mouseReleased/mouseMoved 经
// sendInputEvent 对应 Electron 的 mouseDown/mouseUp/mouseMove（写错类型名真实运行时
// 不被接受）。
//
// 【内部 executeJavaScript 不受 evaluate 开关约束】（spec §3.3）：evaluate 开关只门
// browser_evaluate 工具（任意 JS 表达式、结果回传 LLM）；本层 executeJavaScript 只
// 执行 selector.ts 的内部固定解析脚本——返回元素坐标/描述与未命中提示的 JSON，不
// 回传任意页面数据，因此不经该开关。
import { BrowserInvalidKeyError, BrowserSelectorError } from './errors';
import type { ManagedWebContents } from './manager';
import { buildResolveScript, parseSelector } from './selector';

/** 解析命中的元素矩形 + 人读描述（页内脚本 rect 载荷的 Node 侧形态） */
export interface ResolvedElement {
  x: number;
  y: number;
  width: number;
  height: number;
  description: string;
}

/**
 * 输入派发包装钩子——manager 经 withAgentInput 包裹输入派发（sendInputEvent 在真实
 * 环境可能回流 before-input-event，自锁防止 agent 动作误触发「用户接管」）。不传则
 * 直接派发（standalone 调用/单测）。
 */
export type InputDispatchGuard = (run: () => void) => void;

/** scroll 缺省滚轮格数（spec §4 工具 8：约 300px） */
export const SCROLL_DEFAULT_AMOUNT = 3;

/** scroll 单格像素值（≈100px/格，对齐 macOS 自然滚动一格） */
const SCROLL_TICK_PIXELS = 100;

/** pressKey 白名单（spec §4 工具 6）——防修饰键/快捷键注入（如 Meta+W 关窗口） */
const PRESS_KEY_WHITELIST: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'PageDown',
  'PageUp',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

function dispatch(run: () => void, guard?: InputDispatchGuard): void {
  if (guard) guard(run);
  else run();
}

/** 元素中心坐标（click/hover/type 聚焦的派发点） */
function center(el: ResolvedElement): { x: number; y: number } {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/** rect 载荷结构守卫（JSON.parse 结果为 unknown——逐字段收窄，不用 as 断言整体） */
function isResolvedElement(v: unknown): v is ResolvedElement {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['x'] === 'number' &&
    typeof r['y'] === 'number' &&
    typeof r['width'] === 'number' &&
    typeof r['height'] === 'number' &&
    typeof r['description'] === 'string'
  );
}

/** hints 数组守卫（形态异常时回退空提示，不掩盖未命中主信息） */
function toHints(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
}

/**
 * 在页内解析 selector 并返回元素矩形。未命中（rect:null）抛 BrowserSelectorError，
 * message 含「已匹配 0 个」与页内收集的可交互元素前 5 提示（助 LLM 改写 selector）。
 */
export async function resolveElement(
  wc: ManagedWebContents,
  selector: string,
): Promise<ResolvedElement> {
  const sel = parseSelector(selector); // 非法 selector 直接抛，不触 executeJavaScript
  const raw: unknown = await wc.executeJavaScript(buildResolveScript(sel));
  // 真实页内脚本恒返回 JSON 字符串；非字符串属异常形态（渲染进程中途销毁等）
  if (typeof raw !== 'string') throw new BrowserSelectorError(selector);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrowserSelectorError(selector);
  }
  const payload =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  const hints = payload ? toHints(payload['hints']) : [];
  const rect: unknown = payload ? payload['rect'] : null;
  if (!isResolvedElement(rect) || rect.width <= 0 || rect.height <= 0) {
    throw new BrowserSelectorError(selector, hints);
  }
  return rect;
}

/** click：元素中心 mouseDown+mouseUp 序列（Chromium trusted 点击；CDP 名 mousePressed/Released） */
export async function clickElement(
  wc: ManagedWebContents,
  selector: string,
  guard?: InputDispatchGuard,
): Promise<void> {
  const el = await resolveElement(wc, selector);
  const c = center(el);
  dispatch(() => {
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }, guard);
}

/**
 * type：先 click 元素中心聚焦 → char 逐字符（for..of 按码点迭代——多字节文本不拆
 * 代理对）→ submit=true 末尾补 keyDown/Up Enter（spec §4 工具 5）。
 */
export async function typeText(
  wc: ManagedWebContents,
  selector: string,
  text: string,
  submit = false,
  guard?: InputDispatchGuard,
): Promise<void> {
  const el = await resolveElement(wc, selector);
  const c = center(el);
  dispatch(() => {
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch });
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
  }, guard);
}

/** pressKey：白名单外按键抛 BrowserInvalidKeyError（防修饰键/快捷键注入），不派发事件 */
export function pressKey(
  wc: ManagedWebContents,
  key: string,
  guard?: InputDispatchGuard,
): void {
  if (!PRESS_KEY_WHITELIST.has(key)) throw new BrowserInvalidKeyError(key);
  dispatch(() => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
  }, guard);
}

/** hover：mouseMove 至元素中心（Electron 事件名；CDP 名为 mouseMoved） */
export async function hoverElement(
  wc: ManagedWebContents,
  selector: string,
  guard?: InputDispatchGuard,
): Promise<void> {
  const el = await resolveElement(wc, selector);
  const c = center(el);
  dispatch(() => {
    wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
  }, guard);
}

/** scroll：mouseWheel；amount 缺省 3 滚轮格（每格 ≈100px）；up 取负（Chromium deltaY 正=向下） */
export function scrollWheel(
  wc: ManagedWebContents,
  direction: 'up' | 'down',
  amount: number = SCROLL_DEFAULT_AMOUNT,
  guard?: InputDispatchGuard,
): void {
  // 防 amount 传 0/负/非整数导致方向语义反转或无意义事件
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(`滚轮格数 amount 必须为 ≥1 的整数，收到: ${String(amount)}`);
  }
  const sign = direction === 'down' ? 1 : -1;
  dispatch(() => {
    wc.sendInputEvent({
      type: 'mouseWheel',
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: sign * amount * SCROLL_TICK_PIXELS,
    });
  }, guard);
}
