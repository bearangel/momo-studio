// 注册表完备性 + PATH 探测器契约（spec §5/§9）。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  REGISTRY,
  findBinaryInPath,
  loginShellWhich,
  extensionToLanguageId,
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
