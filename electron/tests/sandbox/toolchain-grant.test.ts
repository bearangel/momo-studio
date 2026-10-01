// electron/tests/sandbox/toolchain-grant.test.ts
//
// 授权状态层契约（spec §4）：grant 表 workspace 键控 + app 运行期语义（测试内
// 显式清理）；目录展开归一（~/ 前缀 / realpath / 去重 / npm prefix 特殊项）。
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  grantToolchainWorkspace, hasToolchainGrant, __clearToolchainGrantsForTest,
  expandToolchainDirs, DEFAULT_TOOLCHAIN_DIRS,
} from '../../src/main/sandbox/toolchain-grant';

beforeEach(() => __clearToolchainGrantsForTest());

describe('grant 表', () => {
  it('默认无授权；置位后命中；workspace 键控隔离（A 授权不波及 B）', () => {
    expect(hasToolchainGrant('ws-a')).toBe(false);
    grantToolchainWorkspace('ws-a');
    expect(hasToolchainGrant('ws-a')).toBe(true);
    expect(hasToolchainGrant('ws-b')).toBe(false); // Review Focus 3
  });

  it('重复置位幂等', () => {
    grantToolchainWorkspace('ws-a');
    grantToolchainWorkspace('ws-a');
    expect(hasToolchainGrant('ws-a')).toBe(true);
  });
});

describe('expandToolchainDirs', () => {
  const home = os.homedir();
  it('~/ 前缀展开为绝对路径并去重', () => {
    const out = expandToolchainDirs(['~/.rustup', '~/.rustup', '~/.cargo'], home);
    expect(out).toHaveLength(2);
    expect(out.every((d) => path.isAbsolute(d))).toBe(true);
  });

  it('npm:<prefix> 特殊项经 npm prefix 探测展开（注入 fake 探测）', () => {
    // DEFAULT_TOOLCHAIN_DIRS 第四项存储为 'npm:global-prefix' 占位——
    // expandToolchainDirs 注入 fakeNpmPrefix 解析（生产缺省探测+缓存）
    const out = expandToolchainDirs(['npm:global-prefix'], home, { npmPrefix: '/fake/npm-global' });
    expect(out).toEqual(['/fake/npm-global']);
  });

  it('空串/空白行过滤；realpath 失败回退 path.resolve（不抛错）', () => {
    const out = expandToolchainDirs(['', '   ', '~/.not-exist-dir-xyz'], home);
    expect(out).toEqual([path.resolve(home, '.not-exist-dir-xyz')]);
  });

  it('DEFAULT_TOOLCHAIN_DIRS 预置五项（spec D3）', () => {
    expect(DEFAULT_TOOLCHAIN_DIRS).toEqual([
      '~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user',
    ]);
  });
});
