// electron/tests/agent/tools/sandbox-write-hint.test.ts
// 检测通用化（spec 2026-10-03 §5.2）：detectWriteBlocked（HOME 特征降级为提取辅助）
// + extractBlockedPaths（实录语料）+ normalizeGrantDirs（显示即所授归一）+ 通用文案。
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  detectWriteBlocked,
  extractBlockedPaths,
  normalizeGrantDirs,
  WRITE_BLOCKED_HINT,
} from '../../../src/main/agent/tools/sandbox-write-hint';

// 2026-10-03 hello-rust 会话实录（seq 964 形态）：cargo 错误全在 stdout、带完整路径
const CARGO_STDOUT = [
  '    Updating crates.io index',
  'error: failed to download `fastrand v2.5.0`',
  '',
  'Caused by:',
  '  failed to open /Users/tester/.cargo/registry/cache/index.crates.io-6f17d22bba15001f/fastrand-2.5.0.crate',
  '',
  'Caused by:',
  '  Operation not permitted (os error 1)',
].join('\n');

describe('detectWriteBlocked（通用化，spec §5.2）', () => {
  it('cargo 实录：stdout-only EPERM + 路径 → 触发（原 P0 形态回归锁）', () => {
    expect(detectWriteBlocked('seatbelt/net-on', 'cargo build', '', CARGO_STDOUT)).toBe(true);
  });

  it('cp stderr EPERM（非 HOME 路径）→ 触发（通用化：HOME 特征不再是必要条件）', () => {
    expect(
      detectWriteBlocked('bwrap/net-on', 'cp a.txt /opt/local/lib/x.txt', 'cp: /opt/local/lib/x.txt: Operation not permitted', ''),
    ).toBe(true);
  });

  it('非沙箱 tag 不触发；无写拒绝签名不触发', () => {
    expect(detectWriteBlocked('win-powershell', 'cargo build', '', CARGO_STDOUT)).toBe(false);
    expect(detectWriteBlocked('unsandboxed:reason', 'npm i -g', 'Operation not permitted', '')).toBe(false);
    expect(detectWriteBlocked('seatbelt/net-on', 'ls ~', 'some noise', '')).toBe(false);
  });

  it('stderr 签名保持触发（seatbelt + EPERM）', () => {
    expect(
      detectWriteBlocked('seatbelt/net-off', 'rustup toolchain install stable', 'error: Permission denied (os error 13)', ''),
    ).toBe(true);
  });
});

describe('extractBlockedPaths（spec §5.2 路径提取器）', () => {
  it('cargo 实录：提取 ~/.cargo/registry/... crate 路径', () => {
    const paths = extractBlockedPaths('cargo build', '', CARGO_STDOUT);
    expect(paths).toContain('/Users/tester/.cargo/registry/cache/index.crates.io-6f17d22bba15001f/fastrand-2.5.0.crate');
  });

  it('cp stderr：提取错误行路径', () => {
    expect(extractBlockedPaths('cp a /opt/x', 'cp: /opt/x: Operation not permitted', ''))
      .toContain('/opt/x');
  });

  it('无路径错误 → 空数组（降级路径语料）', () => {
    expect(extractBlockedPaths('something', 'Operation not permitted', '')).toEqual([]);
  });

  it('去重 + 上限 3', () => {
    const many = [
      'failed to open /a/1: Operation not permitted',
      'failed to open /b/2: denied',
      'cannot create /c/3: error',
      'failed /d/4: error',
    ].join('\n');
    const out = extractBlockedPaths('x', many, '');
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
  });
});

describe('normalizeGrantDirs（spec §5.2 归一：显示即所授）', () => {
  const home = os.homedir();

  it('HOME 下路径归并到 HOME 第一级（~/.cargo/registry/x → ~/.cargo）', () => {
    expect(normalizeGrantDirs([path.join(home, '.cargo/registry/cache/a.crate')], home))
      .toEqual([path.join(home, '.cargo')]);
  });

  it('非 HOME 路径取最近存在祖先（/tmp 必存在）', () => {
    expect(normalizeGrantDirs(['/tmp/momo-sb-123/a/b/c.sb'], '/nonexistent-home'))
      .toEqual(['/tmp']);
  });

  it('HOME 一级天然去重 + 上限 3', () => {
    const out = normalizeGrantDirs([
      path.join(home, '.cargo/registry/a'),
      path.join(home, '.cargo/git/db/b'),
      path.join(home, '.rustup/toolchains/c'),
      path.join(home, '.go/d'),
    ], home);
    expect(out).toEqual([
      path.join(home, '.cargo'),
      path.join(home, '.rustup'),
      path.join(home, '.go'),
    ]);
  });
});

describe('WRITE_BLOCKED_HINT 文案（spec §6.5 通用版）', () => {
  it('新前缀句 + 授权卡指引 + 反绕过三要素', () => {
    expect(WRITE_BLOCKED_HINT).toContain('工作空间外路径写入被沙箱拦截');
    expect(WRITE_BLOCKED_HINT).toContain('授权');
    expect(WRITE_BLOCKED_HINT).toContain('不要用临时目录或缓存重定向绕过');
  });
});
