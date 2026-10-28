// electron/src/main/util/error-prefix.ts
//
// A3 错误文案单前缀：electron 侧产生的用户可见错误前缀。
// renderer 侧另有独立常量（renderer/src/lib/error-prefix.ts）——跨 workspace 不共享
// import，两侧靠 electron/tests/util/error-prefix-contract.test.ts 做包含关系契约，
// 任一侧改字面量都会红。

/** 下载资源包失败（fetch 网络层抛错经 describeNetworkError 翻译后的固定前缀） */
export const DOWNLOAD_RESOURCE_FAILURE_PREFIX = '下载资源包失败：';

/** 非 2xx 下载失败（installer 既有文案，半角冒号；A3/P3 验收纳入） */
export const DOWNLOAD_HTTP_FAILURE_PREFIX = '下载失败:';

/** electron 主进程产生的全部用户可见错误前缀（须被 renderer 已知集合覆盖） */
export const ELECTRON_ERROR_PREFIXES = [
  DOWNLOAD_RESOURCE_FAILURE_PREFIX,
  DOWNLOAD_HTTP_FAILURE_PREFIX,
] as const;
