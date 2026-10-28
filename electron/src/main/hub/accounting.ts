// electron/src/main/hub/accounting.ts
//
// hub 记账面查询单点（M2.4 T5 从 mirror-applier 纯搬移）：
// installed_packages 的 `hub:` 前缀行 → item_type → slug 集。
//
// 分层纪律：本模块只做一次裸查询（无缓存 / 无守卫 / 无自愈）——镜像应用器的
// 自愈链、目录缓存、网络链留在 mirror-applier，本模块不得反向依赖它。
// 消费面：mirror-applier installResources 已装判定 + snapshot-builder resources 段记账反查。

import { getDb } from '../storage/db';

/** hub 记账 item_id 前缀（与 resource/hub/momo-hub 单点对齐——此处独立查询表，
 *  不引 momo-hub 模块避免拉起目录缓存状态）。 */
const HUB_ITEM_ID_PREFIX = 'hub:';

/**
 * installed_packages 的 hub 记账面：item_type → slug 集（M2.3 T5 件2 导出契约化）。
 *
 * 契约：只收 `hub:` 前缀记账行（生产者 = recordPublishAccounting 发布回填 +
 * installHubPackage 安装落账，均 `hub:{slug}` 单点前缀）；marketplace 本地行不入集。
 * 跨模块消费面两处——mirror-applier installResources 已装判定①，及 snapshot-builder
 * resources 段记账反查（此前 builder 私有同款 SQL，M2.3 T5 收口为导入单点，
 * 漂移由 tests/hub/publish-accounting.test.ts 契约锁）。
 */
export function loadHubAccountingSet(): Map<string, Set<string>> {
  const acc = new Map<string, Set<string>>();
  const rows = getDb()
    .prepare('SELECT item_id, item_type FROM installed_packages')
    .all() as Array<{ item_id: string; item_type: string }>;
  for (const row of rows) {
    if (!row.item_id.startsWith(HUB_ITEM_ID_PREFIX)) continue;
    const set = acc.get(row.item_type) ?? new Set<string>();
    set.add(row.item_id.slice(HUB_ITEM_ID_PREFIX.length));
    acc.set(row.item_type, set);
  }
  return acc;
}
