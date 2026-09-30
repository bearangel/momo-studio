// electron/tests/journal/detector.test.ts
//
// git 探测管道件测试：多仓发现（../git/repos）+ porcelain v1 解析
// （detector.parsePorcelain——baseline.ts 基线捕获消费的管道件）。
// 2026-09-30 scan IPC 退役：scanUnjournaled 对账用例随之移除（可从 git
// 历史找回）；porcelain 解析的边界语义（rename/引号 CJK/短行）改为直接
// 单测锁定，不再经 scan 间接覆盖。
//
// 仓库发现用真实 `git init` fixture（外层 repo + inner/ 内层 repo +
// inner2/ 普通目录）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { discoverRepos } from '../../src/main/git/repos';
import { parsePorcelain } from '../../src/main/journal/detector';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-detector-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
}

/** 建目录并 init 为仓（显式传路径：mkdirSync recursive 的返回值是首个创建目录，不可靠） */
function mkRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  gitInit(dir);
  return dir;
}

/** 标准 fixture：外层 repo + inner/ 内层 repo + inner2/ 普通目录 */
function mkWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  gitInit(ws);
  mkRepo(path.join(ws, 'inner'));
  fs.mkdirSync(path.join(ws, 'inner2'));
  return ws;
}

describe('discoverRepos：多仓发现', () => {
  it('外层根仓 + 内层仓发现；inner2 普通目录不含；返回绝对路径、根在前', () => {
    const ws = mkWorkspace();
    expect(discoverRepos(ws)).toEqual([ws, path.join(ws, 'inner')]);
  });

  it('根目录非 git 仓库 → 根不含，仅内层仓', () => {
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    mkRepo(path.join(ws, 'inner'));
    expect(discoverRepos(ws)).toEqual([path.join(ws, 'inner')]);
  });

  it('深度限制：默认 3 层内发现、第 4 层不发现；maxDepth=1 只看第一层', () => {
    // 默认深度边界：d1/d2/d3（第 3 层）发现，d1/d2/d3/d4（第 4 层）不发现
    // 注意：mkdirSync recursive 返回首个创建的目录——gitInit 必须显式传目标路径
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    fs.mkdirSync(path.join(ws, 'd1/d2/d3'), { recursive: true });
    gitInit(path.join(ws, 'd1/d2/d3'));
    fs.mkdirSync(path.join(ws, 'd1/d2/d3/d4'), { recursive: true });
    gitInit(path.join(ws, 'd1/d2/d3/d4'));
    expect(discoverRepos(ws)).toEqual([path.join(ws, 'd1/d2/d3')]);

    // 显式 maxDepth=1：inner（第 1 层）发现，inner/deep（第 2 层）不发现
    const ws2 = mkWorkspace();
    fs.mkdirSync(path.join(ws2, 'inner/deep'), { recursive: true });
    gitInit(path.join(ws2, 'inner/deep'));
    expect(discoverRepos(ws2, 1)).toEqual([ws2, path.join(ws2, 'inner')]);
    expect(discoverRepos(ws2, 2)).toEqual([ws2, path.join(ws2, 'inner'), path.join(ws2, 'inner/deep')]);
  });

  it('跳过 node_modules 与隐藏目录（.git 内部天然不深入）', () => {
    const ws = mkWorkspace();
    mkRepo(path.join(ws, 'node_modules/pkg'));
    mkRepo(path.join(ws, '.hidden/r'));
    const repos = discoverRepos(ws);
    expect(repos).toEqual([ws, path.join(ws, 'inner')]);
    expect(repos.some((r) => r.includes('node_modules'))).toBe(false);
    expect(repos.some((r) => r.includes('.hidden'))).toBe(false);
  });

  it('缓存：根 mtime 未变 → 命中不重 walk（期间新生的内层仓不可见）；根 mtime 变 → 重算', () => {
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    gitInit(ws); // 根仓
    fs.mkdirSync(path.join(ws, 'inner')); // inner 尚非 repo
    expect(discoverRepos(ws)).toEqual([ws]);

    // inner 变 repo 只改 inner 自身 mtime，根 mtime 不变 → 缓存命中、不重 walk：
    // 若此刻重 walk 会发现 inner（结果应仍是 [ws]——以此证明短路）
    gitInit(path.join(ws, 'inner'));
    expect(discoverRepos(ws)).toEqual([ws]);

    // 根目录新增条目 → 根 mtime 变化 → 缓存失效重算，inner 可见
    fs.writeFileSync(path.join(ws, 'marker.txt'), 'bump');
    expect(discoverRepos(ws)).toEqual([ws, path.join(ws, 'inner')]);
  });

  it('workspaceDir 不存在 → 空数组（防御，不抛错）', () => {
    expect(discoverRepos(path.join(tmpRoot, 'no-such-dir'))).toEqual([]);
  });
});

describe('parsePorcelain：porcelain v1 解析（baseline 捕获消费）', () => {
  it('M / untracked / A 行 → 路径列表；CRLF 行尾兼容', () => {
    const out = ' M README.md\n?? notes.md\nA  staged.ts\r\n';
    expect(parsePorcelain(out)).toEqual(['README.md', 'notes.md', 'staged.ts']);
  });

  it('rename/copy（R/C）行取 `旧 -> 新` 的新路径（现行存在位）', () => {
    const out = 'R  old-name.ts -> new-name.ts\nC  copy-a.ts -> copy-b.ts\n';
    expect(parsePorcelain(out)).toEqual(['new-name.ts', 'copy-b.ts']);
  });

  it('引号包裹的八进制转义 CJK 路径还原（\\346\\226\\207 = 文）', () => {
    // git core.quotePath 默认形态：非 ASCII 路径引号包裹 + 八进制字节转义
    // 「文档记」= E6 96 87 / E6 A1 A3 / E8 AE B0
    const out = '?? "\\346\\226\\207\\346\\241\\243\\350\\256\\260.md"\n';
    expect(parsePorcelain(out)).toEqual(['文档记.md']);
  });

  it('空输出 / 短行（<4 字符）→ 跳过不产出（防御）', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('?? \nXY \n\n')).toEqual([]);
  });
});
