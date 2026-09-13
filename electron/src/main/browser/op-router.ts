// electron/src/main/browser/op-router.ts
//
// 主进程 browser op 路由（主机验收 P0 修复）。
//
// runtime 子进程的 browser 工具经 IPC 桥（agent/tools/browser-ipc-bridge.ts）
// 发来 { type:'browser-op', requestId, op, args }——本模块把请求分发到真实编排面
// （BrowserPolicy / BrowserManager，持 WebContentsView 只能活在主进程），应答
// 由 agent-runner 的 messageHandler 补全 type/requestId 后 child.send 回子进程。
//
// 线协议见 op-protocol.ts（单一真相源——改协议两端同 commit）。
//
// 错误处理：catch 全部异常序列化 {name,message}（BrowserError 子类名保留——
// 子进程侧还原 .name，LLM 可见可行动指引）；栈不吞——主进程 logger.warn 留痕
// 后再序列化（栈本身不跨线——线协议只承 name/message）。
//
// source 安全铁律：tabsAction / closeBrowser 恒以 ≤4 / ≤1 参调用真实 manager——
// source 位（'user'）绝不经此通道传递（信封元数上限在 op-protocol 先行拒收）。

import { logger } from '../logger';
import { isBrowserOpEnvelope } from './op-protocol';
import type { BrowserOp, BrowserOpOutcome } from './op-protocol';
import type { BrowserPolicyPort, BrowserManagerPort } from '../agent/tools/browser-tools';

/** 模块级注册的真实编排面（index.ts boot 链在 assembleBrowserSubsystem 后接线） */
let routed: { policy: BrowserPolicyPort; manager: BrowserManagerPort } | null = null;

/** 注册真实编排面（幂等——后调覆盖，boot 一次） */
export function initBrowserOpRouter(policy: BrowserPolicyPort, manager: BrowserManagerPort): void {
  routed = { policy, manager };
}

/** 测试专用：清空注册（用例间隔离） */
export function __resetBrowserOpRouterForTest(): void {
  routed = null;
}

// =================================================================================
// 参数收窄（unknown → 具型——跨进程 unknown 的主路由侧单点窄化）
// =================================================================================

/** 可选位语义：线协议 null 占位 / 缺位 undefined，均还原为 undefined */
function optVal(v: unknown): unknown {
  return v === null ? undefined : v;
}

function reqStr(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`browser-op 参数 "${name}" 必须是字符串`);
  return v;
}

function optStr(v: unknown, name: string): string | undefined {
  const u = optVal(v);
  return u === undefined ? undefined : reqStr(u, name);
}

function optNum(v: unknown, name: string): number | undefined {
  const u = optVal(v);
  if (u === undefined) return undefined;
  if (typeof u !== 'number' || !Number.isInteger(u)) {
    throw new Error(`browser-op 参数 "${name}" 必须是整数`);
  }
  return u;
}

function optBool(v: unknown, name: string): boolean | undefined {
  const u = optVal(v);
  if (u === undefined) return undefined;
  if (typeof u !== 'boolean') throw new Error(`browser-op 参数 "${name}" 必须是布尔值`);
  return u;
}

function reqDirection(v: unknown): 'up' | 'down' {
  if (v !== 'up' && v !== 'down') throw new Error('browser-op 参数 "direction" 必须是 "up" 或 "down"');
  return v;
}

function reqTabsAction(v: unknown): 'list' | 'open' | 'close' | 'switch' {
  if (v !== 'list' && v !== 'open' && v !== 'close' && v !== 'switch') {
    throw new Error('browser-op 参数 "action" 必须是 "list" / "open" / "close" / "switch" 之一');
  }
  return v;
}

/** 按 op 分发到真实 policy/manager（语义校验留给编排面——错误穿透给 catch） */
async function dispatchOp(
  policy: BrowserPolicyPort,
  manager: BrowserManagerPort,
  op: BrowserOp,
  args: readonly unknown[],
): Promise<unknown> {
  switch (op) {
    case 'assertAllowed': return policy.assertAllowed(reqStr(args[0], 'wsId'));
    case 'assertEvaluate': return policy.assertEvaluate(reqStr(args[0], 'wsId'));
    case 'navigate': return manager.navigate(reqStr(args[0], 'wsId'), reqStr(args[1], 'rawUrl'));
    case 'snapshot': return manager.snapshot(reqStr(args[0], 'wsId'));
    case 'screenshot': return manager.screenshot(reqStr(args[0], 'wsId'), optStr(args[1], 'filename'));
    case 'click': return manager.click(reqStr(args[0], 'wsId'), reqStr(args[1], 'selector'));
    case 'type':
      return manager.type(
        reqStr(args[0], 'wsId'),
        reqStr(args[1], 'selector'),
        reqStr(args[2], 'text'),
        optBool(args[3], 'submit'),
      );
    case 'pressKey': return manager.pressKey(reqStr(args[0], 'wsId'), reqStr(args[1], 'key'));
    case 'hover': return manager.hover(reqStr(args[0], 'wsId'), reqStr(args[1], 'selector'));
    case 'scroll':
      return manager.scroll(reqStr(args[0], 'wsId'), reqDirection(args[1]), optNum(args[2], 'amount'));
    case 'evaluate': return manager.evaluate(reqStr(args[0], 'wsId'), reqStr(args[1], 'expression'));
    case 'consoleMessages': return manager.consoleMessages(reqStr(args[0], 'wsId'));
    case 'tabsAction':
      // 恒 4 参调用——source 位绝不传递（G4：桥路径工具层缺省 'agent'）
      return manager.tabsAction(
        reqStr(args[0], 'wsId'),
        reqTabsAction(args[1]),
        optNum(args[2], 'index'),
        optStr(args[3], 'url'),
      );
    case 'closeBrowser':
      // 恒 1 参调用——source 位绝不传递
      return manager.closeBrowser(reqStr(args[0], 'wsId'));
  }
}

/**
 * 错误名序列化：取 constructor.name——BrowserError 基类构造器把全部子类实例的
 * .name 硬编码为 'BrowserError'（子类区分在 code 字段），直接读 .name 会把
 * 子类信息吞掉；constructor.name 保留真实子类名（BrowserNoViewError 等），
 * 子进程据此还原 .name，LLM 可见可行动指引。
 */
function errorNameOf(err: unknown): string {
  if (err instanceof Error) {
    const ctorName = err.constructor?.name;
    if (typeof ctorName === 'string' && ctorName !== '') return ctorName;
    return err.name;
  }
  return 'Error';
}

/**
 * 路由一条 browser-op 请求。永不抛异常——所有失败（未注册 / 信封非法 / 参数
 * 非法 / 编排面抛错）统一序列化为 {ok:false, error:{name,message}} 应答，子进程
 * pending promise 可靠 reject（绝不静默丢弃导致 60s 挂等）。
 */
export async function routeBrowserOp(msg: unknown): Promise<BrowserOpOutcome> {
  const registered = routed;
  if (registered === null) {
    return { ok: false, error: { name: 'Error', message: '主进程 browser op 路由未初始化' } };
  }
  if (!isBrowserOpEnvelope(msg)) {
    return {
      ok: false,
      error: { name: 'Error', message: 'browser-op 请求载荷非法（type / requestId / op / args 形状不符或参数超量）' },
    };
  }
  try {
    const payload = await dispatchOp(registered.policy, registered.manager, msg.op, msg.args);
    return { ok: true, payload };
  } catch (err) {
    const name = errorNameOf(err);
    const message = err instanceof Error ? err.message : String(err);
    // 栈不吞：主进程侧留痕（线协议只承 name/message，栈不跨线）
    logger.warn('browser op 路由失败', { op: msg.op, errorName: name, message, stack: err instanceof Error ? err.stack : undefined });
    return { ok: false, error: { name, message } };
  }
}
