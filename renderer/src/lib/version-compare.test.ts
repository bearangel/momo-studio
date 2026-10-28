// renderer/src/lib/version-compare.test.ts
//
// renderer 侧 compareVersions 镜像（单源指针：electron/src/main/resource/
// version-compare.ts——renderer 不能跨仓/跨 workspace import 主进程模块，
// 语义一致性靠本断言表锁；三处同步义务：electron 单源 / 本镜像 / hub v0.1.5
// 私有实现，改任一侧必须同 commit 改三份表）。
// hub 侧原始表：momo-hub/packages/hub/tests/resources-latest-semver.test.ts ⑥。

import { describe, expect, it } from 'vitest';
import { compareVersions } from './version-compare';

describe('compareVersions（renderer 镜像）— 与 electron 单源同表对齐', () => {
  it('数值段比较（非字典序）', () => {
    expect(compareVersions('10.0.0', '2.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('缺段容忍：缺段按 0（1.0 == 1.0.0 == 1）', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('预发布低于正式版：1.0.0-alpha < 1.0.0', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
  });

  it('预发布标识符比较：数值比较 / 数值 < 字母 / 前缀短的低', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('非法段按 0：1.x.0 == 1.0.0；空段 == 0；v 前缀段按 0', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
    expect(compareVersions('1..0', '1.0.0')).toBe(0);
    expect(compareVersions('v2.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', 'x.0.0')).toBe(0);
  });

  it('build metadata 忽略：1.0.0+build.1 == 1.0.0', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0')).toBe(0);
  });

  it('空串不抛错（角标判定消费面：installedVersion 缺席兜底）', () => {
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(compareVersions('', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '')).toBeGreaterThan(0);
  });
});
