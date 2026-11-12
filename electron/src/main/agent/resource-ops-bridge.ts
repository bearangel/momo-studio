// electron/src/main/agent/resource-ops-bridge.ts
//
// resource-ops 桥（spec §6；确认门 spec 2026-11-12 §5.6/§7/§10）。子进程侧
// requestResourceOp 复刻 mcp-bridge 全部教训（id 配对 + per-op 超时 +
// process.send 方法调用式绑定铁律）；主进程侧 handleResourceOpMessage 供
// runtime-spawner 的子进程 message 路由调用——确认门在 executor 之前，
// 子进程对 required 档 op 无任何绕过路径。
import { randomUUID } from 'node:crypto';
import { executeResourceOp, RESOURCE_OP_NAMES, confirmTierForOp, buildConfirmPayload, validateCapabilityRefs, type OpContext, type ResourceOpDeps } from './resource-ops';
import { requestAgentOpConfirm } from './agent-op-confirm';
import { broadcastRuntimeChanged } from '../im/session-service';
import { broadcastResourceChanged } from '../resource/changed-emit';

const RESOURCE_OP_TIMEOUT_MS = 30_000;
/** 需确认 op 的子进程等待预算：主进程侧 CONFIRM_WAIT_MS（10min）+ 30s 余量 */
const CONFIRM_OP_WAIT_MS = 10 * 60_000 + 30_000;

/** per-op 子进程等待预算（spec §7.2）：确认档 op 等用户裁决（10min30s），
 *  普通 op 维持 30s。档位判定与主进程确认门同源（confirmTierForOp 单源） */
export function confirmWaitBudgetMs(op: string, args?: Record<string, unknown>): number {
  return confirmTierForOp(op, args ?? {}) === 'required' ? CONFIRM_OP_WAIT_MS : RESOURCE_OP_TIMEOUT_MS;
}

/** 子进程侧：请求主进程执行一个 resource op */
export function requestResourceOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  // 铁律：process.send 必须以方法调用形式调用（this=undefined 会炸——§8.4 教训）
  const send = (process as { send?: (m: unknown) => void }).send?.bind(process);
  if (typeof send !== 'function') {
    return Promise.reject(new Error('资源创建不可用：子进程未建立 IPC 通道'));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const budgetMs = confirmWaitBudgetMs(op, args);
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`resource op ${op} 超时（${budgetMs / 1000}s）`));
    }, budgetMs);
    timer.unref?.();
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; id?: string; result?: unknown; error?: unknown };
      if (m?.type !== 'resource-op' || m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) reject(new Error(String(m.error)));
      else resolve(m.result ?? null);
    };
    process.on('message', handler);
    send({ type: 'resource-op', id, op, args });
  });
}

/** 确认通道 child 键单源派生：请求侧（runtime-spawner）与 exit 清理侧
 *  （runtime-registry onExit）必须经本函数取同键，禁止各自拼装 */
export function childKeyFor(assignmentId: string, child: { pid?: number }): string {
  return `${assignmentId}:${child.pid ?? 'no-pid'}`;
}

/** 影响成员/团队可见性的 op——成功后额外广播既有 agent:runtimeChanged（MainLayout
 *  已监听）。§6.2 矩阵：updateCapabilities / updateProfile 改能力面与档案，
 *  成员编辑视图须刷新 */
export const MEMBER_AFFECTING_OPS = ['createAgent', 'addMember', 'createTeam', 'updateCapabilities', 'updateProfile'] as const;

/** memberAffecting 查询（广播矩阵 §6.2 单一入口） */
export function memberAffecting(op: string): boolean {
  return (MEMBER_AFFECTING_OPS as readonly string[]).includes(op);
}

/** 只读 op——成功后不触发任何刷新广播（list / listModels 高频且无状态变更；技能还
 *  强制「创建前先盘点」，无差别广播会让 renderer 三 store 每次白重拉；
 *  describeAgent 同为只读盘点入口，spec §6.2 零广播） */
const READ_ONLY_OPS: ReadonlySet<string> = new Set(['list', 'listModels', 'describeAgent']);

type OpExecutor = (
  op: string,
  args: unknown,
  workspaceId: string,
  deps: ResourceOpDeps | undefined,
  ctx: OpContext | undefined,
) => Promise<unknown>;

/** 主进程侧 op 上下文（spec 2026-11-12 §6/§7.3）——spawner 闭包注入：
 *  - background：后台链判定（fail-closed 依据），取主进程闭包态不取消息体
 *  - callerInstanceId：触发成员自身（restart=auto 自改检测）
 *  - childKey：确认通道 child 键（child 退出清理用，childKeyFor 单源派生；
 *    缺席时退化为不可清理键——10min 超时仍兜底收敛 */
export interface BridgeOpContext {
  background: boolean;
  callerInstanceId?: string;
  childKey?: string;
}

/**
 * 主进程侧消息分支：消费 type='resource-op' 的子进程消息。
 * workspaceId 取自 per-child spawn 上下文（调用方闭包）——消息内 workspaceId 一律忽略。
 * 确认门（spec §7）：required 档 op 先经 requestAgentOpConfirm 裁决——后台链
 * fail-closed 不弹卡直接拒；拒绝/超时回错误不执行。返回是否消费（false = 交还
 * 其它分支）。可注入 executor 供测试。
 */
export async function handleResourceOpMessage(
  msg: unknown,
  workspaceId: string,
  childSend: (m: unknown) => void,
  executor: OpExecutor = executeResourceOp,
  ctx?: BridgeOpContext,
): Promise<boolean> {
  const m = msg as { type?: string; id?: unknown; op?: unknown; args?: unknown };
  if (m?.type !== 'resource-op' || typeof m.id !== 'string') return false;
  const op = typeof m.op === 'string' ? m.op : '';
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    childSend({ type: 'resource-op', id: m.id, error: `未知 resource op: ${op}` });
    return true;
  }
  const args = (m.args ?? {}) as Record<string, unknown>;
  if (confirmTierForOp(op, args) === 'required') {
    if (ctx?.background) {
      childSend({
        type: 'resource-op', id: m.id,
        error: '后台任务链中没有确认人在场。能力变更请在工作空间会话中直接提出，由你本人确认。',
      });
      return true;
    }
    // ref 校验前置（F3）：updateCapabilities 是唯一携带可校验引用的确认档 op——
    // 幽灵 ref 直接回错不弹卡（用户不为注定失败的变更做裁决）；op 内保留同一
    // 校验纵深防御（validateCapabilityRefs 单一真相源）
    if (op === 'updateCapabilities') {
      try {
        await validateCapabilityRefs(args['add'], args['remove'], workspaceId);
      } catch (err) {
        childSend({ type: 'resource-op', id: m.id, error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    const payload = buildConfirmPayload(op, args, workspaceId);
    if (!payload) {
      // 档位与载荷构建不一致（不可达防御）：fail-closed 拒绝而非放行
      childSend({ type: 'resource-op', id: m.id, error: `确认载荷构建失败: ${op}` });
      return true;
    }
    try {
      const outcome = await requestAgentOpConfirm(payload, ctx?.childKey ?? 'no-child-key');
      if (!outcome.allowed) {
        childSend({
          type: 'resource-op', id: m.id,
          error: `用户拒绝了本次变更${outcome.reason ? `：${outcome.reason}` : ''}`,
        });
        return true;
      }
    } catch (err) {
      // 确认通道异常（理论路径）：按拒绝收敛回子进程，杜绝 unhandledRejection
      childSend({
        type: 'resource-op', id: m.id,
        error: `确认通道异常，已拒绝：${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
  }
  try {
    // 测试注入点不得来自不可信输入：deps 恒 undefined（仅测试注入），ctx 透传
    const result = await executor(op, args, workspaceId, undefined, ctx);
    notifyResourceOpSucceeded(op);
    childSend({ type: 'resource-op', id: m.id, result: result ?? null });
  } catch (err) {
    // 收敛任意 throwable 为文本（裸 string rejection 会误判成功——mcp 桥 throwableText 同款）
    childSend({ type: 'resource-op', id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/** op 成功后的刷新广播：只读 op（list / listModels / describeAgent）不广播；
 *  写 op 恒发 resource:changed，member 类叠加 agent:runtimeChanged */
export function notifyResourceOpSucceeded(op: string): void {
  if (READ_ONLY_OPS.has(op)) return;
  broadcastResourceChanged();
  if (memberAffecting(op)) {
    broadcastRuntimeChanged();
  }
}
