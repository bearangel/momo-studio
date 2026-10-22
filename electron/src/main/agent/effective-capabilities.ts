// electron/src/main/agent/effective-capabilities.ts
//
// 成员生效能力批量查询（spec 2026-10-22 §6.1）：UI 展示 = 实际能用。
//
// 同源铁律：必须调用 spawn 路径（spawn-helpers.ts）的同一个 mergeCapabilities，
// 且读取同两层门面 readAllocationLayer / readAssignmentDeltas——展示侧禁止
// 重实现合并规则，否则「显示可用」与「运行时 allowedTools」会漂移。
//
// 省略语义：未知 / 已移出的 instanceId 条目直接省略（不抛错、不填空壳），
// 消费方（renderer）据此降级为定义级徽标，而非把空壳当真实能力。
import { getAgentDefinition, getMemberByInstanceId } from './agent-queries';
import {
  mergeCapabilities,
  readAllocationLayer,
  readAssignmentDeltas,
  type MergedCapabilities,
} from './capability-merger';

/**
 * 批量查询成员的生效能力（三层合并，与 spawn 同源）。
 * 返回 Record<instanceId, MergedCapabilities>；未知 / 定义缺失的 id 不出现在结果中。
 * allocation 层按**成员自身 workspaceId** 读取，不用调用方上下文。
 */
export function getEffectiveCapabilities(
  instanceIds: string[],
): Record<string, MergedCapabilities> {
  const out: Record<string, MergedCapabilities> = {};
  for (const id of instanceIds) {
    const member = getMemberByInstanceId(id);
    // 未知 / 已移出成员：条目省略，renderer 降级 def 级徽标
    if (!member) continue;
    const def = getAgentDefinition(member.agentDefinitionId);
    // 成员行指向的定义缺失（脏数据/定义删除竞态）：同样省略，不抛错炸整批
    if (!def) continue;
    out[id] = mergeCapabilities(
      def,
      readAllocationLayer(member.workspaceId),
      readAssignmentDeltas(id),
    );
  }
  return out;
}