// electron/tests/sandbox/toolchain-grant.test.ts
//
// 目录展开归一契约（~/ 前缀 / realpath / 去重 / npm prefix 特殊项）。v2.5 工具
// 链授权机制（policy 开关 + 预置清单）已于 2026-10-04 整体移除——本模块仅保留
// expandToolchainDirs 作为通用写授权（write-grant.ts）的归一化工具复用。
// DEFAULT_TOOLCHAIN_DIRS 已随之删除：预设清单随机制移除，写授权目录按实际
// 被拦目录授权（会话/工作空间硬门控授权卡）。本文件锁展开契约即可。
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandToolchainDirs } from '../../src/main/sandbox/toolchain-grant';

describe('expandToolchainDirs', () => {
  const home = os.homedir();
  it('~/ 前缀展开为绝对路径并去重', () => {
    const out = expandToolchainDirs(['~/.rustup', '~/.rustup', '~/.cargo'], home);
    expect(out).toHaveLength(2);
    expect(out.every((d) => path.isAbsolute(d))).toBe(true);
  });

  it('npm:<prefix> 特殊项经 npm prefix 探测展开（注入 fake 探测）', () => {
    // expandToolchainDirs 对 'npm:global-prefix' 占位调用 npm prefix 探测；
    // 注入 fakeNpmPrefix 解析（生产缺省探测+缓存）
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
