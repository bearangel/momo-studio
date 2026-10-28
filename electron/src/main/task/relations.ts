// electron/src/main/task/relations.ts
//
// M3.3 任务关系（父任务 / 依赖边）写路径编排单点（spec 2026-10-29 §2.1）。
//
// 两个入口：
//   - insertTaskWithRelations：创建路径（表单 createTaskFromForm / agent task-tools
//     createTask 同源）——存在性校验 + 事务内全图环检测 + 插行 + 插边，一事务原子
//   - setTaskRelations：task:setRelations 通道——{taskId, parentTaskId?, dependsOn?}
//     字段可选各自更新；dependsOn 全量替换语义，替换前合并图环检测
//
// 环检测图 = 依赖边（task → depends_on）+ 父任务边（child → parent）合并有向图
// （spec §2.3 环矩阵含「跨 parent 链」：纯依赖环 / 纯父链环 / 交叉环全拒）。
//
// 并发写竞态（spec §4 风险表）：边写全部走同事务——环检测在事务内重读全图后裁决，
// 本地单进程 IPC 串行 + better-sqlite3 单连接天然串行，无交错窗口。
import { getDb } from '../storage/db';
import {
  insertTask,
  getTask,
  updateTask,
  nextTaskId,
  type TaskRow,
} from '../storage/tasks/repo';
import {
  listDependencyEdges,
  listParentEdges,
  insertDependencyEdges,
  replaceTaskDependencies,
} from '../storage/tasks/dependencies-repo';
import { detectCycle, type GraphEdge } from './dependency-graph';

/** 关系写入入参（创建路径可为空；setRelations 各字段可选各自更新） */
export interface TaskRelationsInput {
  /** 父任务 id；null = 清除（仅 setRelations 有清除语义，创建路径 null = 不设） */
  parentTaskId?: string | null;
  /** 依赖任务 id 列表（直接依赖）；setRelations 语义为全量替换 */
  dependsOn?: string[];
}

/** 依赖边 + 父任务边合并全图（环检测输入） */
function loadCombinedEdges(): GraphEdge[] {
  return [...listDependencyEdges(), ...listParentEdges()];
}

/** 环报错文案：路径首尾相接（T-001 → T-002 → T-001） */
function cycleError(path: string[]): Error {
  return new Error(`存在依赖环：${path.join(' → ')}`);
}

/**
 * 创建路径：插行 + 插边同事务。
 *
 * 校验次序纪律（错误路径零副作用）：存在性校验先于事务；
 * 环检测在事务内重读全图后裁决（新任务 id 事务内预生成——图需要节点名，
 * 新节点不可能被既有边指向，检测实为对存量图与拟写边的合并裁决）。
 * relations 全空时直接走 insertTask（既有行为零变化）。
 */
export function insertTaskWithRelations(
  input: Parameters<typeof insertTask>[0],
  relations: TaskRelationsInput,
): TaskRow {
  const parentTaskId = relations.parentTaskId ?? null;
  const dependsOn = [...new Set(relations.dependsOn ?? [])];
  const hasRelations = parentTaskId !== null || dependsOn.length > 0;
  if (!hasRelations) return insertTask(input);

  if (parentTaskId !== null && !getTask(parentTaskId)) {
    throw new Error(`父任务 ${parentTaskId} 不存在`);
  }
  for (const dep of dependsOn) {
    if (!getTask(dep)) throw new Error(`依赖任务 ${dep} 不存在`);
  }

  const db = getDb();
  const run = db.transaction((): string => {
    const id = input.id ?? nextTaskId(db);
    const newEdges: GraphEdge[] = [
      ...dependsOn.map((dep) => ({ from: id, to: dep })),
      ...(parentTaskId !== null ? [{ from: id, to: parentTaskId }] : []),
    ];
    const cycle = detectCycle(loadCombinedEdges(), newEdges);
    if (cycle) throw cycleError(cycle);
    insertTask({ ...input, id, parentTaskId });
    insertDependencyEdges(id, dependsOn, Date.now());
    return id;
  });
  // 插边后重读——事务内 insertTask 的返回行在插边前派生，blocked 是陈旧值
  return getTask(run())!;
}

/**
 * task:setRelations 单点：{taskId, parentTaskId?, dependsOn?} 各字段可选各自更新。
 *
 * - parentTaskId：存在性 + 非自身校验；null = 清除父任务
 * - dependsOn：存在性 + 非自身校验；全量替换（数组即最终态）
 * - 环检测：合并图 = 全图 −（该任务旧依赖边）−（该任务旧父边）+ 拟写新边
 *   （未触碰的关系保留原边参与裁决）；替换与父任务落列同事务
 * - 两字段都未携带 → 幂等返回当前行（零写入）
 */
export function setTaskRelations(input: {
  taskId: string;
  parentTaskId?: string | null;
  dependsOn?: string[];
}): TaskRow {
  const row = getTask(input.taskId);
  if (!row) throw new Error(`任务 ${input.taskId} 不存在`);
  const touchesParent = input.parentTaskId !== undefined;
  const touchesDeps = input.dependsOn !== undefined;
  if (!touchesParent && !touchesDeps) return row;

  const parentTaskId = touchesParent ? input.parentTaskId : undefined;
  const dependsOn = touchesDeps ? [...new Set(input.dependsOn ?? [])] : undefined;

  if (parentTaskId != null) {
    if (parentTaskId === input.taskId) throw new Error('父任务不能是任务自身');
    if (!getTask(parentTaskId)) throw new Error(`父任务 ${parentTaskId} 不存在`);
  }
  if (dependsOn !== undefined) {
    if (dependsOn.includes(input.taskId)) throw new Error('任务不能依赖自身');
    for (const dep of dependsOn) {
      if (!getTask(dep)) throw new Error(`依赖任务 ${dep} 不存在`);
    }
  }

  // 合并图：被替换的关系（旧依赖边）与被改写的关系（旧父边）分别从现有图剔除
  // （两类边同向时合并后无法区分类型，必须各自过滤），未触碰的关系保留参与裁决
  const depEdges = listDependencyEdges();
  const parentEdges = listParentEdges();
  const existing: GraphEdge[] = [
    ...(touchesDeps ? depEdges.filter((e) => e.from !== input.taskId) : depEdges),
    ...(touchesParent ? parentEdges.filter((e) => e.from !== input.taskId) : parentEdges),
  ];
  const newEdges: GraphEdge[] = [
    ...(dependsOn !== undefined ? dependsOn.map((dep) => ({ from: input.taskId, to: dep })) : []),
    ...(parentTaskId != null ? [{ from: input.taskId, to: parentTaskId }] : []),
  ];
  const cycle = detectCycle(existing, newEdges);
  if (cycle) throw cycleError(cycle);

  const db = getDb();
  const run = db.transaction((): void => {
    if (dependsOn !== undefined) replaceTaskDependencies(input.taskId, dependsOn);
    if (parentTaskId !== undefined) updateTask(input.taskId, { parentTaskId });
  });
  run();
  return getTask(input.taskId)!;
}
