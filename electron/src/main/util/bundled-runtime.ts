// electron/src/main/util/bundled-runtime.ts
//
// 打包态判定（2026-11-13 ABI 统一）：ELECTRON_RUN_AS_NODE 下（vitest 跑在
// Electron 二进制），process.resourcesPath 存在且 defaultApp 为 false——
// 裸判「resourcesPath && !defaultApp」会把测试进程误判成打包态，导致
// catalog / agent YAML / skills 根误指 electron/dist/Resources（ENOENT）。
// 判定统一收敛于此，三处资源根（marketplace/agent builtin/skills）共用。

/** 是否运行在打包产物（app.asar / Resources 目录）中 */
export function isBundledRuntime(): boolean {
  if (process.env.ELECTRON_RUN_AS_NODE) return false;
  return Boolean(process.resourcesPath) && !process.defaultApp;
}
