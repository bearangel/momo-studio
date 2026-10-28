// electron/src/main/util/network-error.ts
//
// A2 下载失败人话：只把「fetch 抛错」这一网络层失败翻译成用户可读文案。
// 非 2xx 分支不走本模块（installer 维持既有 `下载失败: HTTP n`）。
//
// Node fetch 的真实失败形状是 `TypeError: fetch failed`，底层原因挂在 cause 链上
// （code = ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* / ECONNRESET），
// abort 则是 name='AbortError'。逐层收集 code/name/message 后按类映射；
// 未命中任何一类一律回退「网络请求失败」——不猜原因。

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
