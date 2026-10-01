// 检测语义（spec §9）：markers glob（根 + 一层子目录 + 跳过清单）、
// 三态（ready / missing-binary / inactive）、缓存与强制重算。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectWorkspaceLanguages,
  redetectWorkspaceLanguages,
  activeLanguageIds,
} from '../../src/main/lsp/detect';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lsp-detect-'));
});

describe('markers 求值', () => {
  it('根 tsconfig 命中 typescript（binary 探测用真实 PATH，本用例只锁 toolchain）', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const st = detectWorkspaceLanguages('ws-d1', tmpDir);
    expect(st.find((s) => s.languageId === 'typescript')!.toolchain).toBe(true);
  });

  it('一层子目录 go.mod 命中 go（判据盲区修复的核心场景）', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(path.join(tmpDir, 'backend', 'go.mod'), 'module x');
    const st = detectWorkspaceLanguages('ws-d2', tmpDir);
    expect(st.find((s) => s.languageId === 'go')!.toolchain).toBe(true);
  });

  it('node_modules 内的标志被跳过', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep', 'go.mod'), 'module dep');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'tsconfig.json'), '{}');
    const st = detectWorkspaceLanguages('ws-d3', tmpDir);
    expect(st.find((s) => s.languageId === 'go')!.toolchain).toBe(false);
    expect(st.find((s) => s.languageId === 'typescript')!.toolchain).toBe(false);
  });

  it('无任何标志 → 全部 inactive 且 activeLanguageIds 为空', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'x');
    const st = detectWorkspaceLanguages('ws-d4', tmpDir);
    expect(st.every((s) => !s.toolchain)).toBe(true);
    expect(activeLanguageIds(st)).toEqual([]);
  });
});

describe('missing-binary 三态（伪 PATH 隔离）', () => {
  it('toolchain 命中但二进制不在伪 PATH → binary=false 不进快照', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module x');
    process.env.MOMO_LSP_TEST_PATH = '/nonexistent-lsp-path';
    const st = detectWorkspaceLanguages('ws-d5', tmpDir, '/nonexistent-lsp-path');
    const go = st.find((s) => s.languageId === 'go')!;
    expect(go.toolchain).toBe(true);
    expect(go.binary).toBe(false);
    expect(activeLanguageIds(st)).not.toContain('go');
    delete process.env.MOMO_LSP_TEST_PATH;
  });
});

describe('缓存', () => {
  it('同 workspace 二次调用走缓存；redetect 强制重算（新写入的标志被看到）', () => {
    const first = detectWorkspaceLanguages('ws-d6', tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]');
    const cached = detectWorkspaceLanguages('ws-d6', tmpDir);
    expect(cached.find((s) => s.languageId === 'rust')!.toolchain)
      .toBe(first.find((s) => s.languageId === 'rust')!.toolchain); // 缓存未变
    const fresh = redetectWorkspaceLanguages('ws-d6', tmpDir);
    expect(fresh.find((s) => s.languageId === 'rust')!.toolchain).toBe(true); // 重算看到
  });
});