// electron/tests/util/bundled-runtime.test.ts
//
// 打包态判定矩阵锁（2026-11-13 审查跟进）：ELECTRON_RUN_AS_NODE 下区分
// 「测试进程（dev Electron，resourcesPath 在 node_modules 发行目录内）」与
// 「打包 runtime 子进程（安装目录布局）」。一修曾用 MOMO_RUNTIME_CHILD 判别，
// 被 vitest.config.ts 组级 env 哨兵撞语义（forks 组测试进程也带它）致 8 文件
// 15 用例误判打包态——本锁防回归。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveBundledState, isBundledRuntime } from '../../src/main/util/bundled-runtime';

describe('resolveBundledState（RUN_AS_NODE × resourcesPath 布局矩阵）', () => {
  it('RUN_AS_NODE + resourcesPath 在 node_modules 内（dev Electron / vitest）→ false', () => {
    const devResources = `/repo${path.sep}node_modules${path.sep}.pnpm/electron@44.9.1/node_modules/electron/dist/Electron.app/Contents/Resources`;
    expect(resolveBundledState('1', devResources, false)).toBe(false);
  });

  it('RUN_AS_NODE + resourcesPath 在安装目录（打包 runtime 子进程）→ true', () => {
    expect(resolveBundledState('1', '/Applications/Momo Studio.app/Contents/Resources', false)).toBe(true);
    expect(resolveBundledState('1', 'C:\\Program Files\\Momo Studio\\resources', false)).toBe(true);
  });

  it('RUN_AS_NODE + resourcesPath 缺失 → false（无法证实打包态）', () => {
    expect(resolveBundledState('1', undefined, false)).toBe(false);
  });

  it('无 RUN_AS_NODE → 走 resourcesPath/defaultApp 原始判定（GUI 主进程语义不变）', () => {
    expect(resolveBundledState(undefined, '/Applications/Momo Studio.app/Contents/Resources', false)).toBe(true);
    expect(resolveBundledState(undefined, undefined, false)).toBe(false);
    expect(resolveBundledState(undefined, '/any/Resources', true)).toBe(false);
  });

  it('子串误报防御：路径含 node_modules 字样但非分隔符段 → 不按 dev 判', () => {
    expect(resolveBundledState('1', '/apps/momo-node_modules-x/Resources', false)).toBe(true);
  });
});

describe('isBundledRuntime（当前测试进程实跑断言）', () => {
  it('vitest 经 scripts/test.mjs 跑在 dev Electron node 模式 → false（catalog/skills 根指 dev 布局）', () => {
    expect(isBundledRuntime()).toBe(false);
  });
});
