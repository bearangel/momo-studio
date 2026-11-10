// electron/src/main/util/url-guard.ts
//
// 共享 URL 准入判定（OAuth / LLM provider / MCP 三处同口径）。
// 口径：https 任意主机；http 仅回环（本地研发场景）。
// 注意：0.0.0.0 视为回环是既有语义（provider-crud 先例），但**监听**永不 bind 0.0.0.0。

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

export function isHttpsOrLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
