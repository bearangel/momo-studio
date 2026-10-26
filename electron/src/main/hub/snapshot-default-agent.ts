// electron/src/main/hub/snapshot-default-agent.ts
//
// 快照「默认 agent」可选段（M2.1 真机验收 D2 修复）——studio 侧本地携带 + 提取。
// 语义：源工作空间 workspaces.default_agent_instance_id 指向的成员（agent 名）
// 跨节点镜像；应用器按名对齐重建后的成员实例并回写目标默认位——委派
// resolveAgentInstance 的无 agentSlug 兜底链（组内调度/指定节点不指派时的
// 唯一解析路径）在新镜像 worker 上不再必拒。
// 携带键=成员名（与 teams leader/members 对齐键同源——instanceId 是本机 DB
// 行 id，跨节点无意义）。
//
// 段纪律与 snapshot-model-binding 同款：pin 版 validateSnapshotManifest 按
// 「未知容忍（剥除）」剥掉本段——应用器从归档内**原始** manifest.json 提取
// （extractSnapshot 绕经 pin 校验器），hub 侧存档字节原样保留该段。
import type { WorkspaceSnapshotConfig } from './protocol';

/** 构建侧 manifest config 类型：pin 七子段 + defaultAgent 可选段（builder/applier 共用）。 */
export type SnapshotConfigWithDefaultAgent = WorkspaceSnapshotConfig & {
  defaultAgent?: string;
};

/** 成员名上限（与 mirror-applier MAX_WORKSPACE_NAME 同界——名字行同为展示键）。 */
const DEFAULT_AGENT_NAME_MAX = 128;

/**
 * 从 manifest.json 的**原始** config 对象提取 defaultAgent。
 * 返回 null = 段缺省（旧快照，向后兼容）或形态非法（按缺省处理，不阻断镜像）。
 */
export function extractDefaultAgent(configRaw: unknown): string | null {
  if (typeof configRaw !== 'object' || configRaw === null || Array.isArray(configRaw)) return null;
  const seg = (configRaw as Record<string, unknown>)['defaultAgent'];
  if (seg === undefined) return null;
  if (typeof seg !== 'string' || seg.length === 0 || seg.length > DEFAULT_AGENT_NAME_MAX) return null;
  return seg;
}
