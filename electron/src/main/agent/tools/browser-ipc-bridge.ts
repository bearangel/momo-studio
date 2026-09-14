// electron/src/main/agent/tools/browser-ipc-bridge.ts
//
// browser 工具子进程 IPC 桥（主机验收 P0 修复）。
//
// 根因：initBrowserTools 只在主进程 boot（browser/boot.ts T10）调用，但 agent
// 工具在 runtime 子进程执行（BrowserManager 持 WebContentsView 只能活在主进程）
// ——子进程 browser-tools 模块态恒未初始化，12 个浏览器工具全部报「未初始化」。
// 本桥把两端口（BrowserPolicyPort / BrowserManagerPort）的全部方法代理为
// process.send IPC 往返，由主进程 op-router.ts 分发到真实编排面。
//
// 线协议见 browser/op-protocol.ts（单一真相源——改协议两端同 commit）。
//
// 错误路径铁律：
//   - ok:false → new Error(message) 且 .name = error.name（BrowserError 子类名
//     保留，LLM 可见可行动指引）
//   - 超时 reject 中文文案并清 pending（防泄漏 + 迟到结果安全 no-op）
//   - process.send 不可用（非 fork 环境）立即 reject，绝不挂等超时

import { randomUUID } from 'node:crypto';
import { isBrowserOpResult } from '../../browser/op-protocol';
import { TRUST_WAIT_TIMEOUT_MS } from '../../browser/policy';
import { DEFAULT_AGENT_WAIT_MS } from '../../browser/manager';
import type { BrowserOp, BrowserOpArgs, BrowserOpPayloads } from '../../browser/op-protocol';
import type { BrowserPolicyPort, BrowserManagerPort } from './browser-tools';

/** 超时中文文案（同时覆盖「主进程未接线」情形——两态对子进程不可区分） */
const TIMEOUT_MESSAGE = 'browser IPC 无响应（主进程未接线或超时）';

/** process.send 缺失文案（非 fork 环境直接跑 runtime-entry 的场景） */
const NO_SEND_MESSAGE = 'browser IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/**
 * 信任门等待类 op（assertAllowed）的桥超时：主进程侧阻塞等待用户点击信任卡最长
 * TRUST_WAIT_TIMEOUT_MS（policy 单一真相源，本常量由其推导——编译期联动，改一处
 * 另一处可见；测试另锁「本值 ≥ TRUST_WAIT_TIMEOUT_MS + 20s」防单边改小）。桥超时
 * 必须长于等待上限 + 裕量，否则用户还在思考时桥先超时，把「等待授权」误报为
 * 「IPC 无响应」——授权与执行脱钩（本次修复要消除的 UX 缺陷形态）。
 */
export const TRUST_GATE_BRIDGE_TIMEOUT_MS = TRUST_WAIT_TIMEOUT_MS + 20_000;

/**
 * manager 类 op（navigate/click 等 12 个编排面方法）的桥超时：主进程侧
 * gateAgentSide 可能 park 最长 DEFAULT_AGENT_WAIT_MS（manager 单一真相源，本常量
 * 由其推导——编译期联动，改一处另一处可见；测试另锁「本值 ≥
 * DEFAULT_AGENT_WAIT_MS + 20s」防单边改小）。桥超时必须晚于 park 诚实 reject
 * 上限（park 起点 + waitMs + 1s tick 粒度 + op 执行 + IPC 开销），否则桥先超时，
 * 子进程拿到「browser IPC 无响应」的错误归因，迟到的诚实超时按未知 requestId
 * 静默丢弃（终审 C1）。取舍：settings 把 agentWaitMs 调大于缺省时仍会被本档
 * 截断——本期无设置 UI（spec §4.4），缺省即运行事实；缺省改 120s（终审 I1）时
 * 本档自动跟随为 140s，无需单边调整。
 */
export const MANAGER_OP_BRIDGE_TIMEOUT_MS = DEFAULT_AGENT_WAIT_MS + 20_000;

/**
 * 按 op 分档超时：assertAllowed 走信任门等待档；manager 类 op 走驻留等待联动档
 * （park 最长 DEFAULT_AGENT_WAIT_MS + 裕量）；assertEvaluate 纯判定 op 走默认档。
 */
function timeoutForOp(op: BrowserOp, defaultTimeoutMs: number): number {
  if (op === 'assertAllowed') return TRUST_GATE_BRIDGE_TIMEOUT_MS;
  if (op === 'assertEvaluate') return defaultTimeoutMs;
  return MANAGER_OP_BRIDGE_TIMEOUT_MS;
}

/** 桥产出：两端口代理（initBrowserTools 直接消费） */
export interface BrowserToolsIpcBridge {
  readonly policy: BrowserPolicyPort;
  readonly manager: BrowserManagerPort;
}

/** 在途请求记录（result 到达 / 超时二者先到者清理） */
interface PendingEntry {
  /** payload 以 unknown 存取（协议层收窄单点——见 sendBrowserOp 内存放说明） */
  readonly resolve: (payload: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** requestId → 在途请求（进程级单例——每 op 一个随机 UUID，真实唯一） */
const pending = new Map<string, PendingEntry>();

/**
 * 发送一次 browser-op 并等待应答。requestId 单点生成（randomUUID）沿线透传——
 * 主进程应答按 requestId 原样回带，任何一跳重新生成 ID 都会断链。
 */
function sendBrowserOp<K extends BrowserOp>(
  op: K,
  args: BrowserOpArgs[K],
  timeoutMs: number,
): Promise<BrowserOpPayloads[K]> {
  return new Promise<BrowserOpPayloads[K]>((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    // 收窄单点：类型化 resolve 以 unknown 形态入 pending 表（应答载荷本就是
    // 跨进程 unknown——协议类型只约束构造端，运行时形状由主路由负责）
    const settle = (payload: unknown) => resolve(payload as BrowserOpPayloads[K]);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { resolve: settle, reject, timer });
    try {
      // 必须以 process.send(...) 方法调用形式发送：Node 内部实现读取 this.connected，
      // 解构后裸调用在严格模式下 this=undefined 直接抛错（2.0.0 主机验收 P0-1 教训）
      process.send({ type: 'browser-op', requestId, op, args });
    } catch (err) {
      const entry = pending.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * 创建 browser 工具 IPC 桥。两端口的方法全部代理为 sendBrowserOp——真实
 * policy/manager 只活在主进程，子进程经 fork IPC 通道往返调用。
 *
 * @param timeoutMs 纯判定类 op（assertEvaluate）的往返超时缺省；等待类 op
 *   （assertAllowed / manager 族）由分档推导常量覆盖，见 timeoutForOp
 */
export function createBrowserToolsIpcBridge(timeoutMs = 60_000): BrowserToolsIpcBridge {
  const call = <K extends BrowserOp>(op: K, args: BrowserOpArgs[K]): Promise<BrowserOpPayloads[K]> =>
    sendBrowserOp(op, args, timeoutForOp(op, timeoutMs));

  return {
    // policy 门返回 Promise（端口面为 void | Promise<void> 联合——真实主进程
    // 同步实现不受影响，桥实现必须经 await 消费才能让未信任错误穿透给 LLM）
    policy: {
      assertAllowed: (wsId: string): Promise<void> => call('assertAllowed', [wsId]),
      assertEvaluate: (wsId: string): Promise<void> => call('assertEvaluate', [wsId]),
    },
    manager: {
      navigate: (wsId: string, rawUrl: string) => call('navigate', [wsId, rawUrl]),
      snapshot: (wsId: string) => call('snapshot', [wsId]),
      screenshot: (wsId: string, filename?: string) => call('screenshot', [wsId, filename ?? null]),
      click: (wsId: string, selector: string) => call('click', [wsId, selector]),
      type: (wsId: string, selector: string, text: string, submit?: boolean) =>
        call('type', [wsId, selector, text, submit ?? null]),
      pressKey: (wsId: string, key: string) => call('pressKey', [wsId, key]),
      hover: (wsId: string, selector: string) => call('hover', [wsId, selector]),
      scroll: (wsId: string, direction: 'up' | 'down', amount?: number) =>
        call('scroll', [wsId, direction, amount ?? null]),
      evaluate: (wsId: string, expression: string) => call('evaluate', [wsId, expression]),
      consoleMessages: (wsId: string) => call('consoleMessages', [wsId]),
      // source 恒不传递：工具层缺省 'agent'（G4 调用方甄别——'user' 仅 IPC 用户路径）
      tabsAction: (
        wsId: string,
        action: 'list' | 'open' | 'close' | 'switch',
        index?: number,
        url?: string,
      ) => call('tabsAction', [wsId, action, index ?? null, url ?? null]),
      closeBrowser: (wsId: string) => call('closeBrowser', [wsId]),
    },
  };
}

/**
 * 消费主进程应答（runtime-entry 的 taskMessageListener 分发到此）。按
 * requestId 派发到 pending 表；ok=false 时 new Error(message) 且 .name 保真
 * （BrowserError 子类名保留）。未知 requestId（迟到 / 重复 / 跨桥残留）静默
 * 忽略——不崩不误伤在途请求。
 */
export function handleBrowserOpResult(msg: unknown): void {
  if (!isBrowserOpResult(msg)) return;
  const entry = pending.get(msg.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.requestId);
  if (msg.ok) {
    entry.resolve(msg.payload);
  } else {
    const err = new Error(msg.error.message);
    err.name = msg.error.name;
    entry.reject(err);
  }
}
