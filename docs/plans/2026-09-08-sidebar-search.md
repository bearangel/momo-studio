# 侧边栏搜索（会话 / 文件 / 看板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 im / files / tasks 三个侧边栏视图各加一个内嵌搜索框——会话按标题、看板按标题+描述做 renderer 内存过滤；文件走新增 `file:searchNames` IPC 由主进程递归扫描文件名。

**Architecture:** 方案 B（spec §1.1）——每个域用最便宜的可用数据源：会话/任务数据已在 renderer store 内存，纯前端过滤；文件树懒加载缓存不完整，新增一条主进程 IPC（`WorkspaceFS.searchNames` 递归 readdir，双上限防病态目录）。零索引、零迁移、零新表。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3 无关，纯 fs）、React + zustand renderer、Vitest 双 workspace。

**Spec:** `docs/specs/2026-09-08-sidebar-search-design.md`（本计划的唯一上游依据）

## Global Constraints

- **Node 20**：容器默认 Node 26 会破坏 better-sqlite3。所有命令前先 `nvm use 20`；pnpm 一律 `npx pnpm@9.0.0`。
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`；`noUncheckedIndexedAccess` 开启（数组/Map 索引访问需非空断言或防御）。
- **注释与文档全中文**；代码标识符英文。
- **UI 设计系统（v2.1）**：renderer 只用语义 token（`bg-surface-*` / `text-secondary` / `text-tertiary` / `border-subtle` 等）；图标一律 lucide-react，size 16 或 14（与所在工具条既有图标一致）、stroke 1.75；禁 emoji 图标、禁硬编码颜色。
- **单测位置**：electron 主进程测试集中 `electron/tests/`（子目录镜像 `src/`）；renderer 测试贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录）。
- **IPC 契约**（momo-boundary-rules）：改 `renderer/src/ipc/types.d.ts` 必须同步 `electron/src/preload/index.ts` 与主进程 handler；**两个 workspace 都要 typecheck**。
- **测试保真**（momo-test-rules）：只 mock IPC/进程边界（`window.api` / `ipcMain`），业务逻辑用真实实现；错误路径与空输入必须有专项用例。
- **匹配规则统一**：两端 `toLowerCase()` 后子串包含；空输入（含 trim 后）= 不过滤。

---

### Task 1: WorkspaceFS.searchNames（主进程递归文件名搜索）

**Files:**
- Modify: `electron/src/main/files/workspace-fs.ts`（类内新增方法 + 模块级 `SearchHit` 接口与常量）
- Test: `electron/tests/files/workspace-fs-search.test.ts`（新建，镜像 src 结构）

**Interfaces:**
- Produces: `searchNames(query: string, limit?: number, traversalCap?: number): Promise<SearchHit[]>`；`SearchHit { path: string; isDirectory: boolean }`（Task 2 的 IPC handler 与 Task 3 的 renderer 均依赖此形状；path 为相对 workspace 根、`/` 分隔的含目录前缀全路径）

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/files/workspace-fs-search.test.ts`：

```ts
// electron/tests/files/workspace-fs-search.test.ts
//
// WorkspaceFS.searchNames 专项测试（spec §5.1 / §7.1）：
// 递归文件名搜索——嵌套命中、大小写、子串、目录命中、.git*/node_modules
// 排除（与 listDir 一致）、符号链接目录不进入、双上限、空 query。
// 全部用真实临时目录 + 真实 fs（无 mock，momo-test-rules 第 5 条）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmpRoot = path.join(os.tmpdir(), `ap-fs-search-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在 workspace 内写文件（自动建父目录） */
function put(rel: string, content = ''): void {
  const abs = path.join(wsFs['rootDir'], rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('files/workspace-fs searchNames', () => {
  it('空 query 返回 []', async () => {
    put('a.ts');
    await expect(wsFs.searchNames('')).resolves.toEqual([]);
    await expect(wsFs.searchNames('   ')).resolves.toEqual([]);
  });

  it('嵌套目录中的文件按名命中，path 含目录前缀（/ 分隔）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('foo')).resolves.toEqual([
      { path: 'src/foo.ts', isDirectory: false },
    ]);
  });

  it('大小写不敏感（query 大写命中小写文件名）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('FOO')).resolves.toEqual([
      { path: 'src/foo.ts', isDirectory: false },
    ]);
  });

  it('子串包含（非前缀匹配）', async () => {
    put('docs/nested/deep_note.md');
    await expect(wsFs.searchNames('note')).resolves.toEqual([
      { path: 'docs/nested/deep_note.md', isDirectory: false },
    ]);
  });

  it('目录名命中返回 isDirectory: true（目录本身参与匹配）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('src')).resolves.toEqual([
      { path: 'src', isDirectory: true },
    ]);
  });

  it('.git* 前缀条目不进入不返回（与 listDir 过滤一致）', async () => {
    put('.git/config');
    put('.gitignore');
    put('regular.ts');
    await expect(wsFs.searchNames('git')).resolves.toEqual([]);
    await expect(wsFs.searchNames('regular')).resolves.toEqual([
      { path: 'regular.ts', isDirectory: false },
    ]);
  });

  it('node_modules 不进入', async () => {
    put('node_modules/pkg/index.js');
    put('app.js');
    await expect(wsFs.searchNames('index')).resolves.toEqual([]);
    await expect(wsFs.searchNames('app')).resolves.toEqual([
      { path: 'app.js', isDirectory: false },
    ]);
  });

  it('符号链接目录不递归进入（防环防逃逸），符号链接文件按普通条目匹配', async () => {
    put('real/target.txt');
    // 符号链接目录：指向 workspace 根（若进入会无限递归）
    fs.symlinkSync(wsFs['rootDir'], path.join(wsFs['rootDir'], 'loopdir'), 'dir');
    // 符号链接文件：指向已有文件
    fs.symlinkSync(
      path.join(wsFs['rootDir'], 'real/target.txt'),
      path.join(wsFs['rootDir'], 'link.txt'),
      'file',
    );
    const hits = await wsFs.searchNames('target');
    // real/target.txt 命中一次；loopdir 不进入（否则 target.txt 会被重复收集）
    await expect(hits).toEqual([{ path: 'real/target.txt', isDirectory: false }]);
    const linkHits = await wsFs.searchNames('link');
    await expect(linkHits).toEqual([{ path: 'link.txt', isDirectory: false }]);
  });

  it('limit 截断：命中数超过 limit 时只返回前 limit 条', async () => {
    for (let i = 0; i < 5; i++) put(`match${i}.ts`);
    const hits = await wsFs.searchNames('match', 3);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.path.startsWith('match'))).toBe(true);
  });

  it('遍历条目总数上限触发时安全返回已有结果（不依赖 readdir 顺序）', async () => {
    put('match1.ts');
    put('match2.ts');
    // traversalCap=1：只看第一个条目 → 恰好 1 条命中（无论先看到哪个）
    const hits = await wsFs.searchNames('match', 200, 1);
    expect(hits).toHaveLength(1);
    // traversalCap=2：两个条目都看到 → 2 条
    const hits2 = await wsFs.searchNames('match', 200, 2);
    expect(hits2).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-search.test.ts
```

Expected: FAIL——`wsFs.searchNames is not a function`（TS 编译期也会报属性不存在，vitest 以运行时错误形式呈现）。

- [ ] **Step 3: 实现 searchNames**

`electron/src/main/files/workspace-fs.ts`：在 `DirEntry` 接口下方加接口与常量，在 `WorkspaceFS` 类内（`listDir` 方法后）加方法。

```ts
/** 文件名搜索命中项（file:searchNames 返回行） */
export interface SearchHit {
  /** 相对 workspace 根的全路径（含目录前缀，'/' 分隔） */
  path: string;
  isDirectory: boolean;
}

/** searchNames 默认结果上限（spec §5.1） */
const SEARCH_LIMIT_DEFAULT = 200;
/** searchNames 遍历条目总数上限（防病态深目录拖死主进程，spec §5.1） */
const SEARCH_TRAVERSAL_CAP_DEFAULT = 10_000;
```

类内方法：

```ts
  /**
   * 递归文件名搜索（spec §5.1）：从 workspace 根遍历，条目名（basename）
   * 大小写不敏感子串匹配；.git* 前缀与 node_modules 条目排除（与 listDir
   * 一致）；符号链接目录不进入（Dirent.isDirectory 对 symlink 为 false，
   * 天然防环）。双上限：结果 limit + 遍历总数 traversalCap。
   */
  async searchNames(
    query: string,
    limit: number = SEARCH_LIMIT_DEFAULT,
    traversalCap: number = SEARCH_TRAVERSAL_CAP_DEFAULT,
  ): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const hits: SearchHit[] = [];
    let visited = 0;
    const walk = async (relDir: string): Promise<void> => {
      const abs = relDir === '.' ? this.rootDir : this.assertInWorkspace(relDir);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (hits.length >= limit || visited >= traversalCap) return;
        const lower = e.name.toLowerCase();
        if (lower.startsWith('.git') || lower === 'node_modules') continue;
        // 相对路径统一 '/' 分隔（与 file.store 路径拼接约定一致，跨平台稳定）
        const rel = relDir === '.' ? e.name : `${relDir}/${e.name}`;
        visited++;
        if (lower.includes(q)) {
          hits.push({ path: rel, isDirectory: e.isDirectory() });
        }
        if (e.isDirectory()) {
          await walk(rel);
        }
      }
    };
    await walk('.');
    return hits;
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs-search.test.ts
```

Expected: PASS（10 个用例全绿）。

- [ ] **Step 5: 全量回归 + typecheck（electron 侧）**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/
cd /workspace && npx pnpm@9.0.0 --filter momo-studio-electron typecheck || npx pnpm@9.0.0 typecheck
```

（若根 typecheck 脚本包含双 workspace，直接跑根命令即可。）Expected: files 目录全部测试绿 + typecheck clean。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/files/workspace-fs.ts electron/tests/files/workspace-fs-search.test.ts
git commit -m "feat: add WorkspaceFS.searchNames recursive filename search"
```

---

### Task 2: file:searchNames IPC 契约（handler + preload + types）

**Files:**
- Modify: `electron/src/main/files/ipc.handlers.ts`（注册新通道）
- Modify: `renderer/src/ipc/types.d.ts`（`file` 命名空间加方法 + `SearchHit` 接口）
- Modify: `electron/src/preload/index.ts`（file 段加绑定）
- Test: `electron/tests/files/ipc.handlers.test.ts`（扩展 mock 与用例）

**Interfaces:**
- Consumes: Task 1 的 `WorkspaceFS.searchNames(query)`（handler 只透传，不改写）
- Produces: `window.api.file.searchNames(workspaceId: string, query: string): Promise<SearchHit[]>`（Task 3 的 FileTree 依赖）；renderer 侧 `SearchHit` 类型（`renderer/src/ipc/types.d.ts`）

- [ ] **Step 1: 写失败测试（扩展 ipc.handlers.test.ts）**

`electron/tests/files/ipc.handlers.test.ts` 三处修改：

(a) `vi.hoisted` 块加 `mockSearchNames`：

```ts
const { ipcHandlers, mockReadFile, mockWriteFile, mockListDir, mockSearchNames, getWorkspaceMock } =
  vi.hoisted(() => {
    const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    return {
      ipcHandlers,
      mockReadFile: vi.fn(),
      mockWriteFile: vi.fn(),
      mockListDir: vi.fn(),
      mockSearchNames: vi.fn(),
      getWorkspaceMock: vi.fn(),
    };
  });
```

(b) `vi.mock('../../src/main/files/workspace-fs')` 工厂的实例加一行：

```ts
vi.mock('../../src/main/files/workspace-fs', () => ({
  WorkspaceFS: vi.fn().mockImplementation(() => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    listDir: mockListDir,
    searchNames: mockSearchNames,
  })),
}));
```

(c) `beforeEach` 内加 `mockSearchNames.mockReset();`，文件末尾追加 describe：

```ts
describe('files/ipc.handlers file:searchNames', () => {
  it('注册 file:searchNames 通道', () => {
    expect(ipcHandlers.has('file:searchNames')).toBe(true);
  });

  it('透传 workspaceId 定位 workspace，query 原样交给 searchNames，结果直返', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockSearchNames.mockResolvedValue([{ path: 'src/foo.ts', isDirectory: false }]);
    const handler = ipcHandlers.get('file:searchNames')!;
    const result = (await handler(undefined, 'ws-1', 'foo')) as unknown;
    expect(mockSearchNames).toHaveBeenCalledWith('foo');
    expect(result).toEqual([{ path: 'src/foo.ts', isDirectory: false }]);
  });

  it('searchNames 抛错时错误沿 IPC 传播（reject）', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockSearchNames.mockRejectedValue(new Error('boom'));
    const handler = ipcHandlers.get('file:searchNames')!;
    await expect(handler(undefined, 'ws-1', 'x')).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/ipc.handlers.test.ts
```

Expected: FAIL——`ipcHandlers.has('file:searchNames')` 为 false（通道未注册）。

- [ ] **Step 3: 实现三端契约**

(a) `electron/src/main/files/ipc.handlers.ts`——`file:rename` handler 之后加：

```ts
  // 文件名搜索（侧边栏搜索，spec §5.1）：query 由 renderer 保证 trim 非空才调用；
  // 主进程仍对空串返回 [] 短路（纵深防御）
  ipcMain.handle(
    'file:searchNames',
    async (_evt, workspaceId: string, query: string) => {
      const wsFs = getWorkspaceFs(workspaceId);
      return wsFs.searchNames(query);
    },
  );
```

(b) `renderer/src/ipc/types.d.ts`——`file` 块（约 853-860 行）加方法：

```ts
  file: {
    read(workspaceId: string, filePath: string): Promise<string>;
    write(workspaceId: string, filePath: string, content: string): Promise<void>;
    list(workspaceId: string, dirPath: string): Promise<DirEntry[]>;
    create(workspaceId: string, filePath: string, type: 'file' | 'dir'): Promise<void>;
    delete(workspaceId: string, filePath: string): Promise<void>;
    rename(workspaceId: string, srcPath: string, dstPath: string): Promise<void>;
    /** 文件名搜索（侧边栏搜索，spec §5.1）：主进程递归扫描，返回相对路径命中项 */
    searchNames(workspaceId: string, query: string): Promise<SearchHit[]>;
  };
```

并在 `DirEntry` 接口（约 1117 行附近）旁加 renderer 镜像类型：

```ts
/**
 * 文件名搜索命中项（侧边栏搜索）。
 * 与 electron 端 workspace-fs.ts 的 SearchHit 对齐（跨进程独立定义，仅结构对齐）。
 */
export interface SearchHit {
  /** 相对 workspace 根的全路径（含目录前缀，'/' 分隔） */
  path: string;
  isDirectory: boolean;
}
```

(c) `electron/src/preload/index.ts`——`file` 段（42-49 行）加一行：

```ts
    searchNames: (wsId, query) => invoke('file:searchNames', wsId, query),
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/ipc.handlers.test.ts
```

Expected: PASS。

- [ ] **Step 5: 双 workspace typecheck（momo-boundary-rules 强制）**

```bash
cd /workspace && nvm use 20 && npx pnpm@9.0.0 typecheck
```

Expected: electron + renderer 双 clean（preload 三层 `../../../` 引用 renderer 类型，此处验证契约对齐）。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/files/ipc.handlers.ts renderer/src/ipc/types.d.ts electron/src/preload/index.ts electron/tests/files/ipc.handlers.test.ts
git commit -m "feat: add file:searchNames IPC channel (handler + preload + types)"
```

---

### Task 3: FileTree 搜索框 + 扁平结果列表（renderer 文件搜索）

**Files:**
- Modify: `renderer/src/components/files/FileTree.tsx`
- Test: `renderer/src/components/files/FileTree.test.tsx`（扩展）

**Interfaces:**
- Consumes: Task 2 的 `ipc.file.searchNames(workspaceId, query): Promise<SearchHit[]>`；既有 `onSelectFile: (filePath: string) => void` prop
- Produces: 无对外新接口（纯 UI 行为；搜索态为组件本地瞬态）

- [ ] **Step 1: 写失败测试（扩展 FileTree.test.tsx）**

(a) `mockApi.file` 对象加成员：

```ts
const mockApi = {
  file: {
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(ROOT_ENTRIES),
    read: vi.fn(),
    write: vi.fn(),
    searchNames: vi.fn().mockResolvedValue([]),
  },
};
```

(b) `beforeEach` 末尾加 `mockApi.file.searchNames.mockClear(); mockApi.file.searchNames.mockResolvedValue([]);`

(c) 文件顶部 import 改为含 `act`：`import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';`，并从 vitest import 补 `afterEach`。

(d) 文件末尾追加 describe：

```ts
describe('FileTree 文件名搜索', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('输入关键词 → 防抖 200ms 后调 file.searchNames 并渲染结果（含父目录小字）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'src/found.ts', isDirectory: false }]);
    render(<FileTree onSelectFile={() => {}} />);
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'found' } });
    // 防抖窗口内不发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockApi.file.searchNames).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mockApi.file.searchNames).toHaveBeenCalledWith('ws-1', 'found');
    expect(screen.getByText('found.ts')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('无结果 → 「无匹配文件」空态', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([]);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('无匹配文件')).toBeInTheDocument();
  });

  it('点击文件行 → onSelectFile(相对路径)；目录行不可点击', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([
      { path: 'docs', isDirectory: true },
      { path: 'src/found.ts', isDirectory: false },
    ]);
    const onSelect = vi.fn();
    render(<FileTree onSelectFile={onSelect} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'found' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.click(screen.getByText('found.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/found.ts');
    expect(onSelect).not.toHaveBeenCalledWith('docs');
  });

  it('清除搜索 → 恢复树视图（搜索结果消失、不再发 IPC）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockResolvedValue([{ path: 'search-hit.ts', isDirectory: false }]);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'hit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('search-hit.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('清除搜索'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('search-hit.ts')).not.toBeInTheDocument();
    expect(mockApi.file.searchNames).toHaveBeenCalledTimes(1);
  });

  it('搜索失败 → 错误文案（text-status-error 行）', async () => {
    vi.useFakeTimers();
    mockApi.file.searchNames.mockRejectedValue(new Error('boom'));
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'x' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('搜索失败：boom')).toBeInTheDocument();
  });

  it('旧响应不覆盖新结果（竞态守卫）', async () => {
    vi.useFakeTimers();
    let resolveStale!: (v: { path: string; isDirectory: boolean }[]) => void;
    const stalePromise = new Promise<{ path: string; isDirectory: boolean }[]>((res) => {
      resolveStale = res;
    });
    mockApi.file.searchNames
      .mockImplementationOnce(() => stalePromise)
      .mockImplementationOnce(() => Promise.resolve([{ path: 'fresh.ts', isDirectory: false }]));
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'q1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'q2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // 旧响应后到：不得覆盖 q2 的结果
    resolveStale([{ path: 'stale.ts', isDirectory: false }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('stale.ts')).not.toBeInTheDocument();
    expect(screen.getByText('fresh.ts')).toBeInTheDocument();
  });

  it('结果达 200 条上限 → 显示截断提示', async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: 200 }, (_, i) => ({
      path: `hit${i}.ts`,
      isDirectory: false,
    }));
    mockApi.file.searchNames.mockResolvedValue(many);
    render(<FileTree onSelectFile={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索文件'), { target: { value: 'hit' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('已显示前 200 条匹配')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileTree.test.tsx
```

Expected: FAIL——`getByLabelText('搜索文件')` 找不到元素（搜索框未实现）。

- [ ] **Step 3: 实现 FileTree 搜索**

`renderer/src/components/files/FileTree.tsx` 全量改动（新 import、搜索态、useEffect、主体切换）。关键代码：

```tsx
import { useState, useEffect, useRef } from 'react';
import { RefreshCw, FilePlus, FolderPlus, Search, X, FileText, Folder } from 'lucide-react';
// ...既有 import 不变，追加：
import { ipc } from '../../ipc/client';
import type { SearchHit } from '../../ipc/types';

/** 搜索防抖间隔（毫秒） */
const SEARCH_DEBOUNCE_MS = 200;
/** 与主进程 WorkspaceFS.searchNames 默认 limit 对齐（到达即显示截断提示） */
const SEARCH_RESULT_LIMIT = 200;
```

组件内新增（既有 store hooks / creating / emptyMenu 之后）：

```tsx
  // 搜索态（瞬态本地态，不进 store；spec §5.3）
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 竞态守卫：响应返回时序号不匹配则丢弃（旧响应不覆盖新结果）
  const seqRef = useRef(0);

  // 防抖 200ms 调 IPC；trim 后为空直接清空恢复树（不发 IPC）
  useEffect(() => {
    const trimmed = query.trim();
    if (!workspace || trimmed === '') {
      seqRef.current++;
      setResults([]);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      ipc.file
        .searchNames(workspace.id, trimmed)
        .then((hits) => {
          if (seqRef.current !== seq) return;
          setResults(hits);
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setResults([]);
          setSearchError(`搜索失败：${err instanceof Error ? err.message : String(err)}`);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, workspace]);

  const searching = query.trim() !== '';
```

工具条 div 之后、主体之前插入搜索框与错误行；主体按 `searching` 切换：

```tsx
      {/* 搜索框（spec §5.3）：query 非空时主体切换为扁平结果列表 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-subtle shrink-0">
        <Search size={14} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件"
          aria-label="搜索文件"
          className="flex-1 min-w-0 bg-transparent text-sm text-primary placeholder:text-tertiary outline-none"
        />
        {query !== '' && (
          <button
            type="button"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => setQuery('')}
            className="text-tertiary hover:text-primary shrink-0"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      {searchError && (
        <div className="px-2 py-1 text-xs text-status-error shrink-0">{searchError}</div>
      )}
      {searching ? (
        <div className="flex-1 overflow-auto px-2 py-1">
          {results.length === 0 && !searchError ? (
            <div className="flex items-center justify-center h-full text-tertiary text-sm">
              无匹配文件
            </div>
          ) : (
            <>
              {results.map((hit) => {
                const name = hit.path.slice(hit.path.lastIndexOf('/') + 1);
                const parentDir = hit.path.includes('/')
                  ? hit.path.slice(0, hit.path.lastIndexOf('/'))
                  : '';
                return hit.isDirectory ? (
                  <div
                    key={hit.path}
                    title={hit.path}
                    className="flex items-center gap-1.5 px-1 py-1 text-sm text-secondary"
                  >
                    <Folder
                      size={14}
                      strokeWidth={1.75}
                      className="text-tertiary shrink-0"
                      aria-hidden
                    />
                    <span className="truncate">{name}</span>
                    {parentDir !== '' && (
                      <span className="text-tertiary text-xs truncate">{parentDir}</span>
                    )}
                  </div>
                ) : (
                  <button
                    key={hit.path}
                    type="button"
                    title={hit.path}
                    onClick={() => onSelectFile(hit.path)}
                    className="w-full flex items-center gap-1.5 px-1 py-1 text-sm text-secondary hover:bg-surface-3 text-left"
                  >
                    <FileText
                      size={14}
                      strokeWidth={1.75}
                      className="text-tertiary shrink-0"
                      aria-hidden
                    />
                    <span className="truncate">{name}</span>
                    {parentDir !== '' && (
                      <span className="text-tertiary text-xs truncate">{parentDir}</span>
                    )}
                  </button>
                );
              })}
              {results.length >= SEARCH_RESULT_LIMIT && (
                <div className="px-1 py-1 text-xs text-tertiary">
                  已显示前 {SEARCH_RESULT_LIMIT} 条匹配
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto px-2 py-1"
          onClick={handleEmptyClick}
          onContextMenu={handleEmptyContextMenu}
        >
          <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
        </div>
      )}
      {emptyMenu && (
        <FileContextMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          isDirectory={true}
          onNewFile={() => setCreating('file')}
          onNewDir={() => setCreating('dir')}
          onClose={() => setEmptyMenu(null)}
        />
      )}
      {creating && (
        <PromptDialog
          title={creating === 'file' ? `新文件名${targetLabel}` : `新目录名${targetLabel}`}
          placeholder={creating === 'file' ? '可含子目录，如 src/foo.ts' : '如 docs'}
          onSubmit={handleCreate}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
```

（`handleRefresh` / `handleCreate` / `handleEmptyClick` / `handleEmptyContextMenu` / `targetLabel` 与原文件完全一致，不动。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileTree.test.tsx
```

Expected: PASS（新 7 用例 + 既有 5 用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/files/FileTree.tsx renderer/src/components/files/FileTree.test.tsx
git commit -m "feat: file tree sidebar search with flat result list"
```

---

### Task 4: RoomList 会话标题过滤（renderer 会话搜索）

**Files:**
- Modify: `renderer/src/components/im/RoomList.tsx`
- Test: `renderer/src/components/im/RoomList.test.tsx`（扩展）

**Interfaces:**
- Consumes: 既有 `useSessionStore.sessions`（`SessionSummary[]`，title 非空 string）
- Produces: 无对外新接口（纯 UI 行为）

- [ ] **Step 1: 写失败测试（RoomList.test.tsx 末尾追加 describe）**

```ts
describe('RoomList — 标题搜索过滤', () => {
  it('输入关键词 → 仅渲染标题命中的会话', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '需求分析' }),
      makeSession({ id: 's2', title: '日常闲聊' }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '需求' } });
    expect(screen.getByText('需求分析')).toBeInTheDocument();
    expect(screen.queryByText('日常闲聊')).not.toBeInTheDocument();
  });

  it('大小写不敏感', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: 'Release Notes' })];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'release' } });
    expect(screen.getByText('Release Notes')).toBeInTheDocument();
  });

  it('无命中 → 「无匹配会话」空态（区别于「暂无会话」）', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'zzz' } });
    expect(screen.getByText('无匹配会话')).toBeInTheDocument();
    expect(screen.queryByText('会话A')).not.toBeInTheDocument();
  });

  it('点击清除按钮 → 恢复全量列表', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '会话A' }),
      makeSession({ id: 's2', title: '会话B' }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'A' } });
    expect(screen.queryByText('会话B')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('清除搜索'));
    expect(screen.getByText('会话A')).toBeInTheDocument();
    expect(screen.getByText('会话B')).toBeInTheDocument();
  });

  it('过滤态下列表项点击 / 悬停操作不受影响', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '目标会话', members: [makeMember({ instanceId: 'i1' })] }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '目标' } });
    fireEvent.click(screen.getByText('目标会话'));
    expect(sessionState.selectSession).toHaveBeenCalledWith('s1');
    expect(screen.getByLabelText('重命名')).toBeInTheDocument();
    expect(screen.getByLabelText('解散')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RoomList.test.tsx
```

Expected: FAIL——`getByLabelText('搜索会话')` 找不到元素。

- [ ] **Step 3: 实现 RoomList 过滤**

`renderer/src/components/im/RoomList.tsx`：

(a) lucide import 追加 `Search, X`：`import { MessageSquare, Pencil, Trash2, Search, X } from 'lucide-react';`

(b) 组件内 `renaming` state 旁加：

```tsx
  // 标题搜索过滤（spec §3）：瞬态本地态；空输入 = 不过滤
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const visibleSessions =
    q === ''
      ? sessions
      : sessions.filter((s) => s.title.toLowerCase().includes(q));
```

(c) 主 return（原 `sessions.map` 的容器）重构为「搜索框 + 列表/空态」结构（loading / 空列表两个早退分支不动）：

```tsx
  return (
    <div className="w-full flex-1 min-h-0 bg-surface-1 flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-subtle shrink-0">
        <Search size={14} strokeWidth={1.75} className="text-tertiary shrink-0" aria-hidden />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索会话"
          aria-label="搜索会话"
          className="flex-1 min-w-0 bg-transparent text-sm text-primary placeholder:text-tertiary outline-none"
        />
        {filter !== '' && (
          <button
            type="button"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => setFilter('')}
            className="text-tertiary hover:text-primary shrink-0"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      {visibleSessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-tertiary">
          无匹配会话
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {visibleSessions.map((session) => (
            // 外层 group 让 group-hover 生效；悬停时叠加操作按钮
            <div key={session.id} className="group relative">
              <button
                type="button"
                onClick={() => void selectSession(session.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2 flex items-center',
                  session.id === activeSessionId
                    ? 'bg-surface-active border-transparent text-accent-600 dark:text-accent-300'
                    : 'border-transparent text-secondary hover:bg-surface-3',
                )}
              >
                <span className="truncate flex-1">{session.title}</span>
              </button>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 rounded bg-surface-1/90 px-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ sessionId: session.id, oldTitle: session.title });
                  }}
                  className="text-tertiary hover:text-primary"
                  aria-label="重命名"
                >
                  <Pencil size={12} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  title="解散"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDissolve(session.id, session.title);
                  }}
                  className="text-tertiary hover:text-status-error"
                  aria-label="解散"
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {renaming && (
        <PromptDialog
          title="重命名会话"
          defaultValue={renaming.oldTitle}
          onSubmit={submitRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RoomList.test.tsx
```

Expected: PASS（新 5 用例 + 既有 8 用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/RoomList.tsx renderer/src/components/im/RoomList.test.tsx
git commit -m "feat: session list title filter in RoomList"
```

---

### Task 5: 看板文本过滤（FilterState.text + 纯函数抽取 + TaskList.emptyText）

**Files:**
- Create: `renderer/src/components/task-board/task-filter.ts`（过滤+排序纯函数，从 TaskSidebarPanel 抽出）
- Modify: `renderer/src/components/task-board/TaskFilters.tsx`（FilterState 加 text + 文本输入框）
- Modify: `renderer/src/components/task-board/TaskSidebarPanel.tsx`（filter 初始值 + 调 applyTaskFilters + emptyText）
- Modify: `renderer/src/components/task-board/TaskList.tsx`（emptyText prop）
- Test: `renderer/src/components/task-board/task-filter.test.ts`（新建）
- Test: `renderer/src/components/task-board/TaskFilters.test.tsx`（扩展 + INITIAL 补字段）
- Test: `renderer/src/components/task-board/TaskList.test.tsx`（新建）

**Interfaces:**
- Produces: `applyTaskFilters(tasks: TaskRow[], filter: FilterState): TaskRow[]`（TaskSidebarPanel 消费）；`FilterState.text: string`；`TaskListProps.emptyText?: string`
- Consumes: 既有 `FilterState`（status/assignee/sort）、`TaskRow`

- [ ] **Step 1: 写失败测试（三个测试文件）**

(a) 新建 `renderer/src/components/task-board/task-filter.test.ts`：

```ts
// renderer/src/components/task-board/task-filter.test.ts
//
// applyTaskFilters 纯函数测试（spec §4 / §7.2）：text 命中 title/description、
// text 与 status AND 叠加、空 text 不过滤、大小写、排序保持。
import { describe, it, expect } from 'vitest';
import { applyTaskFilters } from './task-filter';
import type { FilterState } from './TaskFilters';
import type { TaskRow } from '../../ipc/types';

const BASE: FilterState = { status: 'all', assignee: 'all', sort: 'priority', text: '' };

function makeTask(overrides: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    workspaceId: 'ws-1',
    title: '任务',
    description: '',
    status: 'pending',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'u1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 100,
    updatedAt: 100,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('applyTaskFilters — text 过滤', () => {
  const tasks = [
    makeTask({ id: 'T-1', title: '登录页重构', description: '' }),
    makeTask({ id: 'T-2', title: '日常任务', description: '涉及登录态缓存' }),
    makeTask({ id: 'T-3', title: '无关任务', description: '' }),
  ];

  it('text 命中 title', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '登录页' });
    expect(out.map((t) => t.id)).toEqual(['T-1']);
  });

  it('text 命中 description', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '缓存' });
    expect(out.map((t) => t.id)).toEqual(['T-2']);
  });

  it('text 大小写不敏感（trim 后匹配）', () => {
    const out = applyTaskFilters(
      [makeTask({ id: 'T-9', title: 'Release' })],
      { ...BASE, text: '  release ' },
    );
    expect(out.map((t) => t.id)).toEqual(['T-9']);
  });

  it('空 text（含纯空白）不过滤', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: '   ' });
    expect(out).toHaveLength(3);
  });

  it('text 与 status AND 叠加', () => {
    const mixed = [
      makeTask({ id: 'T-1', title: '登录', status: 'pending' }),
      makeTask({ id: 'T-2', title: '登录', status: 'completed' }),
    ];
    const out = applyTaskFilters(mixed, { ...BASE, text: '登录', status: 'completed' });
    expect(out.map((t) => t.id)).toEqual(['T-2']);
  });

  it('无命中返回空数组（空态由 UI 层展示「无匹配任务」）', () => {
    const out = applyTaskFilters(tasks, { ...BASE, text: 'zzz' });
    expect(out).toEqual([]);
  });
});
```

(b) 扩展 `TaskFilters.test.tsx`：`INITIAL` 补 `text: ''`，原「其余字段不变」断言对象补 `text: ''`，并追加用例：

```ts
const INITIAL: FilterState = { status: 'all', assignee: 'all', sort: 'priority', text: '' };

// （原第 42-60 行用例的 toHaveBeenCalledWith 对象改为）
    expect(onChange).toHaveBeenCalledWith({
      status: 'all',
      assignee: 'inst-pm',
      sort: 'priority',
      text: '',
    });

// 新增用例：
  it('文本输入 onChange 携带 text 更新，其余字段不变', () => {
    const onChange = vi.fn();
    render(
      <TaskFilters value={INITIAL} onChange={onChange} assigneeOptions={[]} />,
    );
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '登录' } });
    expect(onChange).toHaveBeenCalledWith({
      status: 'all',
      assignee: 'all',
      sort: 'priority',
      text: '登录',
    });
  });
```

(c) 新建 `TaskList.test.tsx`：

```ts
// renderer/src/components/task-board/TaskList.test.tsx
//
// TaskList 空态文案：默认「暂无任务」；emptyText 覆盖（过滤无结果场景）。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskList } from './TaskList';
import type { TaskRow } from '../../ipc/types';

describe('TaskList emptyText', () => {
  it('空列表默认显示「暂无任务」', () => {
    render(<TaskList tasks={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
  });

  it('传入 emptyText 时显示自定义文案（无匹配任务）', () => {
    render(
      <TaskList tasks={[]} selectedId={null} onSelect={() => {}} emptyText="无匹配任务" />,
    );
    expect(screen.getByText('无匹配任务')).toBeInTheDocument();
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/task-filter.test.ts src/components/task-board/TaskFilters.test.tsx src/components/task-board/TaskList.test.tsx
```

Expected: FAIL——`task-filter.ts` 不存在（模块解析失败）；FilterState 缺 text 导致 INITIAL 类型错误；TaskList 无 emptyText prop。

- [ ] **Step 3: 实现**

(a) 新建 `renderer/src/components/task-board/task-filter.ts`（逻辑自 TaskSidebarPanel 原样迁出 + text 叠加）：

```ts
// renderer/src/components/task-board/task-filter.ts
//
// 任务过滤+排序纯函数（自 TaskSidebarPanel 抽出，spec §4）：
// status / assignee / text 三过滤 AND 叠加后按 sort 排序。
// text 匹配 title + description（大小写不敏感子串，空 = 不过滤）。
import type { TaskStatus, TaskRow } from '../../ipc/types';
import type { FilterState } from './TaskFilters';

/** 'all' 的语义 = 不过滤（全部 8 态）。终态历史由 task.store.load 的
 *  orderBy created_at_desc + limit 500 截断保障。 */
const ALL_STATUSES: TaskStatus[] = [
  'draft',
  'pending',
  'assigned',
  'in_progress',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

export function applyTaskFilters(tasks: TaskRow[], filter: FilterState): TaskRow[] {
  let list = [...tasks];
  if (filter.status === 'all') {
    list = list.filter((t) => ALL_STATUSES.includes(t.status));
  } else {
    list = list.filter((t) => t.status === filter.status);
  }
  if (filter.assignee !== 'all') {
    list = list.filter((t) => t.assigneeAgentId === filter.assignee);
  }
  const q = filter.text.trim().toLowerCase();
  if (q !== '') {
    list = list.filter(
      (t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }
  list.sort((a, b) => {
    if (filter.sort === 'priority') {
      return b.priority - a.priority || a.createdAt - b.createdAt;
    }
    if (filter.sort === 'scheduled_at') {
      return (
        (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) -
        (b.scheduledAt ?? Number.MAX_SAFE_INTEGER)
      );
    }
    // created_at
    return a.createdAt - b.createdAt;
  });
  return list;
}
```

(b) `TaskFilters.tsx`：`FilterState` 加 `text: string`；组件 JSX 在两个 select 之前加文本输入框：

```ts
export interface FilterState {
  status: 'all' | TaskStatus;
  assignee: 'all' | string;
  sort: 'priority' | 'scheduled_at' | 'created_at';
  /** 文本过滤（spec §4）：匹配 title + description，空 = 不过滤 */
  text: string;
}
```

```tsx
      <input
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="搜索任务"
        aria-label="搜索任务"
        className="flex-1 min-w-0 bg-transparent text-xs text-primary placeholder:text-tertiary outline-none"
      />
```

(c) `TaskList.tsx`：`TaskListProps` 加 `emptyText?: string`，空态改 `emptyText ?? '暂无任务'`：

```ts
interface TaskListProps {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 排队名次表（taskId → rank，TaskSidebarPanel 按放行序计算） */
  queueRanks?: Map<string, number>;
  /** 空态文案覆盖（过滤无结果时传「无匹配任务」） */
  emptyText?: string;
}

export function TaskList({ tasks, selectedId, onSelect, queueRanks, emptyText }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-tertiary text-sm">
        {emptyText ?? '暂无任务'}
      </div>
    );
  }
  // ...其余不变
```

(d) `TaskSidebarPanel.tsx`：

- import 改为 `import { TaskFilters, type FilterState } from './TaskFilters';` 旁加 `import { applyTaskFilters } from './task-filter';`
- 删除本文件内 `ALL_STATUSES` 常量与 `filteredTasks` useMemo 主体，改为：

```tsx
  const [filter, setFilter] = useState<FilterState>({
    status: 'all',
    assignee: 'all',
    sort: 'priority',
    text: '',
  });

  // 过滤 + 排序（纯函数抽至 task-filter.ts，spec §4）
  const filteredTasks = useMemo(() => applyTaskFilters(tasks, filter), [tasks, filter]);
```

- `TaskList` 调用处加 emptyText：

```tsx
      <TaskList
        tasks={filteredTasks}
        selectedId={selectedTaskId}
        onSelect={(id) => setSelectedTaskId(id)}
        queueRanks={queueRanks}
        emptyText={filter.text.trim() !== '' ? '无匹配任务' : undefined}
      />
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/
```

Expected: PASS（task-filter 6 用例 + TaskFilters 4 用例 + TaskList 2 用例 + 既有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/task-board/
git commit -m "feat: task board text filter (title+description) with emptyText"
```

---

### Task 6: 全量验收（收尾门禁）

**Files:** 无新改动（验证 + 可能的修复）

- [ ] **Step 1: 双 workspace typecheck**

```bash
cd /workspace && nvm use 20 && npx pnpm@9.0.0 typecheck
```

Expected: electron + renderer 双 clean。

- [ ] **Step 2: 全量测试**

```bash
cd /workspace && npx pnpm@9.0.0 test
```

Expected: 两 workspace 全绿零 flake（对照 spec §7.3 验收标准）。

- [ ] **Step 3: 手动冒烟清单（macOS 主机，非阻塞 CI——容器内可用 `npx pnpm@9.0.0 dev` + xvfb 冒烟替代）**

- im 视图：输入关键词过滤会话列表 → 清除恢复 → 无匹配空态
- tasks 视图：输入关键词叠加 status 筛选 → 空态「无匹配任务」→ 清除恢复
- files 视图：输入文件名关键词 → 扁平结果 → 点击文件打开编辑器 → 清除恢复树；构造 200+ 命中验证截断提示

- [ ] **Step 4: 如有修复 → 补 commit；全部通过 → 完成**

```bash
git log --oneline -6
```

Expected: 5 个 feature commit（Task 1-5）+ 可能的修复 commit。

---

## 依赖与并行

- Task 1 → Task 2 → Task 3 严格串行（IPC 契约依赖）
- Task 4、Task 5 与 Task 1-3 **完全并行**（不同文件、不同 workspace 面）
- Task 6 必须最后
