// electron/src/main/agent/resource-ops-bridge.ts
//
// resource-ops 桥（spec §6）。子进程侧 requestResourceOp 复刻 mcp-bridge 全部教训
// （id 配对 + 30s 超时 + process.send 方法调用式绑定铁律）；主进程侧
// handleResourceOpMessage 供 runtime-spawner 的子进程 message 路由调用。
import { randomUUID } from 'node:crypto';
import { executeResourceOp, RESOURCE_OP_NAMES } from './resource-ops';
import { broadcastRuntimeChanged } from '../im/session-service';
import { broadcastResourceChanged } from '../resource/changed-emit';

const RESOURCE_OP_TIMEOUT_MS = 30_000;

/** 子进程侧：请求主进程执行一个 resource op */
export function requestResourceOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  // 铁律：process.send 必须以方法调用形式调用（this=undefined 会炸——§8.4 教训）
  const send = (process as { send?: (m: unknown) => void }).send?.bind(process);
  if (typeof send !== 'function') {
    return Promise.reject(new Error('资源创建不可用：子进程未建立 IPC 通道'));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`resource op ${op} 超时（${RESOURCE_OP_TIMEOUT_MS / 1000}s）`));
    }, RESOURCE_OP_TIMEOUT_MS);
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

/** 影响成员/团队可见性的 op——成功后额外广播既有 agent:runtimeChanged（MainLayout 已监听） */
export const MEMBER_AFFECTING_OPS = ['createAgent', 'addMember', 'createTeam'] as const;

/** 只读 op——成功后不触发任何刷新广播（list / listModels 高频且无状态变更；技能还
 *  强制「创建前先盘点」，无差别广播会让 renderer 三 store 每次白重拉） */
const READ_ONLY_OPS: ReadonlySet<string> = new Set(['list', 'listModels']);

type OpExecutor = (op: string, args: unknown, workspaceId: string) => Promise<unknown>;

/**
 * 主进程侧消息分支：消费 type='resource-op' 的子进程消息。
 * workspaceId 取自 per-child spawn 上下文（调用方闭包）——消息内 workspaceId 一律忽略。
 * 返回是否消费（false = 交还其它分支）。可注入 executor 供测试。
 */
export async function handleResourceOpMessage(
  msg: unknown,
  workspaceId: string,
  childSend: (m: unknown) => void,
  executor: OpExecutor = executeResourceOp,
): Promise<boolean> {
  const m = msg as { type?: string; id?: unknown; op?: unknown; args?: unknown };
  if (m?.type !== 'resource-op' || typeof m.id !== 'string') return false;
  const op = typeof m.op === 'string' ? m.op : '';
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    childSend({ type: 'resource-op', id: m.id, error: `未知 resource op: ${op}` });
    return true;
  }
  try {
    // 测试注入点不得来自不可信输入：executor 恒以三参调用，第 4 参 deps 仅测试注入
    const result = await executor(op, m.args ?? {}, workspaceId);
    notifyResourceOpSucceeded(op);
    childSend({ type: 'resource-op', id: m.id, result: result ?? null });
  } catch (err) {
    // 收敛任意 throwable 为文本（裸 string rejection 会误判成功——mcp 桥 throwableText 同款）
    childSend({ type: 'resource-op', id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/** op 成功后的刷新广播：只读 op（list / listModels）不广播；写 op 恒发 resource:changed，
 *  member 类叠加 agent:runtimeChanged */
export function notifyResourceOpSucceeded(op: string): void {
  if (READ_ONLY_OPS.has(op)) return;
  broadcastResourceChanged();
  if ((MEMBER_AFFECTING_OPS as readonly string[]).includes(op)) {
    broadcastRuntimeChanged();
  }
}
