// renderer/src/lib/url-guard.ts
// 与 electron/src/main/util/url-guard.ts 同构（双端契约）：https 任意 + http 仅回环。
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

export function isHttpsOrLoopbackHttp(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
