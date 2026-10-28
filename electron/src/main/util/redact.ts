// electron/src/main/util/redact.ts
//
// 凭证脱敏工具（M2.4 T2）：值形态正则族 + 文本替换 + code point 安全截断。
//
// SECRET_VALUE_PATTERNS 原属 hub/snapshot-builder.ts 的「快照红线值扫描」私有常量，
// 本次逐行搬移（文案/顺序/正文字面零改动）——快照侧改为从本模块导入，扫描行为不变；
// 委派链（provider 错误原文上行到 hub）复用同一族正则做替换脱敏，避免双份漂移。
//
// 查询串 token 形态（token= / access_token=）只在调用方显式开启
// `includeQueryToken` 时脱敏：快照扫描当前不消费 redactSecrets，默认关闭即
// 行为零变更；委派链的错误原文来自 provider 响应体/URL，需覆盖该形态。

/** 值形态扫描：已知 key 值形态的正则族（sk- 前缀 / Bearer 凭证 / ghp_ / xox / 64 位十六进制裸串）。
 *  64 位十六进制是 sha256 key/secret 的常见裸形态——快照正文（清单/内嵌 skill 文本）
 *  无正当携带场景，宁可误杀（fail-closed）不可漏放。 */
export const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{12,}/, label: 'provider key 值（sk- 前缀）' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, label: 'Bearer 凭证值' },
  { re: /\bghp_[A-Za-z0-9]{20,}/, label: 'GitHub token 值（ghp_ 前缀）' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token 值（xox 前缀）' },
  { re: /\b[0-9a-f]{64}\b/i, label: '64 位十六进制裸串（key/secret 形态）' },
];

/** 查询串 token 形态（仅 includeQueryToken=true 时参与替换） */
const QUERY_TOKEN_PATTERN = /\b(?:access_token|token)=[A-Za-z0-9._~+/=%\-]{8,}/gi;

const REDACTED = '***';

/** 脱敏文本的最大 code point 数（超出截断）；与 hub wire 的 excerpt 上限留裕量 */
export const REASON_MAX_CODE_POINTS = 300;

export interface RedactOptions {
  /** true = 额外脱敏 query token 形态（token= / access_token=）；默认 false */
  includeQueryToken?: boolean;
}

/** 把非全局正则提升为全局（保持源正则 literal 零改动——只在替换时加 g） */
function toGlobal(re: RegExp): RegExp {
  return re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`);
}

/**
 * 凭证脱敏：按 SECRET_VALUE_PATTERNS 逐条全量替换为 `***`；
 * `includeQueryToken:true` 时额外替换 token= / access_token= 形态。
 * 空串原样返回；非敏感文本零改写（不误伤）。
 */
export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (text === '') return text;
  let out = text;
  for (const { re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(toGlobal(re), REDACTED);
  }
  if (opts.includeQueryToken === true) {
    out = out.replace(QUERY_TOKEN_PATTERN, REDACTED);
  }
  return out;
}

/**
 * 按 **code point** 截断（禁 `slice` 劈代理对）：超长时取前 max 个 code point
 * 并追加 `…`（结果长度 max+1）；未超长原样返回。
 */
export function truncateCodePoints(text: string, max: number = REASON_MAX_CODE_POINTS): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}…`;
}
