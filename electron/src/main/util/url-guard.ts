// electron/src/main/util/url-guard.ts
//
// 共享 URL 准入判定（OAuth / LLM provider / MCP 三处同口径）。
// 口径：https 任意主机；http 仅回环（本地研发场景）。
// 注意：0.0.0.0 视为回环是既有语义（provider-crud 先例），但**监听**永不 bind 0.0.0.0。

export function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL 对 IPv6 主机会保留方括号（`new URL('http://[::1]:8080/').hostname === '[::1]'`），
  // 这里剥掉方括号再比较，否则 `::1` 分支对真实产品调用链永远不可达。
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

export function isHttpsOrLoopbackHttp(url: unknown): boolean {
  // 通用工具入口：非字符串入参直接拒绝，避免调用方漏做类型防御。
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
