// electron/src/main/hub/snapshot-model-binding.ts
//
// 快照「默认模型绑定」可选段（D4/T16b）——pin 补位纪律（同 mirror-wire.ts 先例）：
// 协议 pin（github:bearangel/momo-hub#35035ce）的 WorkspaceSnapshotConfig 尚无
// modelBinding 可选段（hub 仓 feat/m2-workgroups 已扩展、待 M2f 定版随 pin 升级收敛）。
// 在此之前，本模块按「协议引用经 hub/protocol 入口」的纪律补位：段结构与校验规则
// 与 momo-hub src/groups.ts 逐字对齐（两仓同步义务：hub 侧改规则必须同步此处）。
//
// 语义：源节点「设置 → 默认模型」的全局默认对话模型（defaultChatModel）跨节点镜像。
// provider 为 platform 形态（与 providerRefs 同口径——providerId 是本机 DB 行 id，
// 跨节点无意义）；model 对齐设置域 DefaultModelRef.modelId。不含 key（红线）。
import type { WorkspaceSnapshotConfig } from './protocol';

/** 模型绑定段（与 hub 仓 SnapshotModelBinding 逐字对齐）。 */
export interface SnapshotModelBinding {
  provider: string;
  model: string;
}

/** 构建侧 manifest config 类型：pin 七子段 + modelBinding 可选段（builder/applier 共用）。 */
export type SnapshotConfigWithModelBinding = WorkspaceSnapshotConfig & {
  modelBinding?: SnapshotModelBinding;
};

const PROVIDER_NAME_MAX = 64; // 与 hub groups.ts PROVIDER_NAME_MAX 对齐
const MODEL_NAME_MAX = 200; // 与 hub groups.ts MODEL_NAME_MAX 对齐

function isBoundedStr(x: unknown, max: number): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= max;
}

/**
 * 从 manifest.json 的**原始** config 对象提取 modelBinding（绕经 pin 校验器——
 * pin 版 validateSnapshotManifest 会按「未知容忍（剥除）」剥掉本段）。
 * 返回 null = 段缺省（1.2.0 旧快照，向后兼容）或形态非法（按缺省处理，不阻断镜像）。
 */
export function extractModelBinding(configRaw: unknown): SnapshotModelBinding | null {
  if (typeof configRaw !== 'object' || configRaw === null || Array.isArray(configRaw)) return null;
  const seg = (configRaw as Record<string, unknown>)['modelBinding'];
  if (seg === undefined) return null;
  if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) return null;
  const rec = seg as Record<string, unknown>;
  if (!isBoundedStr(rec['provider'], PROVIDER_NAME_MAX)) return null;
  if (!isBoundedStr(rec['model'], MODEL_NAME_MAX)) return null;
  return { provider: rec['provider'], model: rec['model'] };
}
