// electron/src/main/util/network-error.ts
//
// 下载失败人话化的两个层面（M2.5 A2 + M3.0 T2）：
//   - describeNetworkError：只把「fetch 抛错」这一网络层失败翻译成用户可读文案
//   - describeHttpDownloadFailure：HTTP 非 2xx → 人话映射（原文只进主进程日志）
//
// Node fetch 的真实失败形状是 `TypeError: fetch failed`，底层原因挂在 cause 链上
// （code = ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* / ECONNRESET），
// abort 则是 name='AbortError'。逐层收集 code/name/message 后按类映射；
// 未命中任何一类一律回退「网络请求失败」——不猜原因。

import { DOWNLOAD_HTTP_FALLBACK_PREFIX } from './error-prefix';

/** cause 链最大回溯深度（防御自引用/超长链；真实 fetch 链通常 1~2 层） */
const MAX_CAUSE_DEPTH = 8;

interface ErrorSignals {
  codes: string[];
  names: string[];
  text: string;
}

/** 沿 cause 链收集 code / name / message（已归一为大写便于匹配） */
function collectSignals(err: unknown): ErrorSignals {
  const codes: string[] = [];
  const names: string[] = [];
  const texts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    const node = current as object;
    if (seen.has(node)) break;
    seen.add(node);

    const record = node as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.code === 'string') codes.push(record.code.toUpperCase());
    if (typeof record.name === 'string') names.push(record.name);
    if (typeof record.message === 'string') texts.push(record.message);
    current = record.cause;
  }

  return { codes, names, text: texts.join(' | ').toUpperCase() };
}

/** 证书类错误：code 或 message 命中（OpenSSL 不同版本把细节分散在两处） */
function isCertificateError(signals: ErrorSignals): boolean {
  if (signals.codes.some((code) => code.startsWith('CERT_'))) return true;
  return (
    signals.text.includes('CERT_') ||
    signals.text.includes('UNABLE_TO_VERIFY') ||
    signals.text.includes('SELF_SIGNED')
  );
}

/**
 * 网络层失败 → 人话短句。仅接受 fetch 抛出的异常（含其 cause 链）；
 * 未命中分类返回「网络请求失败」，不输出原始 message。
 */
export function describeNetworkError(err: unknown): string {
  const signals = collectSignals(err);
  if (isCertificateError(signals)) return '证书校验失败';
  if (signals.codes.includes('ENOTFOUND') || signals.codes.includes('EAI_AGAIN')) {
    return '无法解析域名';
  }
  if (signals.codes.includes('ECONNREFUSED')) return '连接被拒绝';
  if (signals.codes.includes('ETIMEDOUT') || signals.names.includes('AbortError')) {
    return '连接超时';
  }
  if (signals.codes.includes('ECONNRESET')) return '连接被重置';
  return '网络请求失败';
}

/**
 * HTTP 非 2xx 下载失败 → 人话文案（M3.0 T2）。只返回人话——`HTTP <status> <url>`
 * 原文（url 经 redactSecrets 脱敏）由调用方记日志，不进 UI。
 * 映射表：404 下架 / 403 无权 / ≥500 服务异常 / 其余（含 401/402/418…）兜底。
 */
export function describeHttpDownloadFailure(status: number): string {
  if (status === 404) return '资源包不存在或已下架';
  if (status === 403) return '无权访问该资源包';
  if (status >= 500) return 'hub 服务异常，请稍后重试';
  return `${DOWNLOAD_HTTP_FALLBACK_PREFIX}请稍后重试`;
}
