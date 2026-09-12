// electron/tests/git/repos.test.ts
//
// 多仓 git 发现共享模块测试（v2.9 多仓 git Task 1）：discoverRepos 自
// journal/detector.ts 纯搬家上提，本文件直测新模块路径。discoverRepos 是
// 纯 fs 操作、无 DB / journal store 依赖——不引入 AP_USER_DATA_DIR 与
// runMigrations fixture（mock 收窄：只建被测对象必需的边界）。
//
// 断言清单（task brief Step 1）——照搬 detector.test.ts 既有 discoverRepos
// 用例断言（迁随语义，对账零漂移），另新增两用例：
//   - 根仓含入 / 根非 git 仓 / 内层仓 3 层内发现（默认深度边界）/
//     node_modules 与隐藏目录跳过 / symlink 不越界（新增）/
//     缓存 mtime 命中与失效 / 目录不存在防御
//   - 导出形状锁（新增）：DEFAULT_MAX_DEPTH === 3
//
// fixture 用真实 `git init`（外层 repo + inner/ 内层 repo + inner2/ 普通
// 目录），helper 与 detector.test.ts 同款。
//

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { discoverRepos, DEFAULT_MAX_DEPTH } from '../../src/main/git/repos';

const tmpRoot = path.join(os.tmpdir(), `ap-git-repos-${Date.now()}`);

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

describe('discoverRepos：多仓发现（共享模块直测）', () => {
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

  it('symlink 不越界：指向 workspace 外部仓的符号链接不被追踪（Dirent.isDirectory 对 symlink 恒 false）', () => {
    // workspace 外真实仓（对照断言：链接目标本身确是 git 仓，排除「目标非仓」假绿）
    const outside = fs.mkdtempSync(path.join(tmpRoot, 'outside-'));
    gitInit(outside);
    expect(fs.existsSync(path.join(outside, '.git'))).toBe(true);

    const ws = mkWorkspace();
    fs.symlinkSync(outside, path.join(ws, 'link'));
    expect(discoverRepos(ws)).toEqual([ws, path.join(ws, 'inner')]);
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

describe('导出形状锁', () => {
  it('DEFAULT_MAX_DEPTH === 3（spec §5.5 默认深度；共享模块新导出面）', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(3);
  });
});
