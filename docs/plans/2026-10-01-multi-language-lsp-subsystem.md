# 多语言 LSP 子系统重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LSP 子系统多语言化（16 门语言注册表 + 主进程 server 管家 + 子进程 IPC 薄客户端 + 设置页「语言服务」面板），修复判据盲区与每任务冷启动缺陷。

**Architecture:** 检测只在主进程跑一次（toolchain markers + 二进制 PATH 探测），快照经 `AGENT_CONFIG.lspLanguages` 注入子进程做注册门控、经 `lsp:status` 供面板消费（单一真相源）；现有 500 行 LspManager 从 lsp-tools.ts 迁出主进程并按 `(workspace × language)` 键控单例化；工具调用走 browser-ipc-bridge 同型 IPC 往返。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM）+ vitest；真实 LSP server 冒烟（tsserver / gopls / pyright，skip-if-binary-missing）。

**Spec:** `docs/specs/2026-10-01-multi-language-lsp-subsystem.md`（执行者须同时阅读）

## Global Constraints

- Node 20：先 `nvm use 20`（默认 Node 26 破坏 better-sqlite3）；包管理一律 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`
- 所有代码注释中文；标识符英文；Conventional Commits（feat:/refactor:/test:/docs:）
- IPC 契约改动（Task 4/5/6）后必须双 workspace `npx pnpm@9.0.0 typecheck`
- electron 测试集中 `electron/tests/`（镜像 src：`tests/lsp/`）；renderer 贴源 colocated
- 全量 electron 测试分片跑（单进程有预存 SIGSEGV teardown 竞态）；**宿主基线预存失败 = 16**（shell-net-trust 5 + shell-sandbox-wiring 2 + sandbox 目录 8 + lan-transport 1）——失败集合与基线一致即过，零新增才算回归
- 真实 server 冒烟一律 skip-if-binary-missing（`which` 探测 + `describe.skipIf`），不得让无 server 环境挂红
- renderer UI 只用语义 token + lucide-react 16px/stroke 1.75 图标（momo-ui-preview-rules）；Task 6 有**预览门禁**（见该任务 Step 0）
- better-sqlite3 ABI 横跳注意：跑 vitest 需 Node ABI（`cd node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 && npx prebuild-install`），跑 GUI 需 Electron ABI（`cd electron && npx electron-rebuild -f -w better-sqlite3`）；**切换前必须先停运行中的 dev app**（mmap 冲突会损坏文件）

## Review Focus

1. **node_modules 内的 toolchain 标志不得激活语言**（依赖包里遍地 go.mod/tsconfig）→ Task 2 Step 1 用例「node_modules 跳过」
2. **二进制缺失（missing-binary）时工具不得注册**，面板给出安装引导（能力广告真实）→ Task 2 Step 1「missing-binary 三态」+ Task 5 Step 1「快照为空 create 返回 null」
3. **冷启动长耗时不得被桥超时误杀**——首调诊断在 gopls/clangd 上 30s+，桥超时必须 ≥ 120s → Task 5 Step 1 常量断言用例
4. **每 workspace 并发第 4 门 server 启动必须中文报错**而非静默杀或崩溃 → Task 3 Step 1「并发上限」用例
5. **AGENT_CONFIG 缺 lspLanguages（旧 spawn 站点 / 既有测试构造）→ 不注册 LSP 工具、零报错**（向后兼容铁律）→ Task 5 Step 1「缺省兼容」用例

---

### Task 1: 语言注册表 + PATH 探测器

**Files:**
- Create: `electron/src/main/lsp/registry.ts`
- Test: `electron/tests/lsp/registry.test.ts`

**Interfaces:**
- Consumes: 无（叶模块）
- Produces（Task 2/3/4 消费）:
  - `LanguageServerSpec { languageId; label; binaries: string[]; args: string[]; markers: string[]; extensions: string[]; tier: 'verified'|'experimental'; installHint: string; initOverrides?: Record<string, unknown> }`
  - `REGISTRY: readonly LanguageServerSpec[]`（16 条）
  - `findBinaryInPath(binaries: string[], envPath?: string): string | null`（PATH 逐目录 + X_OK；`envPath` 测试注入，缺省 `process.env.PATH`）
  - `extensionToLanguageId(ext: string): string | null`（含点小写扩展名 → languageId，注册表顺序优先）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/lsp/registry.test.ts
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

  it('全 miss 返回 null；空 PATH 返回 null', () => {
    expect(findBinaryInPath(['nope'], '/nonexistent-dir-xyz')).toBeNull();
    expect(findBinaryInPath(['nope'], '')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/registry.test.ts
```

预期 FAIL（模块不存在）。

- [ ] **Step 3: 实现 registry.ts**

```typescript
// electron/src/main/lsp/registry.ts
// 多语言 LSP 注册表（spec §5）——声明式数据，无逻辑分支。
// markers 为 glob（仅支持单段 `*`）：`tsconfig.json` 精确文件；`*/tsconfig.json`
// 一层子目录内；`*.csproj` 根层通配。求值规则（跳过目录清单）见 detect.ts。
import fs from 'node:fs';
import path from 'node:path';

export interface LanguageServerSpec {
  languageId: string;
  label: string;
  binaries: string[];
  args: string[];
  markers: string[];
  extensions: string[];
  tier: 'verified' | 'experimental';
  installHint: string;
  initOverrides?: Record<string, unknown>;
}

export const REGISTRY: readonly LanguageServerSpec[] = [
  {
    languageId: 'typescript', label: 'TypeScript / JavaScript',
    binaries: ['typescript-language-server'], args: ['--stdio'],
    markers: ['tsconfig.json', 'jsconfig.json', '*/tsconfig.json', '*/jsconfig.json'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    tier: 'verified',
    installHint: 'npm install -g typescript-language-server typescript',
  },
  {
    languageId: 'python', label: 'Python',
    binaries: ['pyright-langserver'], args: ['--stdio'],
    markers: ['pyproject.toml', 'requirements*.txt', 'setup.py', 'setup.cfg'],
    extensions: ['.py', '.pyi'],
    tier: 'verified',
    installHint: 'pip install pyright（或 npm install -g pyright）',
  },
  {
    languageId: 'go', label: 'Go',
    binaries: ['gopls'], args: [],
    markers: ['go.mod', '*/go.mod'],
    extensions: ['.go'],
    tier: 'verified',
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    languageId: 'rust', label: 'Rust',
    binaries: ['rust-analyzer'], args: [],
    markers: ['Cargo.toml', '*/Cargo.toml'],
    extensions: ['.rs'],
    tier: 'verified',
    installHint: 'rustup component add rust-analyzer',
  },
  {
    languageId: 'cpp', label: 'C / C++',
    binaries: ['clangd'], args: [],
    markers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile', 'configure.ac'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'],
    tier: 'verified',
    installHint: 'brew install llvm（macOS，然后加入 PATH）或系统包管理器安装 clangd',
    initOverrides: { fallbackFlags: ['-std=c++17'] },
  },
  {
    languageId: 'swift', label: 'Swift / Objective-C',
    binaries: ['sourcekit-lsp'], args: [],
    markers: ['Package.swift'],
    extensions: ['.swift'],
    tier: 'verified',
    installHint: 'xcode-select --install（Xcode Command Line Tools 自带）',
  },
  {
    languageId: 'ruby', label: 'Ruby',
    binaries: ['ruby-lsp'], args: [],
    markers: ['Gemfile', '*.gemspec'],
    extensions: ['.rb'],
    tier: 'verified',
    installHint: 'gem install ruby-lsp',
  },
  {
    languageId: 'lua', label: 'Lua',
    binaries: ['lua-language-server'], args: [],
    markers: ['.luarc.json'],
    extensions: ['.lua'],
    tier: 'verified',
    installHint: 'brew install lua-language-server 或 GitHub release 下载',
  },
  {
    languageId: 'shell', label: 'Shell',
    binaries: ['bash-language-server'], args: ['start'],
    markers: ['*.sh'],
    extensions: ['.sh', '.bash'],
    tier: 'verified',
    installHint: 'npm install -g bash-language-server',
  },
  {
    languageId: 'csharp', label: 'C#',
    binaries: ['csharp-ls'], args: [],
    markers: ['*.csproj', '*.sln'],
    extensions: ['.cs'],
    tier: 'verified',
    installHint: 'dotnet tool install --global csharp-ls',
  },
  {
    languageId: 'dart', label: 'Dart / Flutter',
    binaries: ['dart'], args: ['language-server', '--protocol=lsp'],
    markers: ['pubspec.yaml'],
    extensions: ['.dart'],
    tier: 'verified',
    installHint: '安装 Dart SDK（server 随 SDK 自带）',
  },
  {
    languageId: 'zig', label: 'Zig',
    binaries: ['zls'], args: [],
    markers: ['build.zig'],
    extensions: ['.zig'],
    tier: 'verified',
    installHint: 'brew install zls 或 GitHub release 下载',
  },
  {
    languageId: 'java', label: 'Java',
    binaries: ['jdtls'], args: [],
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    extensions: ['.java'],
    tier: 'experimental',
    installHint: 'brew install jdtls（实验性：部分项目布局可能需要额外配置）',
  },
  {
    languageId: 'kotlin', label: 'Kotlin',
    binaries: ['kotlin-language-server'], args: ['--stdio'],
    markers: ['*.kt', 'build.gradle.kts'],
    extensions: ['.kt', '.kts'],
    tier: 'experimental',
    installHint: 'brew install kotlin-language-server（实验性）',
  },
  {
    languageId: 'php', label: 'PHP',
    binaries: ['intelephense'], args: ['--stdio'],
    markers: ['composer.json', 'index.php', 'artisan'],
    extensions: ['.php'],
    tier: 'experimental',
    installHint: 'npm install -g intelephense（实验性）',
  },
  {
    languageId: 'elixir', label: 'Elixir',
    binaries: ['lexical', 'lexical-server'], args: [],
    markers: ['mix.exs'],
    extensions: ['.ex', '.exs'],
    tier: 'experimental',
    installHint: '按 lexical 官方文档安装（实验性）',
  },
];

/** 扩展名 → languageId（注册表顺序优先：.h 归 cpp） */
export function extensionToLanguageId(ext: string): string | null {
  const e = ext.toLowerCase();
  for (const s of REGISTRY) {
    if (s.extensions.includes(e)) return s.languageId;
  }
  return null;
}

/** PATH 探测：逐目录拼接 + X_OK 可执行检查；命中返回绝对路径 */
export function findBinaryInPath(binaries: string[], envPath?: string): string | null {
  const dirs = (envPath ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const bin of binaries) {
    if (bin.includes(path.sep)) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        return bin;
      } catch { /* 继续候选 */ }
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch { /* 下一目录 */ }
    }
  }
  return null;
}
```

- [ ] **Step 4: 跑绿**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/lsp/registry.ts electron/tests/lsp/registry.test.ts
git commit -m "feat: LSP 语言注册表（16 门）与 PATH 探测器"
```

---

### Task 2: workspace 检测（detect）

**Files:**
- Create: `electron/src/main/lsp/detect.ts`
- Test: `electron/tests/lsp/detect.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`、`findBinaryInPath`（Task 1）
- Produces（Task 4 面板 + Task 5 spawn 注入消费）:
  - `LanguageStatus { languageId; label; tier; toolchain: boolean; binary: boolean; running: 'running'|'idle'|'stopped'; installHint: string }`
  - `detectWorkspaceLanguages(workspaceId: string, workspaceDir: string): LanguageStatus[]`（带 per-workspace 缓存）
  - `redetectWorkspaceLanguages(workspaceId: string, workspaceDir: string): LanguageStatus[]`（强制重算刷新缓存）
  - `activeLanguageIds(statuses: LanguageStatus[]): string[]`（ready 集 → lspLanguages 快照）
  - `SKIP_DIRS: readonly string[]`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/lsp/detect.test.ts
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
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'dep'));
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
```

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/detect.test.ts
```

- [ ] **Step 3: 实现 detect.ts**

```typescript
// electron/src/main/lsp/detect.ts
// workspace 语言检测（spec §9）——主进程单一真相源：
//   消费方 A：spawn 时 activeLanguageIds 快照注入 AGENT_CONFIG.lspLanguages
//   消费方 B：lsp:status 面板
import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY, findBinaryInPath, type LanguageServerSpec } from './registry';
import { getLspRunState, type LspRunState } from './run-state';

/** marker 求值跳过的目录名（依赖目录里遍地 go.mod/tsconfig） */
export const SKIP_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', 'vendor', 'out',
];

export interface LanguageStatus {
  languageId: string;
  label: string;
  tier: 'verified' | 'experimental';
  toolchain: boolean;
  binary: boolean;
  running: LspRunState;
  installHint: string;
}

/** 单段 glob 匹配（仅 `*`）：`a/*.csproj` / `*.sh` / `tsconfig.json` */
function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length !== target.length) return false;
  return pattern.every((p, i) =>
    p === '*' ? true : p.includes('*') ? globSeg(p, target[i]!) : p === target[i],
  );
}
function globSeg(pat: string, s: string): boolean {
  const parts = pat.split('*');
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    const at = s.indexOf(parts[i]!, idx);
    if (at < 0 || (i === 0 && at !== 0)) return false;
    idx = at + parts[i]!.length;
  }
  return true;
}

/** markers 求值：根 + 一层子目录（跳过 SKIP_DIRS） */
export function markersHit(workspaceDir: string, markers: string[]): boolean {
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(workspaceDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const rootNames = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
  const subDirs = rootEntries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.includes(e.name))
    .map((e) => e.name);
  for (const marker of markers) {
    const segs = marker.split('/');
    if (segs.length === 1) {
      if (rootNames.some((n) => matchSegments([marker], [n]))) return true;
    } else {
      // 一层子目录形态：*/go.mod、requirements*.txt 不含斜杠——双段仅此形态
      for (const d of subDirs) {
        let names: string[];
        try {
          names = fs.readdirSync(path.join(workspaceDir, d)).filter((f) => {
            try { return fs.statSync(path.join(workspaceDir, d, f)).isFile(); } catch { return false; }
          });
        } catch { continue; }
        if (names.some((n) => matchSegments(segs.slice(1), [n]))) return true;
      }
    }
  }
  return false;
}

const cache = new Map<string, LanguageStatus[]>();

function buildStatuses(workspaceId: string, workspaceDir: string, envPath?: string): LanguageStatus[] {
  return REGISTRY.map((spec: LanguageServerSpec) => ({
    languageId: spec.languageId,
    label: spec.label,
    tier: spec.tier,
    toolchain: markersHit(workspaceDir, spec.markers),
    binary: findBinaryInPath(spec.binaries, envPath) !== null,
    running: getLspRunState(workspaceId, spec.languageId),
    installHint: spec.installHint,
  }));
}

export function detectWorkspaceLanguages(
  workspaceId: string,
  workspaceDir: string,
  envPath?: string,
): LanguageStatus[] {
  let c = cache.get(workspaceId);
  if (!c) {
    c = buildStatuses(workspaceId, workspaceDir, envPath);
    cache.set(workspaceId, c);
  }
  return c;
}

export function redetectWorkspaceLanguages(
  workspaceId: string,
  workspaceDir: string,
  envPath?: string,
): LanguageStatus[] {
  const c = buildStatuses(workspaceId, workspaceDir, envPath);
  cache.set(workspaceId, c);
  return c;
}

/** ready 集 → AGENT_CONFIG.lspLanguages 快照（实验层命中亦进） */
export function activeLanguageIds(statuses: LanguageStatus[]): string[] {
  return statuses.filter((s) => s.toolchain && s.binary).map((s) => s.languageId);
}
```

（`getLspRunState`/`LspRunState` 由 Task 3 的 manager 提供——本任务先建薄桩文件 `electron/src/main/lsp/run-state.ts`：`export type LspRunState = 'running' | 'idle' | 'stopped'; export function getLspRunState(_ws: string, _lang: string): LspRunState { return 'stopped'; }`，Task 3 实装。）

先写 `run-state.ts` 桩，再跑绿。

- [ ] **Step 4: 跑绿**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/detect.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/lsp/detect.ts electron/src/main/lsp/run-state.ts electron/tests/lsp/detect.test.ts
git commit -m "feat: LSP workspace 检测（markers glob + 三态 + 缓存）"
```

---

### Task 3: 主进程 LspManager 迁移泛化

**Files:**
- Create: `electron/src/main/lsp/manager.ts`
- Modify: `electron/src/main/lsp/run-state.ts`（桩 → 实装）
- Test: `electron/tests/lsp/manager.test.ts`

**Interfaces:**
- Consumes: `LanguageServerSpec`、`findBinaryInPath`（Task 1）
- Produces（Task 4 消费）:
  - `getLspManager(workspaceId: string, languageId: string): LspManager | undefined`
  - `ensureLspManager(workspaceId: string, workspaceDir: string, spec: LanguageServerSpec): Promise<LspManager>`
  - `getLspRunState(workspaceId, languageId): LspRunState`（run-state 实装）
  - `MAX_ACTIVE_SERVERS_PER_WS = 3`
  - `LspManager.getDiagnostics(absPath, content): Promise<LspDiagnostic[]>` / `findReferences(absPath, line0, char0): Promise<LspLocation[]>`（签名与现有 lsp-tools.ts 相同）
  - `shutdownAllLspManagers(): Promise<void>`（测试清理）

**背景：** 现有 `electron/src/main/agent/tools/lsp-tools.ts:150-530` 的 `LspManager` 是完整 LSP 客户端（JSON-RPC 分帧 / pending 表 / 诊断代数等待 / didOpen·didChange 同步 / 闲置 shutdown / 意外退出恢复 / 单飞启动）。**本任务是迁移 + 参数化，不是重写**——lsp-tools.ts 的旧内嵌实现暂不删除（Task 5 切 IPC 时删，两任务间无冲突：新旧活在不同进程域）。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/lsp/manager.test.ts
// manager 泛化契约：per-language 键控 / binaries 顺序探测 / 并发上限 /
// run-state 实装 / tsserver 真实冒烟（skip-if-binary-missing，沿用
// 现有 lsp-tools.test 的真实 server 模式：30s 超时 + afterEach 强制清理）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureLspManager,
  getLspManager,
  getLspRunState,
  shutdownAllLspManagers,
  MAX_ACTIVE_SERVERS_PER_WS,
} from '../../src/main/lsp/manager';
import { REGISTRY, findBinaryInPath } from '../../src/main/lsp/registry';

const LSP_TEST_TIMEOUT = 30_000;
const hasTsLs = findBinaryInPath(['typescript-language-server']) !== null;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lsp-mgr-')); });
afterEach(async () => { await shutdownAllLspManagers(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('键控与上限（不触真实 server——用必然失败的伪 spec 断言异常路径）', () => {
  it('getLspManager 未启动返回 undefined；启动失败（伪二进制）reject 且单例被驱逐不毒化', async () => {
    const ws = `ws-m1-${Date.now()}`;
    expect(getLspManager(ws, 'typescript')).toBeUndefined();
    const fake = { ...REGISTRY.find((s) => s.languageId === 'typescript')!, binaries: ['nonexistent-lsp-bin-xyz'] };
    await expect(ensureLspManager(ws, tmpDir, fake)).rejects.toThrow(/已关闭|spawn 失败|未安装/i);
    // 失败的 manager 不得留在单例表——下次调用重新尝试而非永远拿到死实例
    expect(getLspManager(ws, 'typescript')).toBeUndefined();
  });

  it(`并发第 ${MAX_ACTIVE_SERVERS_PER_WS + 1} 门启动报中文错误`, async () => {
    const ws = `ws-m2-${Date.now()}`;
    // 预占 3 个活跃槽（直接操作内部计数的测试钩子）
    for (let i = 0; i < MAX_ACTIVE_SERVERS_PER_WS; i++) {
      await import('../../src/main/lsp/manager').then((m) => m.__testOccupySlot(ws));
    }
    const spec = REGISTRY.find((s) => s.languageId === 'typescript')!;
    await expect(ensureLspManager(ws, tmpDir, spec)).rejects.toThrow(/活跃语言服务已达上限/);
  });

  it('getLspRunState 缺省 stopped', () => {
    expect(getLspRunState(`ws-m3-${Date.now()}`, 'go')).toBe('stopped');
  });
});

describe.skipIf(!hasTsLs)('tsserver 真实冒烟（迁移后协议仍通）', () => {
  it('diagnostics 返回语法错误；references 含定义位', async () => {
    const ws = `ws-m4-${Date.now()}`;
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(file, 'const x: number = "not-a-number";\nexport function fn(): number { return x; }\n');
    const spec = REGISTRY.find((s) => s.languageId === 'typescript')!;
    const mgr = await ensureLspManager(ws, tmpDir, spec);
    const diags = await mgr.getDiagnostics(file, fs.readFileSync(file, 'utf-8'));
    expect(diags.length).toBeGreaterThan(0); // 类型错误被捕获
    expect(getLspRunState(ws, 'typescript')).toBe('running');
    const refs = await mgr.findReferences(file, 1, 16); // fn 定义位（0-based line 1）
    expect(refs.length).toBeGreaterThanOrEqual(1);
  }, LSP_TEST_TIMEOUT);
});
```

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/manager.test.ts
```

- [ ] **Step 3: 实现——从 lsp-tools.ts 迁移 + 七处参数化**

新建 `electron/src/main/lsp/manager.ts`：**将 `lsp-tools.ts:150-530` 的 `LspManager` 类、类型 `LspDiagnostic`/`LspLocation`/`RpcMessage`、常量 `DIAGNOSTIC_WAIT_MS`/`REQUEST_TIMEOUT_MS`/`IDLE_TIMEOUT_MS`/`IDLE_CHECK_INTERVAL_MS`/`OUTPUT_LIMITS`（如在本文件）与 `pathToFileUri`/`truncateArray`/`formatDiagnostic` 等 helper 原样复制**，然后做以下修改（逐处给出）：

(1) 构造参数化：

```typescript
export class LspManager {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceDir: string,
    private readonly spec: LanguageServerSpec,   // 新增：语言规格
  ) {}
```

(2) `doInitialize` 内 `resolveServerBin()` 替换为按 spec 探测：

```typescript
    const bin = findBinaryInPath(this.spec.binaries);
    if (!bin) {
      throw new Error(`语言服务 ${this.spec.label} 未安装——${this.spec.installHint}`);
    }
    const proc = spawn(bin, this.spec.args, {   // args 来自 spec（--stdio 等）
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,                              // 绝对路径直启（探测已解析）
    });
```

(3) initialize 的 `initializationOptions: {}` 替换为：

```typescript
      initializationOptions: this.spec.initOverrides ?? {},
```

(4) `inferLanguageId` 删除——`syncDocument` 的 languageId 改 `this.spec.languageId`。

(5) 单例表键控与上限：

```typescript
/** workspaceId:languageId → LspManager（主进程单例——冷启动全 app 一次，spec §6） */
const managers = new Map<string, LspManager>();
/** 每 workspace 活跃 server 上限（资源保险丝——超限报错不静默杀，spec §6） */
export const MAX_ACTIVE_SERVERS_PER_WS = 3;
/** 测试钩子：预占活跃槽（不 spawn，只占计数） */
export async function __testOccupySlot(workspaceId: string): Promise<void> {
  activeCount.set(workspaceId, (activeCount.get(workspaceId) ?? 0) + 1);
}
const activeCount = new Map<string, number>();

export function getLspManager(workspaceId: string, languageId: string): LspManager | undefined {
  return managers.get(`${workspaceId}:${languageId}`);
}

export async function ensureLspManager(
  workspaceId: string,
  workspaceDir: string,
  spec: LanguageServerSpec,
): Promise<LspManager> {
  const key = `${workspaceId}:${spec.languageId}`;
  let mgr = managers.get(key);
  if (!mgr) {
    if ((activeCount.get(workspaceId) ?? 0) >= MAX_ACTIVE_SERVERS_PER_WS) {
      throw new Error(
        `活跃语言服务已达上限（${MAX_ACTIVE_SERVERS_PER_WS} 门）：请等待闲置回收或减少并行语言任务`,
      );
    }
    mgr = new LspManager(workspaceId, workspaceDir, spec);
    managers.set(key, mgr);
  }
  try {
    await mgr.ensureStarted();
  } catch (err) {
    // 启动失败驱逐单例：下次调用重新尝试（spawn 失败不得毒化 Map——死实例
    // 恒 started=false，每次调用都拿到同一个必败对象且无从恢复）
    managers.delete(key);
    throw err;
  }
  return mgr;
}

export async function shutdownAllLspManagers(): Promise<void> {
  await Promise.all([...managers.values()].map((m) => m.shutdown()));
  managers.clear();
  activeCount.clear();
}
```

（`shutdown`/`handleUnexpectedExit` 内同步维护 `activeCount`：shutdown 成功后 `activeCount.set(ws, max(0, n-1))`；意外退出清 `started` 时同减。）

(6) run-state 实装——`run-state.ts` 替换桩：

```typescript
// electron/src/main/lsp/run-state.ts
import { getLspManager } from './manager';
export type LspRunState = 'running' | 'idle' | 'stopped';
export function getLspRunState(workspaceId: string, languageId: string): LspRunState {
  const m = getLspManager(workspaceId, languageId);
  if (!m || !m.isStarted()) return 'stopped';
  return m.isIdle() ? 'idle' : 'running';
}
```

（`LspManager` 加 `isIdle(): boolean { return this.started && Date.now() - this.lastActivity > 60_000; }`——60s 无活动即报 idle，供面板展示。）

(7) `ensureLspManager` 单飞语义：类内 `startingPromise` 已保证并发复用；上限检查在 Map miss 分支（并发窗口内两个不同语言同时 miss 计数未增的竞态可接受——上限是保险丝不是硬配额，注释说明）。

- [ ] **Step 4: 跑绿 + typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/
npx pnpm@9.0.0 typecheck
```

（既有 `tests/agent/tools/lsp-tools.test.ts` 不动——旧内嵌实现仍在。）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/lsp/ electron/tests/lsp/manager.test.ts
git commit -m "feat: LspManager 迁移主进程并按语言参数化（键控单例 + 并发上限）"
```

---

### Task 4: 主进程 IPC 路由（lsp:op + lsp:status）

**Files:**
- Create: `electron/src/main/lsp/ipc.ts`
- Modify: `electron/src/main/agent/agent-runner.ts:277`（消息监听器加 lsp:op 分支，browser-op 同型位）
- Modify: `electron/src/main/settings/ipc.ts` 或 settings IPC 注册处（`lsp:status` / `lsp:redetect` invoke；实现时 grep `registerSettingsIpc` 定位）
- Test: `electron/tests/lsp/ipc.test.ts`

**Interfaces:**
- Consumes: `ensureLspManager`、`getLspManager`、`REGISTRY`、`extensionToLanguageId`（Task 1/3）、`detectWorkspaceLanguages`/`redetectWorkspaceLanguages`（Task 2）
- Produces（Task 5 子进程桥 + Task 6 面板消费）:
  - 线协议：子 → 主 `{ type: 'lsp:op', requestId, op: { kind, workspaceId, workspaceDir?, path, content?, line?, character? } }`；主 → 子 `{ type: 'lsp:op-result', requestId, ok, result? , error? }`
  - `routeLspOp(child: { send: (msg: unknown) => void }, msg: unknown): Promise<void>`（agent-runner 分发调用）
  - invoke `lsp:status(workspaceId)` → `LanguageStatus[]`；`lsp:redetect(workspaceId)` → `LanguageStatus[]`

**注意：** op 需带 `workspaceDir`（主进程 manager spawn 需要；子进程从自身 config 透传——安全边界：主进程以 workspaceId 为准查 `getWorkspace(workspaceId).directoryPath` 校验 path 在 workspace 内，不信子进程自报的 workspaceDir。**实现按校验版本：workspaceDir 一律主进程自查，op 不带此字段**）。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/lsp/ipc.test.ts
// 路由契约：envelope 校验 / 扩展名路由 / reqId 回带 / 错误路径 ok:false /
// path 越界拒绝 / lsp:status·redetect invoke。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeLspOp } from '../../src/main/lsp/ipc';
import * as manager from '../../src/main/lsp/manager';

vi.mock('../../src/main/lsp/manager', () => ({
  ensureLspManager: vi.fn(),
  getLspRunState: vi.fn(() => 'stopped'),
}));
vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: vi.fn(() => ({ directoryPath: '/tmp/ws-x' })),
}));

function fakeChild(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('routeLspOp', () => {
  it('合法 diagnostics op：扩展名路由 typescript，结果格式化回发', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockResolvedValue({
      getDiagnostics: vi.fn().mockResolvedValue([
        { severity: 1, message: '类型错误', range: { start: { line: 0, character: 6 } } },
      ]),
      findReferences: vi.fn(),
    } as unknown as manager.LspManager);
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r1',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'src/a.ts', content: 'const x: number = "s";' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.type).toBe('lsp:op-result');
    expect(reply.requestId).toBe('r1');
    expect(reply.ok).toBe(true);
    expect(String(reply.result)).toContain('类型错误');
    // ensureLspManager(workspaceId, workspaceDir, spec)——语言在 spec.languageId（第 3 参）
    expect(vi.mocked(manager.ensureLspManager).mock.calls[0]![2].languageId).toBe('typescript');
  });

  it('未知扩展名 → ok:false 中文错误', async () => {
    const child = fakeChild();
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r2',
      op: { kind: 'diagnostics', workspaceId: 'ws-x', path: 'doc.pdf', content: '' },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/不支持的语言|无法识别/);
  });

  it('manager 抛错 → ok:false 错误文案透传', async () => {
    const child = fakeChild();
    vi.mocked(manager.ensureLspManager).mockRejectedValue(new Error('语言服务 Go 未安装——go install ...'));
    await routeLspOp(child, {
      type: 'lsp:op', requestId: 'r3',
      op: { kind: 'references', workspaceId: 'ws-x', path: 'main.go', line: 1, character: 0 },
    });
    const reply = child.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('未安装');
  });

  it('非法 envelope（缺 requestId / 未知 kind）静默忽略不崩', async () => {
    const child = fakeChild();
    await routeLspOp(child, { type: 'lsp:op' });
    await routeLspOp(child, { type: 'lsp:op', requestId: 'r4', op: { kind: 'zzz' } });
    expect(child.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/ipc.test.ts
```

- [ ] **Step 3: 实现 ipc.ts + 接线**

```typescript
// electron/src/main/lsp/ipc.ts
// LSP 子进程 op 路由 + 面板 invoke（spec §7/§8）。
// 子进程 op 不带 workspaceDir（安全边界：主进程以 workspaceId 自查目录，
// path 必须落在 workspace 内——不信子进程自报）。
import path from 'node:path';
import { ipcMain } from 'electron';
import { REGISTRY, extensionToLanguageId } from './registry';
import { ensureLspManager } from './manager';
import { detectWorkspaceLanguages, redetectWorkspaceLanguages } from './detect';
import { getWorkspace } from '../workspace/crud';

interface LspOpEnvelope {
  type: 'lsp:op';
  requestId: string;
  op: {
    kind: 'diagnostics' | 'references';
    workspaceId: string;
    path: string;
    content?: string;
    line?: number;
    character?: number;
  };
}

function reply(child: { send: (m: unknown) => void }, requestId: string, ok: boolean, payload?: string): void {
  child.send(
    ok
      ? { type: 'lsp:op-result', requestId, ok: true, result: payload ?? '' }
      : { type: 'lsp:op-result', requestId, ok: false, error: payload },
  );
}

export async function routeLspOp(child: { send: (m: unknown) => void }, msg: unknown): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as Partial<LspOpEnvelope>;
  if (m.type !== 'lsp:op' || typeof m.requestId !== 'string' || typeof m.op !== 'object') return;
  const op = m.op!;
  if (op.kind !== 'diagnostics' && op.kind !== 'references') return;
  try {
    const ws = getWorkspace(op.workspaceId);
    const absPath = path.resolve(ws.directoryPath, op.path);
    if (!absPath.startsWith(ws.directoryPath + path.sep)) {
      throw new Error(`路径越界：${op.path}`);
    }
    const languageId = extensionToLanguageId(path.extname(absPath));
    if (!languageId) {
      throw new Error(`无法识别文件语言（扩展名 ${path.extname(absPath) || '无'}）——当前支持：${REGISTRY.map((s) => s.label).join('、')}`);
    }
    const spec = REGISTRY.find((s) => s.languageId === languageId)!;
    const mgr = await ensureLspManager(op.workspaceId, ws.directoryPath, spec);
    if (op.kind === 'diagnostics') {
      const diags = await mgr.getDiagnostics(absPath, op.content ?? '');
      const text = diags.length === 0
        ? `✓ ${op.path} 无诊断`
        : diags.map((d) => {
            const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warn' : 'info';
            return `${op.path}:${(d.range.start.line ?? 0) + 1}:${(d.range.start.character ?? 0) + 1} - ${sev}: ${d.message}`;
          }).join('\n');
      reply(child, m.requestId, true, text);
    } else {
      const locs = await mgr.findReferences(absPath, (op.line ?? 1) - 1, op.character ?? 0);
      const text = locs.length === 0
        ? '(无引用)'
        : locs.map((l) => {
            const rel = path.relative(ws.directoryPath, fileUriToPath(l.uri));
            return `${rel}:${(l.range.start.line ?? 0) + 1}:${(l.range.start.character ?? 0) + 1}`;
          }).join('\n');
      reply(child, m.requestId, true, text);
    }
  } catch (err) {
    reply(child, m.requestId, false, err instanceof Error ? err.message : String(err));
  }
}

function fileUriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
// （fileUriToPath 从 manager.ts 导出复用——迁移时把 manager 内该 helper 加 export，
//  此处 import { fileUriToPath } from './manager'，本文件不重复定义。）

/** 面板 invoke 注册（settings IPC 注册处调用） */
export function registerLspPanelIpc(): void {
  ipcMain.handle('lsp:status', (_e, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    return detectWorkspaceLanguages(workspaceId, ws.directoryPath);
  });
  ipcMain.handle('lsp:redetect', (_e, workspaceId: string) => {
    const ws = getWorkspace(workspaceId);
    return redetectWorkspaceLanguages(workspaceId, ws.directoryPath);
  });
}
```

接线两处：
(a) `agent-runner.ts` 消息监听器（:277 `if (m.type === 'browser-op')` 同型位）加：

```typescript
      if (m.type === 'lsp:op') {
        void routeLspOp(child, msg);
        return;
      }
```

（import `routeLspOp` from '../lsp/ipc'——agent-runner 已有 child 引用模式照抄 routeBrowserOpToChild 邻位。）

(b) settings IPC 注册处（grep `registerSettingsIpc` 定位文件）调 `registerLspPanelIpc()`。

- [ ] **Step 4: 跑绿 + typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/lsp/ipc.ts electron/src/main/agent/agent-runner.ts electron/src/main/settings/ electron/tests/lsp/ipc.test.ts
git commit -m "feat: LSP 主进程 op 路由与面板 invoke（lsp:op / lsp:status / lsp:redetect）"
```

---

### Task 5: 子进程切薄客户端 + AGENT_CONFIG 透传

**Files:**
- Create: `electron/src/main/agent/tools/lsp-ipc-bridge.ts`（子进程侧桥）
- Modify: `electron/src/main/agent/tools/lsp-tools.ts`（删内嵌 LspManager ~500 行 → 薄客户端）
- Modify: `electron/src/main/agent/runtime-entry.ts`（ctx 透传 lspLanguages；taskMessageListener 加 lsp:op-result 分发）
- Modify: `electron/src/main/agent/runtime-config.ts`（AgentRuntimeOpts + RuntimeConfig 加 `lspLanguages?: string[]`；parseConfig 缺省 `[]`）
- Modify: `electron/src/main/agent/tools/types.ts`（ToolContext 加 `lspLanguages?: string[]`）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（buildSpawnOpts 注入快照）
- Test: `electron/tests/agent/tools/lsp-tools.test.ts`（重写）；`electron/tests/agent/tools/catalog-selfdescribe.test.ts`（LSP conditional 文案断言更新）

**Interfaces:**
- Consumes: Task 4 线协议；`detectWorkspaceLanguages`/`activeLanguageIds`（Task 2）
- Produces: `LspTools`（门控 `ctx.lspLanguages` 非空）；`handleLspOpResult(msg: unknown): void`（runtime-entry 分发）

- [ ] **Step 1: 重写失败测试**

重写 `electron/tests/agent/tools/lsp-tools.test.ts`（旧真实 server 用例由 Task 3 冒烟承接；本文件改为桥契约 + 门控）：

```typescript
// electron/tests/agent/tools/lsp-tools.test.ts
// 薄客户端契约：门控（快照空 → create null / 非空 → 实例）；
// 非 fork 环境 execute 立即 reject（process.send 缺失——browser-ipc-bridge 同款铁律）；
// 缺省兼容（AGENT_CONFIG 无 lspLanguages）。
import { describe, it, expect, vi } from 'vitest';
import { LspTools } from '../../../src/main/agent/tools/lsp-tools';
import { handleLspOpResult, LSP_OP_BRIDGE_TIMEOUT_MS } from '../../../src/main/agent/tools/lsp-ipc-bridge';
import type { ToolContext } from '../../../src/main/agent/tools/types';

function ctxWith(lspLanguages?: string[]): ToolContext {
  return {
    workspaceId: 'ws-t', workspaceDir: '/tmp/ws-t',
    wsFs: { assertInWorkspace: (p: string) => `/tmp/ws-t/${p}` } as ToolContext['wsFs'],
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 's', roomId: 'r', sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] }, creatorUserId: 'u',
    ...(lspLanguages !== undefined ? { lspLanguages } : {}),
  } as ToolContext;
}

describe('LspTools.create 门控', () => {
  it('快照非空 → 实例；空数组 / 缺省 → null（缺省兼容铁律）', () => {
    expect(LspTools.create(ctxWith(['typescript']))).not.toBeNull();
    expect(LspTools.create(ctxWith([]))).toBeNull();
    expect(LspTools.create(ctxWith(undefined))).toBeNull();
  });
});

describe('execute 非 fork 环境', () => {
  it('process.send 缺失 → 立即 reject 中文文案（不挂等超时；references 路径不读文件，直达 sendLspOp）', async () => {
    const tools = LspTools.create(ctxWith(['typescript']))!;
    await expect(
      tools.execute('lsp_find_references', { path: 'a.ts', line: 1, character: 0 }, ctxWith(['typescript'])),
    ).rejects.toThrow(/LSP IPC 不可用/);
  });
});

describe('handleLspOpResult', () => {
  it('requestId 匹配 resolve；未知 ID 静默忽略', async () => {
    // 经 execute 发不出（无 process.send）——直接测 result 分发的 pending 语义：
    // 构造一个在途请求（经内部导出的测试钩子注册），再喂 result
    const reg = vi.fn();
    const id = (await import('../../../src/main/agent/tools/lsp-ipc-bridge')).__testRegisterPending(reg, (e: Error) => void e);
    handleLspOpResult({ type: 'lsp:op-result', requestId: id, ok: true, result: '✓ ok' });
    await new Promise((r) => setTimeout(r, 10));
    expect(reg).toHaveBeenCalledWith('✓ ok');
    handleLspOpResult({ type: 'lsp:op-result', requestId: 'unknown-id', ok: true, result: 'x' }); // 不崩
  });
});

describe('桥超时常量', () => {
  it('LSP_OP_BRIDGE_TIMEOUT_MS ≥ 120s（冷启动 30s+ 不得被误杀——Review Focus 3）', () => {
    expect(LSP_OP_BRIDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
```

`catalog-selfdescribe.test.ts` 的 LSP 断言更新（原断言 `conditional` 含 `'TS/JS'`）：

```typescript
  it('LSP 条目带 conditional 标注且 defaultOn=false', () => {
    expect(LSP_CATALOG_ENTRIES).toHaveLength(2);
    for (const e of LSP_CATALOG_ENTRIES) {
      expect(e.conditional).toContain('自动检测');
      expect(e.defaultOn).toBe(false);
    }
  });
```

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/lsp-tools.test.ts tests/agent/tools/catalog-selfdescribe.test.ts
```

- [ ] **Step 3: 实现**

(1) 新建 `electron/src/main/agent/tools/lsp-ipc-bridge.ts`（browser-ipc-bridge 精简同型）：

```typescript
// electron/src/main/agent/tools/lsp-ipc-bridge.ts
// LSP 工具子进程 IPC 桥（browser-ipc-bridge 同型第三例，spec §7/§8）：
// 真实 LspManager 只活在主进程，子进程经 fork IPC 往返。
// 错误路径铁律照抄：ok:false → Error(message)；超时 reject 中文 + 清 pending；
// process.send 缺失立即 reject。
import { randomUUID } from 'node:crypto';

const TIMEOUT_MESSAGE = 'LSP IPC 无响应（主进程未接线或超时）';
const NO_SEND_MESSAGE = 'LSP IPC 不可用（process.send 缺失：非 fork 子进程环境）';

/** 冷启动联动：gopls/clangd 首调 30s+ 诊断计算，桥超时必须远大于之 */
export const LSP_OP_BRIDGE_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingEntry>();

export function sendLspOp(op: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error(NO_SEND_MESSAGE));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(TIMEOUT_MESSAGE));
    }, LSP_OP_BRIDGE_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    try {
      process.send({ type: 'lsp:op', requestId, op });
    } catch (err) {
      const e = pending.get(requestId);
      if (e) { clearTimeout(e.timer); pending.delete(requestId); }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function handleLspOpResult(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string; requestId?: string; ok?: boolean; result?: string; error?: string };
  if (m.type !== 'lsp:op-result' || typeof m.requestId !== 'string') return;
  const entry = pending.get(m.requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(m.requestId);
  if (m.ok) entry.resolve(m.result ?? '');
  else entry.reject(new Error(m.error ?? 'LSP 调用失败'));
}

/** 测试钩子：注册伪 pending 拿 requestId */
export async function __testRegisterPending(
  resolve: (s: string) => void,
  reject: (e: Error) => void,
): Promise<string> {
  const requestId = randomUUID();
  const timer = setTimeout(() => pending.delete(requestId), 5_000);
  pending.set(requestId, { resolve, reject, timer });
  return requestId;
}
```

(2) `lsp-tools.ts` 重写为薄客户端——**删除**：`LspManager` 类、`managers` Map、`ensureManager`、`getLspManager`、`shutdownLspManager`、`shutdownAllLspManagers`、`shouldRegister` 及全部迁移走的 helper/类型/常量。**保留/改为**：

```typescript
// electron/src/main/agent/tools/lsp-tools.ts
// 薄客户端（spec §8）：门控 = AGENT_CONFIG.lspLanguages 快照非空；
// execute 经 lsp-ipc-bridge 往返主进程（语言由主进程按扩展名路由）。
import type { LLMToolDef } from '../llm-provider';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import type { ToolContext, ToolModule } from './types';
import { sendLspOp } from './lsp-ipc-bridge';

const DIAGNOSTICS_DEF: LLMToolDef = {
  name: 'lsp_diagnostics',
  description:
    '获取代码文件的诊断信息（编译错误/类型警告）。支持 16 门语言（按 workspace 自动检测激活，部分实验性），server 需已安装。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对 workspace 的源码文件路径' } },
    required: ['path'],
  },
};

const REFERENCES_DEF: LLMToolDef = {
  name: 'lsp_find_references',
  description:
    '查找某符号在 workspace 内的所有引用位置（含定义，语义级精度高于 grep）。支持 16 门语言（自动检测激活），server 需已安装。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的源码文件路径' },
      line: { type: 'number', description: '1-based 行号' },
      character: { type: 'number', description: '0-based 列号' },
    },
    required: ['path', 'line', 'character'],
  },
};

const LSP_CATALOG_META: Record<string, ToolMeta> = {
  lsp_diagnostics: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '按 workspace toolchain 自动检测激活（16 门语言，4 门实验性）；server 需已安装',
  },
  lsp_find_references: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '按 workspace toolchain 自动检测激活（16 门语言，4 门实验性）；server 需已安装',
  },
};

export const LSP_CATALOG_ENTRIES: ToolCatalogEntry[] = buildCatalog(
  [DIAGNOSTICS_DEF, REFERENCES_DEF],
  LSP_CATALOG_META,
);

export class LspTools implements ToolModule {
  private constructor() {}

  /** 门控：检测快照非空（主进程 spawn 时注入；缺省 = 不注册，向后兼容） */
  static create(ctx: ToolContext): LspTools | null {
    if (ctx.lspLanguages === undefined || ctx.lspLanguages.length === 0) return null;
    return new LspTools();
  }

  getDefs(): LLMToolDef[] { return [DIAGNOSTICS_DEF, REFERENCES_DEF]; }
  getCatalog(): ToolCatalogEntry[] { return LSP_CATALOG_ENTRIES; }
  handles(name: string): boolean {
    return name === 'lsp_diagnostics' || name === 'lsp_find_references';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'lsp_diagnostics') {
      const path = typeof args.path === 'string' ? args.path : '';
      ctx.wsFs.assertInWorkspace(path);
      const content = await import('node:fs').then((fs) => fs.promises.readFile(
        ctx.wsFs.assertInWorkspace(path), 'utf-8'));
      return sendLspOp({ kind: 'diagnostics', workspaceId: ctx.workspaceId, path, content });
    }
    if (name === 'lsp_find_references') {
      const path = typeof args.path === 'string' ? args.path : '';
      ctx.wsFs.assertInWorkspace(path);
      const line = typeof args.line === 'number' ? args.line : 1;
      const character = typeof args.character === 'number' ? args.character : 0;
      return sendLspOp({ kind: 'references', workspaceId: ctx.workspaceId, path, line, character });
    }
    throw new Error(`未知 lsp 工具: ${name}`);
  }
}
```

(3) `runtime-config.ts`：`AgentRuntimeOpts` 与 `RuntimeConfig` 各加

```typescript
  /** 多语言 LSP 检测快照（spawn 时主进程注入；缺省 = 不注册 LSP 工具） */
  lspLanguages?: string[];
```

（`RuntimeConfig` 侧 parseConfig 归一 `lspLanguages: Array.isArray(raw.lspLanguages) ? raw.lspLanguages.filter((x) => typeof x === 'string') : []`。）

(4) `tools/types.ts` ToolContext 加 `lspLanguages?: string[];`（注释：主进程检测快照透传）。

(5) `runtime-entry.ts` buildToolRegistry 调用处 ctx 加 `lspLanguages: config.lspLanguages`；taskMessageListener（browser-op-result 分发同型位）加：

```typescript
    handleLspOpResult(msg);
```

(6) `spawn-helpers.ts` buildSpawnOpts（allowedTools 注入位 ~:381 邻近）加：

```typescript
    // 多语言 LSP 检测快照（spec §7）：主进程单点检测，子进程只消费
    lspLanguages: activeLanguageIds(detectWorkspaceLanguages(opts.workspaceId, opts.workspaceDir)),
```

（import from '../lsp/detect'；`opts.workspaceDir` 为 buildSpawnOpts 既有字段——实现时按实际变量名对齐。）

- [ ] **Step 4: 跑绿 + 邻域 + typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/lsp-tools.test.ts tests/agent/tools/catalog-selfdescribe.test.ts tests/lsp/
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools-catalog.test.ts tests/agent/tools/tools-catalog-v2.3.test.ts
npx pnpm@9.0.0 typecheck
```

（既有消费 `lsp-tools` 导出的测试若有 `getLspManager`/`shouldRegister` 引用（如 lsp-tools.test 旧文——已重写），grep 确认零残留：`grep -rn "shouldRegister\|shutdownLspManager" electron/src electron/tests`。）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/lsp-tools.ts electron/src/main/agent/tools/lsp-ipc-bridge.ts electron/src/main/agent/runtime-entry.ts electron/src/main/agent/runtime-config.ts electron/src/main/agent/tools/types.ts electron/src/main/agent/spawn-helpers.ts electron/tests/
git commit -m "refactor: lsp-tools 切薄 IPC 客户端，AGENT_CONFIG 透传检测快照"
```

---

### Task 6: renderer「语言服务」面板

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（LanguageStatus 镜像 + lsp invoke 组）
- Modify: `electron/src/preload/index.ts`（lsp 桥接）
- Create: `renderer/src/components/settings/LanguageServicesPanel.tsx` + `.test.tsx`
- Modify: 设置页挂载（实现时 grep `GitPolicySettings` 的挂载点，同位挂 LanguageServicesPanel，workspaceId 同源）

**Interfaces:**
- Consumes: invoke `lsp:status(workspaceId)` / `lsp:redetect(workspaceId)`（Task 4）
- Produces: `<LanguageServicesPanel workspaceId={string} />`

- [ ] **Step 0: 预览门禁（momo-ui-preview-rules，P1 新交互面）**

**此步由控制器执行（子代理不与用户交互）**：向用户呈现 spec §10 线框（三态行 + 实验徽标 + installHint + 重新检测按钮），获确认后放行本任务 dispatch。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/settings/LanguageServicesPanel.test.tsx
// 面板契约：三态渲染 / 实验徽标 / installHint 展示与复制 / 重新检测交互 / 加载与错误态。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguageServicesPanel } from './LanguageServicesPanel';
import { ipc } from '../../ipc/client';

vi.mock('../../ipc/client', () => ({
  ipc: {
    lsp: {
      status: vi.fn(),
      redetect: vi.fn(),
    },
  },
}));

const STATUSES = [
  { languageId: 'typescript', label: 'TypeScript / JavaScript', tier: 'verified', toolchain: true, binary: true, running: 'idle', installHint: 'npm i -g typescript-language-server' },
  { languageId: 'go', label: 'Go', tier: 'verified', toolchain: true, binary: true, running: 'running', installHint: 'go install ...' },
  { languageId: 'python', label: 'Python', tier: 'verified', toolchain: true, binary: false, running: 'stopped', installHint: 'pip install pyright' },
  { languageId: 'java', label: 'Java', tier: 'experimental', toolchain: true, binary: false, running: 'stopped', installHint: 'brew install jdtls' },
  { languageId: 'rust', label: 'Rust', tier: 'verified', toolchain: false, binary: false, running: 'stopped', installHint: 'rustup ...' },
];

describe('LanguageServicesPanel', () => {
  it('渲染三态：ready（含运行态）/ missing-binary（含引导）/ inactive', async () => {
    vi.mocked(ipc.lsp.status).mockResolvedValue(STATUSES as never);
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    expect(await screen.findByText('TypeScript / JavaScript')).toBeTruthy();
    expect(screen.getByText('闲置')).toBeTruthy();       // ts: idle
    expect(screen.getByText('运行中')).toBeTruthy();     // go: running
    expect(screen.getByText(/缺少 pyright|未安装/)).toBeTruthy(); // python 引导
    expect(screen.getByText('未检测到工程标志')).toBeTruthy();     // rust inactive
  });

  it('实验性徽标只出现在 experimental 行', async () => {
    vi.mocked(ipc.lsp.status).mockResolvedValue(STATUSES as never);
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    await screen.findByText('Java');
    expect(screen.getAllByText('实验').length).toBe(1);
  });

  it('重新检测调用 redetect 并刷新列表', async () => {
    vi.mocked(ipc.lsp.status).mockResolvedValue(STATUSES as never);
    vi.mocked(ipc.lsp.redetect).mockResolvedValue(STATUSES.slice(0, 2) as never);
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    await screen.findByText('Java');
    await userEvent.click(screen.getByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(ipc.lsp.redetect).toHaveBeenCalledWith('ws-1'));
    await waitFor(() => expect(screen.queryByText('Java')).toBeNull());
  });

  it('status 失败 → 错误提示不崩（Review Focus：IPC 失败不阻塞设置页其余部分）', async () => {
    vi.mocked(ipc.lsp.status).mockRejectedValue(new Error('boom'));
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    expect(await screen.findByText(/加载失败/)).toBeTruthy();
    void fireEvent;
  });
});
```

- [ ] **Step 2: 跑红**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/LanguageServicesPanel.test.tsx
```

- [ ] **Step 3: 实现契约 + 组件 + 挂载**

(a) `types.d.ts` 加镜像（tools 组旁）：

```typescript
/** LSP 语言状态（lsp:status 返回项；electron 侧 detect.ts 的镜像契约） */
export interface LanguageStatus {
  languageId: string;
  label: string;
  tier: 'verified' | 'experimental';
  toolchain: boolean;
  binary: boolean;
  running: 'running' | 'idle' | 'stopped';
  installHint: string;
}
```

api 对象类型加组：

```typescript
    lsp: {
      status(workspaceId: string): Promise<LanguageStatus[]>;
      redetect(workspaceId: string): Promise<LanguageStatus[]>;
    };
```

(b) preload 加桥（tools 组旁）：`lsp: { status: (workspaceId: string) => invoke('lsp:status', workspaceId), redetect: (workspaceId: string) => invoke('lsp:redetect', workspaceId) }`

(c) 组件骨架（语义 token only；图标 lucide：`RefreshCw`/`Check`/`X`/`Circle`）：

```tsx
export function LanguageServicesPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [statuses, setStatuses] = useState<LanguageStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (fn: typeof ipc.lsp.status) => {
    setBusy(true); setError(null);
    try { setStatuses(await fn(workspaceId)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [workspaceId]);
  useEffect(() => { void load(ipc.lsp.status); }, [load]);
  // 渲染：标题行（「语言服务」+ 重新检测按钮 disabled={busy}）；
  // 行 = label + tier==='experimental' 徽标（「实验」）
  //   + toolchain ✓/✗ + binary ✓/✗ + running 映射（运行中/闲置/未启动）
  //   + toolchain && !binary → installHint 行（含复制按钮 navigator.clipboard）
  //   + !toolchain → 「未检测到工程标志」灰显
  // error → 「加载失败：{error}」text-status-error；statuses null && !error → 加载中
}
```

（完整 JSX 按上述语义实现——每行一个 `<div className="flex items-center gap-2 ...">`；状态色用语义类。）

(d) 挂载：grep `GitPolicySettings` 引用处，同位同型挂 `<LanguageServicesPanel workspaceId={...} />`（workspaceId 与 GitPolicySettings 同源 prop）。

- [ ] **Step 4: 跑绿 + renderer 全量 + 双 typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/LanguageServicesPanel.test.tsx
cd renderer && npx pnpm@9.0.0 vitest run src/
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src electron/src/preload/index.ts
git commit -m "feat: 设置页「语言服务」面板（检测三态 + 安装引导 + 重新检测）"
```

---

### Task 7: 冒烟 + 全局验证 + 账本

**Files:**
- Create: `electron/tests/lsp/smoke.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: 全部前序产出
- Produces: 验收记录

- [ ] **Step 1: skip-if-missing 冒烟测试**

```typescript
// electron/tests/lsp/smoke.test.ts
// 多语言真实 server 冒烟（skip-if-binary-missing）：tsserver / gopls / pyright
// 各一条 diagnostics 往返。冷启动慢——每用例 60s 超时。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureLspManager, shutdownAllLspManagers } from '../../src/main/lsp/manager';
import { REGISTRY, findBinaryInPath } from '../../src/main/lsp/registry';

const SMOKE: Array<{ languageId: string; file: string; content: string; expectDiags: boolean }> = [
  {
    languageId: 'typescript',
    file: 'a.ts', expectDiags: true,
    content: 'const x: number = "bad";\n',
  },
  {
    languageId: 'python',
    file: 'a.py', expectDiags: true,
    content: 'def f() -> int:\n    return "bad"\n',
  },
  {
    languageId: 'go',
    file: 'go.mod', expectDiags: false, // go.mod 无诊断——用 main.go 建 marker
    content: '',
  },
];

beforeEach(async () => { await shutdownAllLspManagers(); });
afterEach(async () => { await shutdownAllLspManagers(); });

for (const caseItem of SMOKE) {
  const spec = REGISTRY.find((s) => s.languageId === caseItem.languageId)!;
  const hasBin = findBinaryInPath(spec.binaries) !== null;
  describe.skipIf(!hasBin)(`${caseItem.languageId} 真实冒烟`, () => {
    it('diagnostics 往返', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ap-lsp-smoke-${caseItem.languageId}-`));
      try {
        if (caseItem.languageId === 'go') {
          fs.writeFileSync(path.join(tmp, 'go.mod'), 'module smoke\n\ngo 1.21\n');
          fs.writeFileSync(path.join(tmp, 'main.go'), 'package main\n\nfunc main() { var x int = "bad"; _ = x }\n');
        } else {
          fs.writeFileSync(path.join(tmp, caseItem.file), caseItem.content);
          if (caseItem.languageId === 'typescript') fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
        }
        const target = caseItem.languageId === 'go' ? path.join(tmp, 'main.go') : path.join(tmp, caseItem.file);
        const mgr = await ensureLspManager(`smoke-${caseItem.languageId}`, tmp, spec);
        const diags = await mgr.getDiagnostics(target, fs.readFileSync(target, 'utf-8'));
        if (caseItem.languageId === 'go') expect(diags.length).toBeGreaterThan(0);
        else expect(diags.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
```

- [ ] **Step 2: 全局验证**

```bash
npx pnpm@9.0.0 typecheck
cd electron && npx pnpm@9.0.0 vitest run tests/lsp/ tests/agent/tools/ tests/agent/tools-catalog.test.ts
cd renderer && npx pnpm@9.0.0 vitest run src/
grep -rn "shouldRegister\|shutdownLspManager\|getLspManager" electron/src/main/agent/tools/lsp-tools.ts
```

预期：typecheck 双过；测试零新增失败（基线 16 口径）；最后 grep 无输出（旧实现清零）。

- [ ] **Step 3: 手动验收（控制器移交用户，子代理不执行 GUI）**

dev 模式清单：① 设置页「语言服务」面板三态正确（test workspace 应显示 TS/Go ready 或 missing-binary + 引导）；② 该 workspace 新会话 agent 自报含 `lsp_diagnostics`/`lsp_find_references`；③ 实调两工具往返成功；④ 面板「重新检测」刷新。

- [ ] **Step 4: CHANGELOG 账本**

按既有 alpha 小节格式追加：

```markdown
- **多语言 LSP 子系统**：LSP 工具多语言化（16 门语言注册表——验证层 12 + 实验层 4）；LspManager 迁移主进程 per (workspace × language) 单例（修复每任务冷启动 + 每 workspace 并发上限 3）；检测单一真相源（toolchain markers 根+一层子目录 glob，修复分体/monorepo 判据盲区；二进制 PATH 探测）；AGENT_CONFIG.lspLanguages 快照注入；lsp:op IPC 桥 + 设置页「语言服务」面板（三态 + 安装引导 + 重新检测）。spec：`docs/specs/2026-10-01-multi-language-lsp-subsystem.md`
```

（不动版本号。）

- [ ] **Step 5: Commit**

```bash
git add electron/tests/lsp/smoke.test.ts CHANGELOG.md
git commit -m "test: 多语言 LSP 真实 server 冒烟 + 研发账本"
```

---

## 任务依赖关系

- Task 1 → Task 2 → {Task 3, Task 4} → Task 5 → Task 6 → Task 7
- Task 3 与 Task 4 在 Task 2 后可并行（Task 4 消费 Task 3 的 manager——严格序：3 先于 4；如并行执行需以 3 完成为前置）
- Task 6 的 Step 0 预览门禁由控制器在 dispatch Task 6 前向用户执行
