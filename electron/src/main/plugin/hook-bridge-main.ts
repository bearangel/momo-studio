// electron/src/main/plugin/hook-bridge-main.ts
//
// 插件桥主进程三分支（spec §5.2-5.3，范式 C：独立导出 + respond 注入——契约
// 测试不经真实 fork，mcp-spawner-bridge 同款形态）。消费判定返回 true；字段
// 全部 String()/?? 收敛（IPC 类型漂移防线）。hook_calls 归因走 HookBus 分发
// 观察者（wireHookBridgeAudit 一次性接线——每 handler 每插件一条，spec §5.4）。
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { enforceHookCallsQuota, HOOK_CALLS_ENFORCE_INTERVAL } from '../audit/quota';
import type { HookBus } from './hook-bus';
import { callPluginService } from './service-manager';

interface PluginBridgeMsg {
  type?: unknown;
  id?: unknown;
  workspaceId?: unknown;
  toolName?: unknown;
  args?: unknown;
  pluginId?: unknown;
  method?: unknown;
  params?: unknown;
  success?: unknown;
  durationMs?: unknown;
}

function asArgs(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 接线 hook_calls 审计（app 启动时调一次；观察者内自捕获异常不拖分发） */
let hookCallInsertCount = 0;

export function wireHookBridgeAudit(bus: HookBus): void {
  bus.setDispatchObserver((rec) => {
    try {
      getDb()
        .prepare(
          `INSERT INTO hook_calls (id, plugin_id, event, matcher, decision, duration_ms, success)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.pluginId,
          rec.event,
          rec.matcher ?? null,
          rec.decision ? JSON.stringify(rec.decision) : null,
          rec.durationMs,
          rec.success ? 1 : 0,
        );
      // M3：写入时计数巡检（超 50k 行滚动删除至 95%，hook_calls 无 workspace 维度）
      if (++hookCallInsertCount % HOOK_CALLS_ENFORCE_INTERVAL === 0) {
        enforceHookCallsQuota();
      }
    } catch (err) {
      logger.warn('hook_calls 落库失败（降级）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** 分发主入口：消费返回 true（已处理），false = 非本族消息交回原 messageHandler */
export async function handlePluginBridgeMsg(
  msg: unknown,
  respond: (payload: unknown) => void,
  bus: HookBus,
): Promise<boolean> {
  const m = (msg ?? {}) as PluginBridgeMsg;
  const type = typeof m.type === 'string' ? m.type : '';

  if (type === 'plugin:preToolUse') {
    if (typeof m.id !== 'string') return false;
    try {
      const decision = await bus.dispatchPreToolUse({
        workspaceId: String(m.workspaceId ?? ''),
        toolName: String(m.toolName ?? ''),
        args: asArgs(m.args),
      });
      respond({ id: m.id, decision });
    } catch (err) {
      logger.error('preToolUse waterfall 失败（fail-open 直通）', {
        error: err instanceof Error ? err.message : String(err),
      });
      respond({ id: m.id, decision: null });
    }
    return true;
  }

  if (type === 'plugin:callService') {
    if (typeof m.id !== 'string') return false;
    try {
      const result = await callPluginService(
        String(m.pluginId ?? ''),
        String(m.method ?? ''),
        (m.params ?? {}) as unknown,
      );
      respond({ id: m.id, result: result === undefined ? null : result });
    } catch (err) {
      respond({ id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (type === 'plugin:postToolUse') {
    void bus
      .dispatchAwait(m.success === false ? 'postToolUseFailure' : 'postToolUse', {
        workspaceId: String(m.workspaceId ?? ''),
        toolName: String(m.toolName ?? ''),
        args: asArgs(m.args),
        success: m.success !== false,
        durationMs: Number(m.durationMs ?? 0) || 0,
      })
      .catch(() => undefined);
    return true;
  }

  return false;
}
