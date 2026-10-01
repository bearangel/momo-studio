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

  it('opts.npmPrefix 显式 null → 占位项跳过且不抛错（终审 F3：null=探测失败注入语义——绕 execSync 直测 opts 契约）', () => {
    const out = expandToolchainDirs(['npm:global-prefix', '~/.rustup'], home, { npmPrefix: null });
    expect(out).toEqual([path.resolve(home, '.rustup')]);
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

  // —— pip:user 平台分支（终审 F4：skipIf 互补——任一平台至少跑一条，CI linux 与主机 darwin 各覆盖其一）——
  describe.skipIf(process.platform !== 'darwin')('pip:user 展开（darwin 分支）', () => {
    it('pip:user → ~/Library/Python（版本号目录的父目录，宽匹配）', () => {
      expect(expandToolchainDirs(['pip:user'], home)).toEqual([
        path.join(home, 'Library', 'Python'),
      ]);
    });
  });

  describe.skipIf(process.platform === 'darwin')('pip:user 展开（非 darwin 分支）', () => {
    it('pip:user → ~/.local', () => {
      expect(expandToolchainDirs(['pip:user'], home)).toEqual([path.join(home, '.local')]);
    });
  });
});
