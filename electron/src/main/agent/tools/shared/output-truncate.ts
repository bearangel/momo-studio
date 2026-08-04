// electron/src/main/agent/tools/shared/output-truncate.ts
// 各工具的输出上限（LLM 上下文预算管理）。

export const OUTPUT_LIMITS = {
  bash_stdout: 10 * 1024,
  bash_stderr: 10 * 1024,
  grep_matches: 50,
  glob_matches: 200,
  webfetch_raw: 100 * 1024,
  webfetch_converted: 50 * 1024,
  git_show_diff: 30 * 1024,
  git_status: 20 * 1024,
  git_log: 100,
  lsp_diagnostics: 50,
  lsp_references: 50,
  read_file: 200 * 1024,
} as const;

/** 截断字符串到 maxLen 字节，超长追加标记 */
export function truncateString(s: string, maxLen: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxLen) return s;
  const truncated = buf.subarray(0, maxLen).toString('utf-8');
  return `${truncated}\n…(截断，原 ${buf.length} 字节)`;
}

/** 截断数组到 maxCount 条，超长加尾部提示 */
export function truncateArray<T>(arr: T[], maxCount: number, formatter: (item: T) => string): string {
  if (arr.length <= maxCount) return arr.map(formatter).join('\n');
  const head = arr.slice(0, maxCount).map(formatter).join('\n');
  return `${head}\n\n…(还有 ${arr.length - maxCount} 条未显示，请缩小范围)`;
}
