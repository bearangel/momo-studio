// electron/src/main/browser/op-protocol.ts
//
// browser 工具子进程 IPC 桥契约（单一真相源，主机验收 P0 修复）。
//
// 根因：initBrowserTools 只在主进程 boot 调用，而 agent 工具在 runtime 子进程
// 执行——模块级注入按进程隔离，子进程 12 个浏览器工具恒报「未初始化」。修复
// 方案：子进程持 IPC 代理端口（browser-ipc-bridge.ts），主进程持真实编排面
// 分发（op-router.ts），本文件定义两端共用的线协议形状。
//
// 契约（一义一名，改协议两端同 commit——momo-boundary-rules）：
//   子→主 { type:'browser-op', requestId: randomUUID, op: BrowserOp, args: [...] }
//   主→子 { type:'browser-op:result', requestId, ok:true, payload }
//        | { type:'browser-op:result', requestId, ok:false, error:{name,message} }
//
// source 安全铁律：桥路径恒省略 source（工具层缺省 'agent'）；主进程路由禁止经
// 此通道传 'user'——source 位不在协议面，元数上限表 + ctx 位形状校验双重封死
// 走私路径（ctx 位传字符串即拒收；超量参数一律拒收）。
//
// 归属制（spec 2026-09-15 §5.2）：12 个 manager 类 op 元组尾部恒携 BrowserOpCtx
// 身份（ownerId = agent 实例 ID 或 'user'，sessionId = 发起会话）——子桥构造端
// 注入、主路由提取端校验，与 source 防御正交并存。
//
// 跨进程 unknown 的收窄集中在本文件（信封校验）与主路由分发点（逐 op 参数
// 校验）——一处窄化全线受益，业务代码不重复防御。

import type { TabInfo } from './types';

// =================================================================================
// 操作符与参数/载荷类型表（编译期精确——子桥构造、主路由分发共用）
// =================================================================================

/** 归属身份（spec 2026-09-15 §5.2）：ownerId = agent 实例 ID（workspace_agent_members.instance_id）或 'user'；sessionId = 发起会话（user 源为空串） */
export interface BrowserOpCtx {
  ownerId: string;
  sessionId: string;
}

/** 用户路径（IPC 直连）与旧测试直调的缺省身份。冻结防共享实例被意外篡改 */
export const USER_OP_CTX: BrowserOpCtx = Object.freeze({ ownerId: 'user', sessionId: '' });

/** 每个操作符的参数元组（与 browser-tools.ts 两端口面一一对照）。
 *  线协议为固定元数：可选位以 null 占位（fork IPC 走 JSON 序列化——undefined
 *  数组元素会变 null，契约显式声明 null 消除两端的序列化歧义；子桥把端口面
 *  的 undefined 归一为 null，主路由把 null 还原为 undefined）。
 *  manager 类 12 op 尾部恒携 ctx（归属制身份——source 恒不在协议面）。 */
export interface BrowserOpArgs {
  /** policy 信任门（参数 [wsId]） */
  assertAllowed: [wsId: string];
  /** policy evaluate 门（参数 [wsId]） */
  assertEvaluate: [wsId: string];
  navigate: [wsId: string, rawUrl: string, ctx: BrowserOpCtx];
  snapshot: [wsId: string, ctx: BrowserOpCtx];
  screenshot: [wsId: string, filename: string | null, ctx: BrowserOpCtx];
  click: [wsId: string, selector: string, ctx: BrowserOpCtx];
  type: [wsId: string, selector: string, text: string, submit: boolean | null, ctx: BrowserOpCtx];
  pressKey: [wsId: string, key: string, ctx: BrowserOpCtx];
  hover: [wsId: string, selector: string, ctx: BrowserOpCtx];
  scroll: [wsId: string, direction: 'up' | 'down', amount: number | null, ctx: BrowserOpCtx];
  evaluate: [wsId: string, expression: string, ctx: BrowserOpCtx];
  consoleMessages: [wsId: string, ctx: BrowserOpCtx];
  /** index/url 可选位以 null 占位；source 恒不在协议面（工具层缺省 'agent'） */
  tabsAction: [wsId: string, action: 'list' | 'open' | 'close' | 'switch', index: number | null, url: string | null, ctx: BrowserOpCtx];
  /** source 恒不在协议面（工具层缺省 'agent'） */
  closeBrowser: [wsId: string, ctx: BrowserOpCtx];
}

/** 每个操作符的应答载荷类型 */
export interface BrowserOpPayloads {
  assertAllowed: void;
  assertEvaluate: void;
  navigate: { url: string; title: string };
  snapshot: string;
  screenshot: { path: string };
  click: void;
  type: void;
  pressKey: void;
  hover: void;
  scroll: void;
  evaluate: unknown;
  consoleMessages: string[];
  tabsAction: TabInfo[];
  closeBrowser: void;
}

/** 操作符全集（policy 2 op + BrowserManagerPort 12 方法） */
export type BrowserOp = keyof BrowserOpArgs & keyof BrowserOpPayloads;

/** 精确请求联合（判别字段 op——子桥构造端类型检查） */
export type BrowserOpRequest = {
  [K in BrowserOp]: { type: 'browser-op'; requestId: string; op: K; args: BrowserOpArgs[K] };
}[BrowserOp];

// =================================================================================
// 应答形状
// =================================================================================

/** 错误序列化形态（BrowserError 子类名保留——LLM 可见可行动指引） */
export interface BrowserOpError {
  name: string;
  message: string;
}

/** 主→子应答（线协议全形状——agent-runner 直接 child.send 本类型） */
export type BrowserOpResult =
  | { type: 'browser-op:result'; requestId: string; ok: true; payload: unknown }
  | { type: 'browser-op:result'; requestId: string; ok: false; error: BrowserOpError };

/** 主路由返回值（不含 type/requestId——由接线层补全为 BrowserOpResult） */
export type BrowserOpOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: BrowserOpError };

// =================================================================================
// 元数上限（source 走私防御）+ 信封校验（unknown 收窄单点）
// =================================================================================

/**
 * 各 op 参数元数上限。超量一律拒收——机械封死经桥通道走私 source='user' 的
 * 路径（source 位不在协议面；ctx 尾参入上限——manager 类 op 较原值 +1）。
 */
export const BROWSER_OP_MAX_ARGS: Readonly<Record<BrowserOp, number>> = {
  assertAllowed: 1,
  assertEvaluate: 1,
  navigate: 3,
  snapshot: 2,
  screenshot: 3,
  click: 3,
  type: 5,
  pressKey: 3,
  hover: 3,
  scroll: 4,
  evaluate: 3,
  consoleMessages: 2,
  tabsAction: 5,
  closeBrowser: 2,
};

/**
 * 信封校验后的宽松形态（args 元素类型由主路由分发点逐 op 收窄——协议层只验
 * 信封：type / requestId / op 已知 / args 是数组且不超元数上限）。
 */
export interface BrowserOpEnvelope {
  readonly type: 'browser-op';
  readonly requestId: string;
  readonly op: BrowserOp;
  readonly args: readonly unknown[];
}

/** 子→主请求信封校验（unknown 收窄单点——主路由据此防御畸形/漂移载荷） */
export function isBrowserOpEnvelope(msg: unknown): msg is BrowserOpEnvelope {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m['type'] === 'browser-op' &&
    typeof m['requestId'] === 'string' &&
    m['requestId'] !== '' &&
    typeof m['op'] === 'string' &&
    Object.prototype.hasOwnProperty.call(BROWSER_OP_MAX_ARGS, m['op']) &&
    Array.isArray(m['args']) &&
    (m['args'] as unknown[]).length <= BROWSER_OP_MAX_ARGS[m['op'] as BrowserOp]
  );
}

/** 主→子应答形状校验（子进程 process.on('message') 载荷收窄） */
export function isBrowserOpResult(msg: unknown): msg is BrowserOpResult {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'browser-op:result' || typeof m['requestId'] !== 'string') return false;
  if (m['ok'] === true) return true;
  if (m['ok'] !== false) return false;
  const err = m['error'];
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e['name'] === 'string' && typeof e['message'] === 'string';
}
