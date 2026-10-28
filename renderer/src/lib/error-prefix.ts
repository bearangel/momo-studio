// renderer/src/lib/error-prefix.ts
//
// A3 错误文案单前缀：store / 组件写入 error 时已带业务前缀的集合。
// TypePageShell 命中这些前缀时原样展示，不再拼「加载失败：」。
//
// 跨 workspace 无共享 import——electron 侧对应常量在
// electron/src/main/util/error-prefix.ts，双侧由 electron 契约测试锁定包含关系。

/** 已知业务前缀（顺序无关；新增写操作前缀时同步补 electron 契约测试） */
export const KNOWN_ERROR_PREFIXES = [
  '导入失败：',
  '启停失败：',
  '停用失败：',
  '重载失败：',
  '卸载失败：',
  '下载资源包失败：',
] as const;

/** 文案是否已带业务前缀（命中 → 调用方不得再拼「加载失败：」） */
export function hasKnownErrorPrefix(message: string): boolean {
  return KNOWN_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}
