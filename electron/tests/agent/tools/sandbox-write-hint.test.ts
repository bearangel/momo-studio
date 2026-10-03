// electron/tests/agent/tools/sandbox-write-hint.test.ts
// 提示层三条件矩阵（spec §7）：沙箱 tag × 写拒绝签名 × HOME 特征——缺一不触发。
import { describe, it, expect } from 'vitest';
import { detectHomeWriteBlocked, WRITE_BLOCKED_HINT } from '../../../src/main/agent/tools/sandbox-write-hint';

const EPERM_STDERR = 'error: could not write to /Users/u/.rustup: Operation not permitted';

describe('detectHomeWriteBlocked 三条件矩阵', () => {
  it('全命中 → true（seatbelt tag + EPERM + ~/.rustup 命令特征）', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'rustup component add rust-analyzer', EPERM_STDERR)).toBe(true);
  });
  it('非沙箱 tag（win-powershell / unsandboxed）→ 永不触发（Review Focus 1）', () => {
    expect(detectHomeWriteBlocked('win-powershell', 'npm install -g x', EPERM_STDERR)).toBe(false);
    expect(detectHomeWriteBlocked('unsandboxed:reason', 'npm i -g', EPERM_STDERR)).toBe(false);
  });
  it('EPERM 但无 HOME 特征（workspace 内权限问题）→ 不触发（Review Focus 5）', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'cargo build', 'error: EPERM on /ws/target')).toBe(false);
  });
  it('HOME 特征但无写拒绝签名 → 不触发', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'ls ~/.rustup', 'no such directory')).toBe(false);
  });
  it('stderr 里的 HOME 展开路径也算特征（$HOME 未展开形态）', () => {
    expect(detectHomeWriteBlocked('bwrap/net-on', 'echo hi', 'cp: /Users/u/.cargo/bin/x: Permission denied')).toBe(true);
  });
  it('WRITE_BLOCKED_HINT 逐字锁定（renderer 检测依赖固定子串）', () => {
    expect(WRITE_BLOCKED_HINT).toContain('非工作空间路径写入被沙箱拦截');
    expect(WRITE_BLOCKED_HINT).toContain('不要尝试下载到临时目录');
    // GUI 验收（2026-10-03 cargo 实录）：缓存目录重定向绕过也须点名
    expect(WRITE_BLOCKED_HINT).toContain('CARGO_HOME');
  });

  // GUI 验收修复（2026-10-03）：cargo 等工具把错误打到 stdout（stderr 为空），
  // 写拒绝签名与 HOME 特征必须扫两流——实录：fastrand 下载 EPERM 全在 stdout。
  it('EPERM 与 HOME 路径仅在 stdout → 触发（cargo 实录形态）', () => {
    expect(detectHomeWriteBlocked(
      'seatbelt/net-on',
      'cargo run',
      '',
      'error: failed to open `/Users/stbearangel/.cargo/registry/cache/index.crates.io-6f17d22bba15001f/fastrand-2.5.0.crate`\n\nCaused by:\n  Operation not permitted (os error 1)\n',
    )).toBe(true);
  });

  it('stdout 有 EPERM 但无 HOME 特征（且 stderr 空）→ 不触发', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'cargo run', '', 'error: EPERM on /etc/hosts')).toBe(false);
  });
});
