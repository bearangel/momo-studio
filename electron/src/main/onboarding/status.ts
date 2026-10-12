// electron/src/main/onboarding/status.ts
//
// 引导一次性状态（kv_store，spec 2026-10-10 §4）。
// 读写先例：upgrade/legacy-upgrade.ts 的 LEGACY_UPGRADE_NOTICE_KEY——
// 容错读（畸形值按缺省处理，绝不阻塞启动）+ 幂等写（upsert）。
import { getDb } from '../storage/db';
import { logger } from '../logger';

export const ONBOARDING_STATUS_KEY = 'onboarding.status';

export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

const VALID: readonly OnboardingStatus[] = ['pending', 'completed', 'skipped'];

/** 读引导状态；无标记 / 畸形值一律回 pending（新装语义，UI 不因坏值崩溃） */
export function readOnboardingStatus(): OnboardingStatus {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(ONBOARDING_STATUS_KEY) as { value: string } | undefined;
  if (!row) return 'pending';
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed === 'string' && (VALID as readonly string[]).includes(parsed)) {
      return parsed as OnboardingStatus;
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

/** 完成或跳过时写终态；upsert 幂等 */
export function markOnboardingDone(skipped: boolean): void {
  const value: OnboardingStatus = skipped ? 'skipped' : 'completed';
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(ONBOARDING_STATUS_KEY, JSON.stringify(value));
}

/**
 * D8（走查 2026-10-12）：pending 且已存在工作空间 → 就地写 completed 并返回。
 * 场景：引导中途被强杀但工作空间已建成的用户（如供应商步骤锁死后逃生），
 * status 永远 pending——若日后删光工作空间并重启，欢迎页会「复活」，把已
 * 完成初始配置的用户重上新手村。已有工作空间 = 初始配置已发生的充分判据，
 * 读时自愈（无需 reset API，getStatus 为唯一消费入口）。
 */
export function selfHealOnboardingStatus(): OnboardingStatus {
  const status = readOnboardingStatus();
  if (status !== 'pending') return status;
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
  if (row.n === 0) return 'pending';
  markOnboardingDone(false);
  logger.info('onboarding 状态自愈：pending → completed（工作空间已存在）');
  return 'completed';
}
