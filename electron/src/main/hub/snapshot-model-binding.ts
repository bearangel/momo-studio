// electron/src/main/hub/snapshot-model-binding.ts
//
// 快照「默认模型绑定」可选段（D4/T16b）——studio 侧本地镜像 + 提取逻辑。
// 单源指针：momo-hub src/groups.ts 的 SnapshotModelBinding 与校验限
// （PROVIDER_NAME_MAX=64 / MODEL_NAME_MAX=200）@ v0.1.2（tag，commit 70ec124）
// ——值逐字一致。pin v0.1.2 dist 已含该段导出；本模块保留（M2f T17 裁定）：
// extractModelBinding / SnapshotConfigWithModelBinding 为 studio 本地逻辑与类型
// （builder/applier 共用），不随 pin 收敛。
//
// 语义：源节点「设置 → 默认模型」的全局默认对话模型（defaultChatModel）跨节点镜像。
// provider 为 platform 形态（与 providerRefs 同口径——providerId 是本机 DB 行 id，
// 跨节点无意义）；model 对齐设置域 DefaultModelRef.modelId。不含 key（红线）。
//
// M5.3 F2 新增 member 级段：SnapshotAgentMember.modelBinding?（每 agent 模型绑定
// 跨节点按名对齐——providerName/platform/modelName 三键）。pin 校验器对成员条目
// 未知字段剥除（agentMembersFrom 白名单重建，无 modelBinding 键）——与全局段同款
// 「原始 manifest 提取」补位纪律：builder 原样携带、applier 从 rawConfig 提取。
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

/**
 * M5.3 F2 member 级模型绑定段：源 agent 定义的每-agent 绑定（modelProviderId 是
 * 本机 DB 行 id，跨节点无意义——按 providerName/platform 双键对齐）。
 * 不含 key（红线，key 永在 keychain）。
 */
export interface SnapshotMemberModelBinding {
  /** 源 provider 用户名（对齐键①——目标同名 provider 优先） */
  providerName: string;
  /** 协议族（对齐键②——同名未命中时同 platform 兜底） */
  platform: 'openai' | 'anthropic';
  /** 模型 id（对齐键——精确匹配大小写敏感） */
  modelName: string;
}

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

/**
 * M5.3 F2：从 manifest.json 的**原始** config.agentMembers 提取每成员 modelBinding
 * （member 名 → 绑定段；与 extractModelBinding 同款「绕 pin 校验器」纪律）。
 * 段缺省/形态非法的成员不入表（按无段处理，不阻断镜像）；platform 限
 * 'openai' | 'anthropic' 两值（协议族枚举外按非法剥除）。
 */
export function extractMemberModelBindings(configRaw: unknown): Map<string, SnapshotMemberModelBinding> {
  const out = new Map<string, SnapshotMemberModelBinding>();
  if (typeof configRaw !== 'object' || configRaw === null || Array.isArray(configRaw)) return out;
  const members = (configRaw as Record<string, unknown>)['agentMembers'];
  if (!Array.isArray(members)) return out;
  for (const m of members) {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
    const rec = m as Record<string, unknown>;
    const name = rec['name'];
    const seg = rec['modelBinding'];
    if (typeof name !== 'string' || typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
    const b = seg as Record<string, unknown>;
    const platform = b['platform'];
    if (!isBoundedStr(b['providerName'], PROVIDER_NAME_MAX)) continue;
    if (!isBoundedStr(b['modelName'], MODEL_NAME_MAX)) continue;
    if (platform !== 'openai' && platform !== 'anthropic') continue;
    out.set(name, { providerName: b['providerName'], platform, modelName: b['modelName'] });
  }
  return out;
}
