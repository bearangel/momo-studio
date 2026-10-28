// renderer/src/lib/task-graph.ts
//
// M3.3 任务依赖图分层纯模块（spec 2026-10-29 §2.2 DAG 视图）：
//   - 边源：TaskRow.blockedBy——主进程派生的「未完成直接依赖」列表（已完成
//     依赖自然出列，DAG 视图呈现的是**当前阻塞结构**而非全量历史拓扑：
//     依赖完成后后继任务会左移塌层，这是派生态口径的预期行为而非 bug）
//   - Kahn 分层：层号 = 拓扑深度，任务的全部可见依赖都落在更靠左的层后才入层
//   - 环回退：写路径环检测（task:setRelations / createBatch 同事务）理论已拦，
//     但数据异常（如手工改库）时不可炸视图——hasCycle=true 并整图平铺单层
//   - 依赖指向不可见任务（被搜索/指派人过滤掉、或已归档不在列表）→ 该边忽略
//     （视为无依赖进第 1 层；否则任务会因永远等不到的依赖而丢失）
import type { TaskRow } from '../ipc/types';

/** 分层结果：layers 下标即层号（0 = 起点层）；hasCycle=true 时 layers 为整图平铺单层 */
export interface TaskGraphLayering {
  layers: TaskRow[][];
  hasCycle: boolean;
}

/**
 * 按 blockedBy 依赖边做 Kahn 分层拓扑。
 * 层内保持输入序（列内卡片排序仍由 BoardColumn 的 sortColumn 单源决定）；
 * 空图返回空层数组。纯函数无副作用。
 */
export function layerTasks(tasks: TaskRow[]): TaskGraphLayering {
  if (tasks.length === 0) return { layers: [], hasCycle: false };

  // 可见任务 id 集：边只对集合内任务生效（不可见依赖视为无依赖）
  const visible = new Set(tasks.map((t) => t.id));
  // 邻接表：依赖（被依赖方 id）→ 依赖它的任务 id 列表
  const dependents = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  // 入度：每个任务的可见未完成依赖数
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const dep of t.blockedBy ?? []) {
      if (!visible.has(dep)) continue;
      dependents.get(dep)!.push(t.id);
      indegree.set(t.id, indegree.get(t.id)! + 1);
    }
  }

  // Kahn 逐层收割：每轮取当前入度 0 的任务，剥边后产生下一轮候选
  const depthOf = new Map<string, number>();
  let frontier: string[] = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      depthOf.set(id, depth);
      for (const dependent of dependents.get(id)!) {
        const remain = indegree.get(dependent)! - 1;
        indegree.set(dependent, remain);
        if (remain === 0) next.push(dependent);
      }
    }
    frontier = next;
    depth += 1;
  }

  // 有任务永远到不了 0 入度 = 依赖边成环 → 整图平铺单层（保输入序）
  if (depthOf.size < tasks.length) {
    return { layers: [tasks], hasCycle: true };
  }

  const layers: TaskRow[][] = [];
  for (let i = 0; i < depth; i++) {
    layers.push(tasks.filter((t) => depthOf.get(t.id) === i));
  }
  return { layers, hasCycle: false };
}
