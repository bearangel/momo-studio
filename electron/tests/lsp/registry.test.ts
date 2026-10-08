// 注册表完备性 + PATH 探测器契约（spec §5/§9）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  REGISTRY,
  findBinaryInPath,
  loginShellWhich,
  extensionToLanguageId,
  invalidateBinaryValidatorCache,
} from '../../src/main/lsp/registry';

describe('REGISTRY 数据完备性', () => {
  it('共 16 门：验证层 12 + 实验层 4', () => {
    expect(REGISTRY).toHaveLength(16);
    expect(REGISTRY.filter((s) => s.tier === 'verified')).toHaveLength(12);
    expect(REGISTRY.filter((s) => s.tier === 'experimental')).toHaveLength(4);
  });

  it('每条字段完备（languageId 唯一 / binaries+markers+extensions 非空 / installHint 非空）', () => {
    const ids = new Set<string>();
    for (const s of REGISTRY) {
      expect(ids.has(s.languageId)).toBe(false);
      ids.add(s.languageId);
      expect(s.binaries.length).toBeGreaterThan(0);
      expect(s.markers.length).toBeGreaterThan(0);
      expect(s.extensions.length).toBeGreaterThan(0);
      expect(s.installHint.length).toBeGreaterThan(0);
      for (const e of s.extensions) expect(e.startsWith('.')).toBe(true);
    }
  });

  it('.h 归 cpp（注册表顺序优先），.swift 归 swift', () => {
    expect(extensionToLanguageId('.h')).toBe('cpp');
    expect(extensionToLanguageId('.swift')).toBe('swift');
  });
});

describe('findBinaryInPath', () => {
  it('命中 PATH 内可执行文件（返回绝对路径）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-which-'));
    const bin = path.join(dir, 'fake-ls');
    fs.writeFileSync(bin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
    expect(findBinaryInPath(['nope', 'fake-ls'], dir)).toBe(bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('PATH 内同名目录不命中（POSIX 目录可遍历即过 X_OK，须 isFile 守卫）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-which-dir-'));
    // 目录默认 0o755：accessSync X_OK 会通过——缺 isFile 守卫时被误报命中
    fs.mkdirSync(path.join(dir, 'fake-ls-dir'));
    fs.chmodSync(path.join(dir, 'fake-ls-dir'), 0o755);
    expect(findBinaryInPath(['fake-ls-dir'], dir)).toBeNull();
    // 混排场景：目录在前不挡住后面的真命中
    const bin = path.join(dir, 'fake-ls');
    fs.writeFileSync(bin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
    expect(findBinaryInPath(['fake-ls-dir', 'fake-ls'], dir)).toBe(bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('含路径分隔符的候选走绝对路径分支：目录同样不命中', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-which-abs-'));
    fs.mkdirSync(path.join(dir, 'subdir-bin'));
    expect(findBinaryInPath([path.join(dir, 'subdir-bin')])).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('全 miss 返回 null；空 PATH 返回 null（注入伪 PATH = 隔离模式，不触发 shell 兜底）', () => {
    expect(findBinaryInPath(['nope'], '/nonexistent-dir-xyz')).toBeNull();
    expect(findBinaryInPath(['nope'], '')).toBeNull();
  });
});

describe('GUI 启动 PATH 兜底（macOS Finder/Dock launchd 环境修复）', () => {
  // 设计：兜底命令可注入 fake runner（真 login shell 在单测环境不可控）——
  // 显式注入 shellFallback 时始终生效，不受「伪 PATH 隔离模式」门控影响
  it('全 miss 后降级兜底：shellFallback 被调用且命中其输出', () => {
    const fake = vi.fn(() => '/opt/homebrew/bin/momo-gui-fallback-bin');
    // 注入最小 PATH（/usr/bin 不含该合成二进制）→ 目录全 miss → 必须走兜底
    expect(findBinaryInPath(['momo-gui-fallback-bin'], '/usr/bin', fake))
      .toBe('/opt/homebrew/bin/momo-gui-fallback-bin');
    expect(fake).toHaveBeenCalledWith('momo-gui-fallback-bin');
  });

  it('PATH 目录命中时不触发兜底（优先级：真实 PATH > login shell）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-which-fb-'));
    const bin = path.join(dir, 'fake-ls');
    fs.writeFileSync(bin, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
    const fb = vi.fn(() => '/should-not-be-used');
    expect(findBinaryInPath(['fake-ls'], dir, fb)).toBe(bin);
    expect(fb).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('兜底返回 null → 整体 null（兜底未命中不虚构结果）', () => {
    expect(findBinaryInPath(['momo-x'], '/nonexistent-dir-xyz', () => null)).toBeNull();
  });

  it('多候选按序兜底：首个候选未命中时继续尝试下一个', () => {
    const calls: string[] = [];
    const fb = (b: string): string | null => {
      calls.push(b);
      return b === 'second-bin' ? '/usr/local/bin/second-bin' : null;
    };
    expect(findBinaryInPath(['first-bin', 'second-bin'], '/nonexistent-dir-xyz', fb))
      .toBe('/usr/local/bin/second-bin');
    expect(calls).toEqual(['first-bin', 'second-bin']);
  });
});

describe('一键安装元数据（D3 修正案：面板一键装到共享目录）', () => {
  it('§A pin 回归锁：typescript 的 installHint 与 install.packages 均含 typescript@^5（npmmirror 默认装 TS 7 无经典 tsserver）', () => {
    const ts = REGISTRY.find((s) => s.languageId === 'typescript')!;
    expect(ts.installHint).toContain('typescript@^5');
    expect(ts.install).toBeDefined();
    expect(ts.install!.packages).toContain('typescript@^5');
  });

  it('仅 4 门确证 npm 分发的语言挂 install（kind=npm + 精确包清单），其余 12 门不挂（保持手动引导）', () => {
    const expected: Record<string, string[]> = {
      typescript: ['typescript-language-server', 'typescript@^5'],
      python: ['pyright'], // 二进制 pyright-langserver 随包
      shell: ['bash-language-server'],
      php: ['intelephense'],
    };
    for (const s of REGISTRY) {
      if (expected[s.languageId]) {
        expect(s.install).toEqual({ kind: 'npm', packages: expected[s.languageId] });
      } else {
        expect(s.install).toBeUndefined();
      }
    }
  });
});

describe('loginShellWhich 生产缺省实现（真实 login shell，宿主可复现）', () => {
  it('存在的系统命令命中绝对路径（login shell source profile 后 command -v）', () => {
    const hit = loginShellWhich('sh');
    expect(hit).not.toBeNull();
    expect(hit).toMatch(/^\//);
  });

  it('不存在的二进制返回 null——login shell 启动脚本噪声不得造成假命中', () => {
    // 回归锁：兜底解析取末行且须为绝对路径 + 落盘可执行校验；宿主 profile
    // 即使向 stdout 打印噪声（含路径形态文本）也不得误报命中
    expect(loginShellWhich('momo-definitely-not-a-real-bin-xyz')).toBeNull();
  });
});

describe('rust binaryValidator（rustup shim 特判，2026-10-08）', () => {
  const rustSpec = REGISTRY.find((s) => s.languageId === 'rust')!;
  const validator = rustSpec.binaryValidator!;
  let rustupDir: string;
  let oldPath: string = '';

  /** 伪 rustup：`component list --installed` 输出给定组件行 */
  function mkRustup(components: string): void {
    fs.writeFileSync(
      path.join(rustupDir, 'rustup'),
      `#!/bin/sh\nprintf '%s\\n' ${components.split('\n').map((c) => `'${c}'`).join(' ')}\n`,
    );
    fs.chmodSync(path.join(rustupDir, 'rustup'), 0o755);
  }

  beforeEach(() => {
    rustupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-rustup-'));
    oldPath = process.env.PATH ?? '';
    invalidateBinaryValidatorCache();
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    invalidateBinaryValidatorCache();
    fs.rmSync(rustupDir, { recursive: true, force: true });
  });

  it('非 .cargo/bin 路径 → 直接放行（brew/系统真二进制不查 rustup）', () => {
    expect(validator('/opt/homebrew/bin/rust-analyzer')).toBe(true);
  });

  it('.cargo/bin shim + 组件表无 rust-analyzer → false（本机事故复现）', () => {
    mkRustup('rust-src\nrust-std');
    process.env.PATH = `${rustupDir}${path.delimiter}${oldPath}`;
    expect(validator(`${rustupDir}/proj/.cargo/bin/rust-analyzer`)).toBe(false);
  });

  it('组件表含 rust-analyzer → true；缓存生效（改伪 rustup 不 invalidate 仍旧值）', () => {
    mkRustup('rust-analyzer');
    process.env.PATH = `${rustupDir}${path.delimiter}${oldPath}`;
    expect(validator(`${rustupDir}/proj/.cargo/bin/rust-analyzer`)).toBe(true);
    mkRustup('rust-src'); // 组件表变了——但缓存未失效，应保持 true
    expect(validator(`${rustupDir}/proj/.cargo/bin/rust-analyzer`)).toBe(true);
    invalidateBinaryValidatorCache();
    expect(validator(`${rustupDir}/proj/.cargo/bin/rust-analyzer`)).toBe(false);
  });

  it('rustup 不可用（PATH 无）→ 保守放行 true（不把已装用户误判未装）', () => {
    process.env.PATH = rustupDir; // 目录里没有 rustup
    expect(validator(`${rustupDir}/proj/.cargo/bin/rust-analyzer`)).toBe(true);
  });
});
