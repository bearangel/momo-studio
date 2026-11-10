// electron/src/main/oauth/protocol/http.ts
//
// OAuth 出站 HTTP 通道（spec §7.2）。默认走全局 fetch；allowInsecureTls（仅回环连接
// 可开，准入由 endpoint-guard 保证）时改用独立 undici Agent 关闭证书校验——作用域仅
// 该 Agent 承载的 OAuth 请求，不碰全局 fetch，也不影响 MCP/LLM 自身的既有连接池。
//
// 为什么不用全局 fetch + NODE_TLS_REJECT_UNAUTHORIZED：那会把整个进程的 TLS 校验关掉，
// 等价于把 MCP 与模型请求一起降级。独立 Agent 是唯一能把「不校验证书」限定在单连接
// 作用域的手段（与 llm-provider 的专用 dispatcher 同一模式）。
import { Agent } from 'undici';

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** undici 扩展字段（Node 全局 fetch 透传读取），便于测试注入自定义 dispatcher */
  dispatcher?: unknown;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/** 惰性单例：仅在首次真正需要跳过证书校验时创建，正常路径零开销 */
let insecureAgent: Agent | null = null;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

function insecureFetch(url: string, init: FetchInit): Promise<Response> {
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
