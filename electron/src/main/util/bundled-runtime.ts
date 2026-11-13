// electron/src/main/util/bundled-runtime.ts
//
// 打包态判定（2026-11-13 ABI 统一）：ELECTRON_RUN_AS_NODE 下（vitest 跑在
// Electron 二进制），process.resourcesPath 存在且 defaultApp 为 false——
// 裸判「resourcesPath && !defaultApp」会把测试进程误判成打包态，导致
// catalog / agent YAML / skills 根误指 electron/dist/Resources（ENOENT）。
// 判定统一收敛于此，三处资源根（marketplace/agent builtin/skills）共用。
//
// 2026-11-13 审查跟进（二修）：RUN_AS_NODE 下另需区分「测试进程」与「打包
// runtime 子进程」（后者是真打包态，资源根应指安装目录）。MOMO_RUNTIME_CHILD
// 不可用作判别——electron/vitest.config.ts 给 forks 组进程级注入该哨兵（放行
// 打桩的 process.send 上行），测试进程同样带它。可用判别子是 resourcesPath
// 布局：dev/test 的 Electron 发行目录恒在 node_modules 内（pnpm 布局），
// 打包 app 的 resources 在安装目录。

import path from 'node:path';

/** 打包态判定矩阵（纯函数，供单测锁全矩阵） */
export function resolveBundledState(
  runAsNode: string | undefined,
  resourcesPath: string | undefined,
  defaultApp: boolean | undefined,
): boolean {
  if (runAsNode) {
    // 测试进程（dev Electron：resourcesPath 含 node_modules 段）→ 非打包态
    if (
      typeof resourcesPath === 'string' &&
      resourcesPath.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      return false;
    }
    // 打包 runtime 子进程（安装目录布局）→ 按打包态判定
    return Boolean(resourcesPath) && !defaultApp;
  }
  return Boolean(resourcesPath) && !defaultApp;
}

/** 是否运行在打包产物（app.asar / Resources 目录）中 */
export function isBundledRuntime(): boolean {
  return resolveBundledState(
    process.env.ELECTRON_RUN_AS_NODE,
    process.resourcesPath,
    process.defaultApp,
  );
}
