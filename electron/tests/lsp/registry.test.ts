// 注册表完备性 + PATH 探测器契约（spec §5/§9）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REGISTRY, findBinaryInPath, extensionToLanguageId } from '../../src/main/lsp/registry';

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

  it('全 miss 返回 null；空 PATH 返回 null', () => {
    expect(findBinaryInPath(['nope'], '/nonexistent-dir-xyz')).toBeNull();
    expect(findBinaryInPath(['nope'], '')).toBeNull();
  });
});
