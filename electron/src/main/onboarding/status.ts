// electron/src/main/onboarding/status.ts
//
// 引导一次性状态（kv_store，spec 2026-10-10 §4）。
// 读写先例：upgrade/legacy-upgrade.ts 的 LEGACY_UPGRADE_NOTICE_KEY——
// 容错读（畸形值按缺省处理，绝不阻塞启动）+ 幂等写（upsert）。
import { getDb } from '../storage/db';

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
