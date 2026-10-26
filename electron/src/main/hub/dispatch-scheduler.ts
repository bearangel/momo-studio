// 组内 least-busy 调度器（M2.1 T7）——纯函数零副作用零 IPC。
// 契约（plan Task 7 逐字）：候选 = members 里 online ∧ mirroredBy.has(nodeId)；
// 排序 runningCount 升序 → nodeId 字典序（localeCompare 显式）；空候选返回 null，
// 不轮询（RM-M21-5——由待派发卡手动「重试派发」驱动重选）。
// mirroredBy 为 T6 镜像登记表查询结果（RM-M21-7），本模块只消费不推导。
// YAGNI：不做权重 / 负载衰减 / 亲和性。groupId/workspaceName 为派发调用方
// 上下文契约字段，选择逻辑不消费。
export interface DispatchInput {
  groupId: string;
  workspaceName: string;
  members: Array<{ nodeId: string; name: string; online: boolean; runningCount: number }>;
  mirroredBy: Set<string>;
}

export function pickWorker(input: DispatchInput): string | null {
  const candidates = input.members.filter((m) => m.online && input.mirroredBy.has(m.nodeId));
  if (candidates.length === 0) return null;
  // 负数 runningCount 防御：脏计数按 0 处理，不因数值小而必胜（与真实 0 平局走 nodeId）
  const load = (n: number): number => Math.max(0, n);
  candidates.sort(
    (a, b) => load(a.runningCount) - load(b.runningCount) || a.nodeId.localeCompare(b.nodeId),
  );
  const [picked] = candidates; // 空候选已在上方提前返回，此处必有值
  return picked?.nodeId ?? null;
}
