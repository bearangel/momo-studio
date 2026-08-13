// momo-hub/src/auth.ts
//
// 简化认证——v1 用静态 token 列表；v2 加用户注册 + JWT。
const VALID_TOKENS = new Set((process.env.HUB_TOKENS ?? '').split(',').filter(Boolean));

export function verifyAuthToken(token: string): boolean {
  if (VALID_TOKENS.size === 0) return true;  // 未配置 = 开发模式允许所有
  return VALID_TOKENS.has(token);
}

const ipRequests = new Map<string, number[]>();
const RATE_LIMIT_RPM = 100;

export const rateLimiter = {
  isLimited(ip: string): boolean {
    const now = Date.now();
    const list = (ipRequests.get(ip) ?? []).filter((ts) => now - ts < 60_000);
    if (list.length >= RATE_LIMIT_RPM) return true;
    list.push(now);
    ipRequests.set(ip, list);
    return false;
  },
};