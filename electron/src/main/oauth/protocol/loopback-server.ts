// electron/src/main/oauth/protocol/loopback-server.ts
//
// 一次性回环回调服务器（RFC 8252 §7.3）。约束（spec §7.1/§10）：
//   - 只 bind 127.0.0.1 / localhost，绝不 bind 0.0.0.0
//   - 路径固定 /callback；state 不匹配 400 并继续等待（防误杀用户二次尝试）
//   - 命中后立即关连接；超时抛 authorization_timeout
//   - 响应统一 `Connection: close`，避免 keep-alive 连接拖慢一次性服务器的 close()
//   - 固定端口 EADDRINUSE 抛 redirect_port_in_use，不静默回落随机
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthFailure } from '../types';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/callback';
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  connection: 'close',
} as const;

export interface LoopbackServerOptions {
  host: string;
  port?: number | null;
  expectedState: string;
  timeoutMs?: number;
}

export interface LoopbackServer {
  readonly redirectUri: string;
  waitForCallback(): Promise<{ code: string }>;
  close(): Promise<void>;
}

/** HTML 转义，避免把 query 中的不可信文本直接拼进响应体 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const OK_HTML =
  '<!doctype html><html><body style="font-family:system-ui;padding:32px">' +
  '<h2>授权完成</h2><p>可以关闭此页面并返回 Momo Studio。</p></body></html>';

const FAIL_HTML = (reason: string): string =>
  '<!doctype html><html><body style="font-family:system-ui;padding:32px">' +
  `<h2>授权未完成</h2><p>${escapeHtml(reason)}</p></body></html>`;

export async function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
  // 只允许回环地址：任何非 localhost 的 host 一律收敛到 127.0.0.1，杜绝 0.0.0.0
  const host = opts.host === 'localhost' ? 'localhost' : '127.0.0.1';

  let settle: ((value: { code: string }) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  let finished = false;
  let timer: NodeJS.Timeout | null = null;
  // 回调可能先于 waitForCallback() 到达（例如服务层先打开浏览器再挂等待），
  // 此时把结果/错误暂存，等等待方接管时立即兑现。
  let pendingResult: { code: string } | null = null;
  let pendingError: Error | null = null;
  let closePromise: Promise<void> | null = null;
  // 只允许一个等待方：第二次调用直接拒绝，避免把第一个等待者变成孤儿
  let waiterStarted = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, HTML_HEADERS);
      res.end(FAIL_HTML('未知回调路径'));
      return;
    }
    if (finished) {
      res.writeHead(409, HTML_HEADERS);
      res.end(FAIL_HTML('该授权请求已完成，请勿重复刷新。'));
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (state !== opts.expectedState) {
      // state 不匹配不足以终止流程（可能是旧标签页/攻击尝试）——拒绝本次并继续等待。
      // 必须先校验 state 再看 error：本地页面不得在不知道 state 的情况下取消流程。
      res.writeHead(400, HTML_HEADERS);
      res.end(FAIL_HTML('state 校验失败，请从 Momo Studio 重新发起授权。'));
      return;
    }
    if (error) {
      // 授权方明确拒绝：这是终止路径，按取消处理并关闭监听
      const failure = new OAuthFailure('authorization_cancelled', `授权被拒绝：${error}`);
      finished = true;
      pendingError = failure;
      res.writeHead(400, HTML_HEADERS);
      res.end(FAIL_HTML(`授权被拒绝：${error}`));
      fail?.(failure);
      void close();
      return;
    }
    if (!code) {
      res.writeHead(400, HTML_HEADERS);
      res.end(FAIL_HTML('回调缺少 code 参数。'));
      return;
    }
    // 首个有效回调胜出
    const result = { code };
    finished = true;
    pendingResult = result;
    res.writeHead(200, HTML_HEADERS);
    res.end(OK_HTML);
    settle?.(result);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new OAuthFailure('redirect_port_in_use', `回调端口 ${opts.port} 已被占用`));
        return;
      }
      reject(new OAuthFailure('authorization_cancelled', `回环服务器启动失败：${err.message}`));
    };
    server.once('error', onError);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://${host}:${address.port}${CALLBACK_PATH}`;

  // close() 幂等：重复调用复用同一个 Promise；未监听时直接完成。
  // 若流程尚未终结，显式关闭同时取消挂起的等待者（否则调用方会永远悬挂）。
  const close = (): Promise<void> => {
    if (!finished) {
      finished = true;
      const cancelled = new OAuthFailure('authorization_cancelled', '授权已取消');
      pendingError = cancelled;
      if (timer) clearTimeout(timer);
      timer = null;
      fail?.(cancelled);
    }
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closePromise;
  };

  const waitForCallback = (): Promise<{ code: string }> => {
    if (waiterStarted) {
      return Promise.reject(
        new OAuthFailure('authorization_pending', '已有等待中的授权回调，请勿重复等待')
      );
    }
    waiterStarted = true;
    // 回调已先到达：立即兑现暂存结果，并在消费后关闭监听（与错误路径一致）
    if (pendingResult) {
      return Promise.resolve(pendingResult).finally(() => close());
    }
    if (pendingError) {
      return Promise.reject(pendingError).finally(() => close());
    }
    return new Promise<{ code: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        pendingError = new OAuthFailure('authorization_timeout', '等待授权回调超时（10 分钟）');
        reject(pendingError);
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }).finally(async () => {
      settle = null;
      fail = null;
      if (timer) clearTimeout(timer);
      timer = null;
      // 等 socket 真正释放后再让返回的 Promise 落定，保证调用方不会拿到「已监听中」的假象
      await close();
    });
  };

  return { redirectUri, waitForCallback, close };
}

/** 手动回调（spec §10）：接受完整回调 URL 或裸 code；state 必须匹配 */
export function parseManualCallback(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new OAuthFailure('authorization_cancelled', '回调内容为空');
  }
  // 裸 code 形态：不含协议头且无查询串
  if (!trimmed.includes('://') && !trimmed.includes('?')) {
    return trimmed;
  }
  let parsed: URL;
  try {
    // 容忍用户粘贴时省略 http:// 的完整回调地址
    parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    throw new OAuthFailure('token_exchange_failed', '无法解析回调 URL');
  }
  if (parsed.searchParams.get('state') !== expectedState) {
    throw new OAuthFailure('authorization_cancelled', 'state 校验失败，请重新发起授权');
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new OAuthFailure('authorization_cancelled', `授权被拒绝：${error}`);
  }
  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new OAuthFailure('token_exchange_failed', '回调 URL 缺少 code 参数');
  }
  return code;
}
