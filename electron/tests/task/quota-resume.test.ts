// electron/tests/task/quota-resume.test.ts
//
// 配额受限自动续跑（2026-11-04 生产事故）：纯函数面——429 配额失败分类 /
// 重置时间解析（本地时间 + 24h 合理性窗）/ 续跑时刻计算（解析成功 reset+30s，
// 否则按连续次数退避 5/15/30 分钟）。
// 事故样本：HTTP 429 + 「已达到 5 小时的使用上限。您的限额将在 … 重置。」
// 与瞬时限流（服务繁忙、无配额措辞）必须区分——后者行为不变（不自动续跑）。
import { describe, it, expect } from 'vitest';
import {
  isQuotaLimitError,
  parseQuotaResetAt,
  computeQuotaResumeAt,
  QUOTA_RETRY_CAP,
} from '../../src/main/task/quota-resume';

/** 本地时间 YYYY-MM-DD HH:mm:ss（错误体里的重置时间格式） */
function fmtLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 事故同构错误文本（双层：主文案 + ||details|| 段），重置时间动态生成 */
function incidentText(resetAt: Date | null): string {
  const resetSentence = resetAt ? `已达到 5 小时的使用上限。您的限额将在 ${fmtLocal(resetAt)} 重置。` : '已达到今日使用上限，请稍后再试。';
  return (
    '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
    '\n||details||\n' +
    `HTTP 429 {"error":{"code":"1308","message":"${resetSentence}"}}`
  );
}

describe('quota-resume 纯函数：isQuotaLimitError（429 + 配额措辞 = QUOTA_LIMITED）', () => {
  it('事故同构文本（429 + 使用上限 + 重置句）→ 判定为配额受限', () => {
    expect(isQuotaLimitError(incidentText(new Date(Date.now() + 2 * 3600_000)))).toBe(true);
  });

  it('429 + 配额措辞但无重置时间 → 仍判定配额受限（走退避模式）', () => {
    expect(isQuotaLimitError(incidentText(null))).toBe(true);
  });

  it('429 + 配额措辞（将于 变体前缀）→ 判定配额受限', () => {
    const t = new Date(Date.now() + 3600_000);
    const text = `HTTP 429 {"error":{"message":"额度已用完，将于 ${fmtLocal(t)} 重置"}}`;
    expect(isQuotaLimitError(text)).toBe(true);
  });

  it('瞬时限流 429（服务繁忙、无配额措辞）→ 非配额（行为不变）', () => {
    const text =
      '模型服务连接失败：服务繁忙（限流），请稍后重试（已自动重试 5 次）。本轮未完成，发送「继续」可从断点恢复' +
      '\n||details||\n' +
      'HTTP 429 {"error":{"message":"Too many requests, please retry later"}}';
    expect(isQuotaLimitError(text)).toBe(false);
  });

  it('非 429 状态码（500/401）即使含「上限」字样 → 非配额', () => {
    expect(isQuotaLimitError('HTTP 500 {"error":{"message":"已达到内部上限"}}')).toBe(false);
    expect(isQuotaLimitError('HTTP 401 unauthorized')).toBe(false);
  });

  it('空串 / 缺 details 段的纯主文案 → 非配额', () => {
    expect(isQuotaLimitError('')).toBe(false);
    expect(isQuotaLimitError('模型服务连接失败：服务繁忙（限流），请稍后重试')).toBe(false);
  });
});

describe('quota-resume 纯函数：parseQuotaResetAt（本地时间 + 合理性窗）', () => {
  it('解析「将在 YYYY-MM-DD HH:mm:ss 重置」为本地时间戳', () => {
    const reset = new Date(Date.now() + 2 * 3600_000);
    // 秒级对齐（错误体只有秒精度，解析产物应与构造值毫秒差 < 1000）
    const ts = parseQuotaResetAt(incidentText(reset), Date.now());
    expect(ts).not.toBeNull();
    expect(Math.abs(ts! - reset.getTime())).toBeLessThan(1000);
  });

  it('解析「将于 … 重置」变体（设计文档措辞）', () => {
    const reset = new Date(Date.now() + 3600_000);
    const text = `模型服务连接失败：配额上限\n||details||\nHTTP 429 {"message":"您的额度将于 ${fmtLocal(reset)} 重置"}`;
    const ts = parseQuotaResetAt(text, Date.now());
    expect(ts).not.toBeNull();
    expect(Math.abs(ts! - reset.getTime())).toBeLessThan(1000);
  });

  it('过去的时间（垃圾解析）→ null（降级退避）', () => {
    const past = new Date(Date.now() - 3600_000);
    expect(parseQuotaResetAt(incidentText(past), Date.now())).toBeNull();
  });

  it('超过 24h 的荒谬时间 → null（降级退避）', () => {
    const far = new Date(Date.now() + 30 * 24 * 3600_000);
    expect(parseQuotaResetAt(incidentText(far), Date.now())).toBeNull();
  });

  it('无重置句 → null', () => {
    expect(parseQuotaResetAt(incidentText(null), Date.now())).toBeNull();
  });
});

describe('quota-resume 纯函数：computeQuotaResumeAt（reset+30s / 退避 5→15→30 分钟）', () => {
  const NOW = 1_770_000_000_000;

  it('解析成功 → resetTime + 30s（不随次数升级）', () => {
    const resetAt = NOW + 2 * 3600_000;
    for (const count of [0, 1, 2]) {
      expect(computeQuotaResumeAt(count, resetAt, NOW)).toBe(resetAt + 30_000);
    }
  });

  it('解析失败（退避模式）：第 1/2/3 次 → now+5min/+15min/+30min', () => {
    expect(computeQuotaResumeAt(0, null, NOW)).toBe(NOW + 5 * 60_000);
    expect(computeQuotaResumeAt(1, null, NOW)).toBe(NOW + 15 * 60_000);
    expect(computeQuotaResumeAt(2, null, NOW)).toBe(NOW + 30 * 60_000);
  });

  it('重试上限导出为 3（连续配额自动续跑最多 3 次）', () => {
    expect(QUOTA_RETRY_CAP).toBe(3);
  });
});
