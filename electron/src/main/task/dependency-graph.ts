// electron/src/main/task/dependency-graph.ts
//
// M3.3 任务依赖图纯模块（spec 2026-10-29 §2.1）——环检测 + 未完成依赖计算。
//
// 设计要点：
//   - 纯函数、零依赖（不 import DB / repo）——storage 与 task 两层都可消费的叶子模块，
//     单测不需要任何夹具数据库
//   - 图的边统一为 { from, to } 有向边，语义为「from 受 to 约束」：
//       依赖边：task → depends_on（任务等待依赖完成）
//       父任务边：child → parent（子任务挂在父任务之下）
//     两类边并入同一张图做环检测（spec §2.3 环矩阵含「跨 parent 链」——
//     纯父链环 / 纯依赖环 / 依赖边 + 父链交叉环全部要拒绝）
//   - detectCycle 是写路径唯一环检测消费点：所有关系写入（create / setRelations /
//     task-tools）在落库前把「现有全图 + 拟写新边」交给它裁决
//   - 返回环路径（节点序列，首尾相接）供人话报错，null = 无环

/** 图的有向边：from 受 to 约束（依赖边 task→depends_on；父任务边 child→parent） */
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * 在「现有边 + 拟写新边」合并图上检测环（DFS 三色标记）。
 *
 * 返回环路径（如 ['T-001', 'T-002', 'T-003', 'T-001']，首尾相接便于直接 join 成
 * 报错文案）；无环返回 null。自环（from === to）返回 [id, id]。
 */
export function detectCycle(
  existingEdges: ReadonlyArray<GraphEdge>,
  newEdges: ReadonlyArray<GraphEdge>,
): string[] | null {
  // 邻接表：from → to 列表（重复边幂等，Set 去重）
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (edge: GraphEdge): void => {
    let targets = adjacency.get(edge.from);
    if (!targets) {
      targets = new Set<string>();
      adjacency.set(edge.from, targets);
    }
    targets.add(edge.to);
  };
  for (const edge of existingEdges) addEdge(edge);
  for (const edge of newEdges) addEdge(edge);

  // DFS 三色：white（未访问）/ gray（在当前栈中）/ black（已完成，子树无环）
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  // 当前 DFS 栈（用于撞到 gray 节点时回溯出环路径）
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        // 撞回栈中节点 = 成环：从栈中 next 的位置切出环段，闭合回 next
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (nextColor === WHITE) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      }
      // BLACK：子树已确认无环，跳过
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * 计算任务的未完成直接依赖（blocked 派生态的唯一语义源，spec §2.1：
 * 「依赖中 status NOT IN (completed)」——只有 completed 解锁，其余八态均视为未完成）。
 *
 * @param taskId 目标任务 id
 * @param edges  该任务的直接依赖边集（from === taskId 的边参与计算）
 * @param statusOf 依赖 id → 当前状态；查无行（悬挂边，仅手工 SQL 可造）返回 undefined，
 *                 与派发闸 SQL 的 NOT EXISTS 口径一致——按「不阻塞」处理
 * @returns 未完成依赖的 id 列表（保持 edges 中的出现顺序）
 */
export function unsatisfiedDeps(
  taskId: string,
  edges: ReadonlyArray<GraphEdge>,
  statusOf: (id: string) => string | undefined,
): string[] {
  const result: string[] = [];
  for (const edge of edges) {
    if (edge.from !== taskId) continue;
    const status = statusOf(edge.to);
    // 悬挂边（依赖行不存在）不阻塞——与 peekNextAssigned 的 NOT EXISTS 半连接口径对齐
    if (status !== undefined && status !== 'completed') {
      result.push(edge.to);
    }
  }
  return result;
}
