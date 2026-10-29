// electron/src/main/hub/accounting.ts
//
// hub 记账面查询单点（M2.4 T5 从 mirror-applier 纯搬移；M3.4 B13 扩含 version）：
// installed_packages 的 `hub:` 前缀行 → item_type → slug → 记账版本。
//
// 分层纪律：本模块只做一次裸查询（无缓存 / 无守卫 / 无自愈）——镜像应用器的
// 自愈链、目录缓存、网络链留在 mirror-applier，本模块不得反向依赖它。
// 消费面：mirror-applier installResources 已装/升级判定 + snapshot-builder resources 段记账反查。

import { getDb } from '../storage/db';

/** hub 记账 item_id 前缀（与 resource/hub/momo-hub 单点对齐——此处独立查询表，
 *  不引 momo-hub 模块避免拉起目录缓存状态）。 */
const HUB_ITEM_ID_PREFIX = 'hub:';

/**
 * installed_packages 的 hub 记账面（M3.4 B13 起含版本）：item_type → slug → 记账版本。
 *
 * 契约：只收 `hub:` 前缀记账行（生产者 = recordPublishAccounting 发布回填 +
 * installHubPackage 安装落账，均 `hub:{slug}` 单点前缀）；marketplace 本地行不入集。
 * 版本源：行的 version 列（发布回填 = 发布版本；安装落账 = 实装版本）——快照
 * builder 以此钉死 resources[].version（快照定型语义），applier 以此判定
 * 「已装 ≥ pinned → alreadyLatest / 已装 < pinned → 升级」。行 version 列理论
 * 可为空串（历史脏行）——此时映射为空串照常入集，消费方自行兜底（builder 不写
 * version 字段 = 旧 latest 语义；applier 对空串记账版本视为可升级）。
 * 跨模块消费面两处——mirror-applier installResources 判定①，及 snapshot-builder
 * resources 段记账反查（漂移由 tests/hub/publish-accounting.test.ts 契约锁）。
 */
export function loadHubAccountingSet(): Map<string, Map<string, string>> {
  const acc = new Map<string, Map<string, string>>();
  const rows = getDb()
    .prepare('SELECT item_id, item_type, version FROM installed_packages')
    .all() as Array<{ item_id: string; item_type: string; version: string }>;
  for (const row of rows) {
    if (!row.item_id.startsWith(HUB_ITEM_ID_PREFIX)) continue;
    const slug = row.item_id.slice(HUB_ITEM_ID_PREFIX.length);
    const bySlug = acc.get(row.item_type) ?? new Map<string, string>();
    bySlug.set(slug, row.version);
    acc.set(row.item_type, bySlug);
  }
  return acc;
}
