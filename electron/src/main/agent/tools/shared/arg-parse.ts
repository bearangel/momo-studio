// electron/src/main/agent/tools/shared/arg-parse.ts
//
// 工具参数解析共享辅助：把 unknown 归一化为 string，缺失或非 string 时抛错。
// 原先 8 个工具模块（file / git / lsp / search / shell / task / todo / web）
// 各自维护一份完全相同的私有副本，现收敛为单点定义。
// 行为保持不变：错误信息包含字段名，给 LLM 明确的纠正反馈。

/** 把 unknown 归一化为 string；非 string（含缺失）则抛错。 */
export function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 缺失或不是字符串`);
  }
  return value;
}
