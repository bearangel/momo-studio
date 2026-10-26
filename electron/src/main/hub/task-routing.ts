// electron/src/main/hub/task-routing.ts
//
// M2.1 Task 6：任务执行路由三选（plan 契约区逐字，T7/T8/T9 消费）。
// 本模块是 TaskRouting 的唯一定义点（一义一名）：
//   - tasks 表 routing_json 列的写侧（serialize）与读侧（parse）
//   - task.create IPC 入参校验（validate——异形人话拒绝）
// 兜底哲学（两侧分工，见 tests/hub/task-routing.test.ts）：
//   - 读侧 parseTaskRouting 永不抛：NULL/非法 JSON/未知 mode/字段异形 → {mode:'local'}
//     （路由损坏不炸看板，任务永远可本地执行）
//   - 写侧 IPC 校验要响亮：静默降级会把「想外派」错发本机，错误更晚更贵
// 纯函数零依赖（storage/tasks/repo 反向引用本模块——叶子模块无环）。

/** 任务执行路由三选（契约区逐字；RM-M21-2：落本地 tasks 表，非 hub 协议） */
export type TaskRouting =
  | { mode: 'local' }
  | { mode: 'group'; groupId: string }
  | { mode: 'node'; groupId: string; targetNodeId: string };

const LOCAL: TaskRouting = { mode: 'local' };

/** 类型守卫（未知载荷 → TaskRouting 判定；T8 提交链等消费方复用） */
export function isTaskRouting(v: unknown): v is TaskRouting {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { mode?: unknown; groupId?: unknown; targetNodeId?: unknown };
  switch (r.mode) {
    case 'local':
      return true;
    case 'group':
      return typeof r.groupId === 'string';
    case 'node':
      return typeof r.groupId === 'string' && typeof r.targetNodeId === 'string';
    default:
      return false;
  }
}

/** 规范化：剥未知键，收敛到三个 canonical 形状（isTaskRouting 先行校验） */
function normalizeTaskRouting(r: TaskRouting): TaskRouting {
  switch (r.mode) {
    case 'local':
      return LOCAL;
    case 'group':
      return { mode: 'group', groupId: r.groupId };
    case 'node':
      return { mode: 'node', groupId: r.groupId, targetNodeId: r.targetNodeId };
  }
}

/**
 * routing_json 列 → TaskRouting（读侧，永不抛）。
 * NULL（迁移 069 前旧行 / 未指定创建）→ local；一切异形 → local 兜底。
 */
export function parseTaskRouting(raw: string | null | undefined): TaskRouting {
  if (raw === null || raw === undefined || raw === '') return LOCAL;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTaskRouting(parsed) ? normalizeTaskRouting(parsed) : LOCAL;
  } catch {
    return LOCAL;
  }
}

/** TaskRouting → routing_json 列（写侧；规范化后序列化）。 */
export function serializeTaskRouting(routing: TaskRouting): string {
  // 防御：绕过类型的异形值兜底 local（写侧不产出读侧读不懂的 JSON）
  return JSON.stringify(isTaskRouting(routing) ? normalizeTaskRouting(routing) : LOCAL);
}

/**
 * task.create IPC 入参 routing? 校验：
 *   - undefined → undefined（未指定 = 落列 NULL = 读侧 local 缺省）
 *   - 合法三选一 → 规范化返回（未知键剥除）
 *   - 异形 → 抛人话 Error（IPC 边界契约违反要响亮，不静默降级）
 */
export function validateTaskRoutingInput(input: unknown): TaskRouting | undefined {
  if (input === undefined) return undefined;
  if (!isTaskRouting(input)) {
    throw new Error(
      'routing 形状非法：须为 {mode:"local"} | {mode:"group",groupId} | {mode:"node",groupId,targetNodeId} 之一',
    );
  }
  return normalizeTaskRouting(input);
}
