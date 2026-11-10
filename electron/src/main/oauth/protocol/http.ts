// electron/src/main/oauth/protocol/http.ts
//
// OAuth 出站 HTTP 通道（spec §7.2）。默认走全局 fetch；allowInsecureTls（仅回环连接
// 可开，准入由 endpoint-guard 保证）时改用独立 undici Agent 关闭证书校验——作用域仅
// 该 Agent 承载的 OAuth 请求，不碰全局 fetch，也不影响 MCP/LLM 自身的既有连接池。
//
// 为什么不用全局 fetch + NODE_TLS_REJECT_UNAUTHORIZED：那会把整个进程的 TLS 校验关掉，
// 等价于把 MCP 与模型请求一起降级。独立 Agent 是唯一能把「不校验证书」限定在单连接
// 作用域的手段（与 llm-provider 的专用 dispatcher 同一模式）。
//
// host 约束（spec §10 安全论证 5 / §14）：allowInsecureTls 是连接级标志——由 MCP 资源
// URL 是否为 http:// 回环派生，但同一连接携带凭证的请求（token/refresh/revoke/userinfo/
// DCR）可能指向远端 https AS。不变量：**TLS 校验只允许对回环主机关闭；连接级标志不得
// 把降级带给远端**。因此 insecureFetch 按每次请求的 URL host 逐请求钳制，非回环主机
// 一律回落到默认校验通道（defaultFetch），杜绝 token/client_secret 走未验证 TLS 出站。
import { Agent } from 'undici';
import { isLoopbackHost } from '../../util/url-guard';

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** 与 fetch 的 redirect 语义一致；本地声明联合类型避免依赖 DOM lib */
  redirect?: 'error' | 'follow' | 'manual';
  /** undici 扩展字段（Node 全局 fetch 透传读取），便于测试注入自定义 dispatcher */
  dispatcher?: unknown;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/** 惰性单例：仅在首次真正需要跳过证书校验时创建，正常路径零开销 */
let insecureAgent: Agent | null = null;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

function insecureFetch(url: string, init: FetchInit): Promise<Response> {
  // 逐请求按 URL host 钳制：跳过证书校验仅限回环主机（本地自签 https 场景）。
  // 非回环主机即使连接级 allowInsecureTls=true 也走默认校验通道。
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // URL 非法（正常链路已被 endpoint-guard 拦截，此为兜底）：按非回环处理，降级路径 fail-closed
    return defaultFetch(url, init);
  }
  if (!isLoopbackHost(hostname)) {
    return defaultFetch(url, init);
  }
  if (!insecureAgent) {
    // keepAlive 默认开启（同全局 fetch 语义），证书校验仅对本 Agent 的请求关闭
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  // dispatcher 为 undici 扩展字段——类型层用交集断言，不落入 any（同 llm-provider 模式）
  return fetch(url, { ...init, dispatcher: insecureAgent } as RequestInit & {
    dispatcher: Agent;
  });
}

export function resolveFetch(allowInsecureTls: boolean): FetchLike {
  return allowInsecureTls ? insecureFetch : defaultFetch;
}
