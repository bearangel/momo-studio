# 工作区编辑器四项优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复工作区编辑器四个体验问题——文件夹选中后新建跟随、Monaco 全 UI 中文化、agent 写盘后文件树自动刷新。

**Architecture:** (1) file.store 加 `selectedDir` 状态 + `refreshAllCached` action；(2) FileContextMenu 加目录级新建项；(3) FileTreeView 单击文件夹选中+展开；(4) FileTree 工具栏读 selectedDir + 订阅 activeView 触发刷新；(5) Monaco 本地打包 + monaco-editor-nls 中文化。

**Tech Stack:** React + Zustand + @testing-library/react + Vitest + Monaco Editor + Vite

## Global Constraints

- **语言**：所有代码注释、文档使用中文（AGENTS.md）。代码标识符英文。
- **TypeScript strict**：禁止 `any`/`@ts-ignore`/`as any`。
- **Node 20 LTS**：容器内先 `nvm use 20`。
- **pnpm**：用 `npx pnpm@9.0.0`。
- **测试命令**：`cd renderer && npx pnpm@9.0.0 vitest run <file>` 单文件；`npx pnpm@9.0.0 test` 全套。
- **类型检查**：`npx pnpm@9.0.0 typecheck`（双 workspace）。
- **Renderer 测试约定**：`globals: false`（显式 import）；store 通过 `useFileStore.setState()` 设置；IPC 通过 `globalThis.window.api = mockApi` 桩；**不要** `vi.mock('../../ipc/client')`。
- **docs/ 提交**：`.gitignore` 含裸 `docs`，需 `git add -f docs/...`。
- **设计文档**：`docs/specs/2026-08-03-workspace-editor-improvements-design.md`（已批准）。

---

## 文件结构

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `renderer/src/stores/file.store.ts` | 文件树状态：新增 selectedDir + refreshAllCached | 修改 |
| `renderer/src/stores/file.store.test.ts` | store 测试：新增 selectedDir/refreshAllCached 用例 | 修改 |
| `renderer/src/components/files/FileContextMenu.tsx` | 右键菜单：目录级新增「新建文件/文件夹」 | 修改 |
| `renderer/src/components/files/FileContextMenu.test.tsx` | 组件测试 | 新建 |
| `renderer/src/components/files/FileTreeView.tsx` | 单击文件夹选中+展开；高亮；接 context menu 新建回调 | 修改 |
| `renderer/src/components/files/FileTree.tsx` | 工具栏读 selectedDir；订阅 activeView 触发 refreshAllCached；tooltip | 修改 |
| `renderer/src/components/files/FileTree.test.tsx` | 组件测试 | 新建 |
| `renderer/src/monaco-setup.ts` | Monaco 本地加载 + 中文 NLS + worker 配置 | 新建 |
| `renderer/src/main.tsx` | 顶部 import monaco-setup | 修改 |
| `renderer/vite.config.ts` | NLS alias + optimizeDeps | 修改 |
| `renderer/package.json` | 加 monaco-editor + monaco-editor-nls devDep | 修改 |

---

## Task 1: file.store — selectedDir + refreshAllCached

**Files:**
- Modify: `renderer/src/stores/file.store.ts`
- Test: `renderer/src/stores/file.store.test.ts`

**Interfaces:**
- Produces: `selectedDir: string`（默认 `'.'`）、`selectDir(dirPath: string): void`、`refreshAllCached(workspaceId: string): Promise<void>`
- Side effects: `deletePath` 和 `renamePath` 内部维护 `selectedDir` 一致性（删除/重命名选中目录时自动重置或更新）

**说明（偏离 spec 的简化）**：spec 写了独立的 `renameSelectedDir` action。实施时把 selectedDir 维护逻辑**内联**到 `deletePath`/`renamePath` 里——更简单，单一职责，避免外部调用方忘记同步。spec 意图（保持 selectedDir 一致）完全保留。

- [ ] **Step 1: 写失败测试（selectedDir 基础 + deletePath/renamePath 维护 + refreshAllCached）**

在 `renderer/src/stores/file.store.test.ts` 末尾追加（`beforeEach` 已有 `selectedFile: null` 重置，需补 `selectedDir: '.'`）：

先修改 `beforeEach` 的 setState，加 `selectedDir: '.'`：

```typescript
  // 重置 store 状态：空缓存 + 仅根展开 + 未激活 workspace + 根目录为选中目录
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
    selectedDir: '.',
    error: null,
    workspaceId: null,
  });
```

然后在文件末尾追加两个 describe 块：

```typescript
describe('file.store selectedDir', () => {
  it('selectDir 设置当前选中目录', () => {
    useFileStore.getState().selectDir('src');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('selectDir 根目录', () => {
    useFileStore.getState().selectDir('.');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('selectedDir 不持久化（initWorkspace 不读取它）', () => {
    localStorage.setItem('fileTree.expanded.ws-1', '[".","src"]');
    useFileStore.setState({ selectedDir: 'src' });
    useFileStore.getState().initWorkspace('ws-1');
    // initWorkspace 重置 selectedDir 为 '.'
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除选中目录本身时重置 selectedDir 为 "."', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'src');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除选中目录的子目录时不重置 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'src/nested');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('deletePath 删除选中目录的祖先时重置 selectedDir 为 "."', async () => {
    // selectedDir 是 src/utils，删除 src（祖先）应重置
    useFileStore.setState({ selectedDir: 'src/utils' });
    await useFileStore.getState().deletePath('ws-1', 'src');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除无关目录时不影响 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'docs');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('renamePath 重命名选中目录本身时更新 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().renamePath('ws-1', 'src', 'lib');
    expect(useFileStore.getState().selectedDir).toBe('lib');
  });

  it('renamePath 重命名选中目录的祖先时更新 selectedDir 前缀', async () => {
    // selectedDir 是 src/utils，src 改名为 lib，selectedDir 应变为 lib/utils
    useFileStore.setState({ selectedDir: 'src/utils' });
    await useFileStore.getState().renamePath('ws-1', 'src', 'lib');
    expect(useFileStore.getState().selectedDir).toBe('lib/utils');
  });

  it('renamePath 重命名无关目录时不影响 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().renamePath('ws-1', 'docs', 'documentation');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });
});

describe('file.store refreshAllCached', () => {
  it('并行刷新所有已缓存目录', async () => {
    // 预置三个已缓存目录
    useFileStore.setState({
      tree: new Map([
        ['.', ROOT_ENTRIES],
        ['src', SUB_ENTRIES],
        ['docs', ROOT_ENTRIES],
      ]),
    });

    await useFileStore.getState().refreshAllCached('ws-1');

    // 每个缓存 key 都被 list 重新拉取
    expect(mockApi.file.list).toHaveBeenCalledTimes(3);
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'docs');
  });

  it('空缓存时不调任何 list', async () => {
    useFileStore.setState({ tree: new Map() });
    await useFileStore.getState().refreshAllCached('ws-1');
    expect(mockApi.file.list).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/file.store.test.ts
```

预期：FAIL — `selectedDir` / `selectDir` / `refreshAllCached` 未定义。

- [ ] **Step 3: 实现 store 改动**

修改 `renderer/src/stores/file.store.ts`：

3a. 在 `FileState` interface 加字段（在 `selectedFile` 后面）：

```typescript
interface FileState {
  // ... 现有字段
  // 当前选中的文件全路径（相对 workspace 根）
  selectedFile: string | null;
  /** 当前选中目录（新建文件的落点）。'.' 表示根目录。不持久化 */
  selectedDir: string;
  error: string | null;
  // ... 其他现有字段

  // 记录选中的文件
  selectFile: (filePath: string) => void;
  /** 设为当前选中目录（单击文件夹时调用） */
  selectDir: (dirPath: string) => void;
  // ... 其他现有方法

  // 新建文件或目录，完成后刷新其父目录缓存
  createPath: (workspaceId: string, filePath: string, type: 'file' | 'dir') => Promise<void>;
  // ... 其他现有方法

  /** 刷新所有已缓存目录（视图切换时同步外部变更） */
  refreshAllCached: (workspaceId: string) => Promise<void>;
}
```

3b. 在 store 初始 state 加 `selectedDir: '.'`（在 `selectedFile: null,` 后面）：

```typescript
export const useFileStore = create<FileState>((set, get) => ({
  tree: new Map(),
  expandedDirs: new Set<string>(['.']),
  selectedFile: null,
  selectedDir: '.',
  error: null,
  workspaceId: null,
  // ...
```

3c. 在 `selectFile` 后面加 `selectDir`：

```typescript
  selectFile: (filePath) => set({ selectedFile: filePath }),

  selectDir: (dirPath) => set({ selectedDir: dirPath }),
```

3d. 修改 `initWorkspace` 重置 selectedDir（在 `set({ workspaceId, expandedDirs: expanded });` 改为）：

```typescript
  initWorkspace: (workspaceId) => {
    if (get().workspaceId === workspaceId) return;
    let expanded: Set<string>;
    try {
      const stored = localStorage.getItem(expandedKey(workspaceId));
      expanded = new Set(stored ? (JSON.parse(stored) as string[]) : ['.']);
    } catch {
      expanded = new Set(['.']);
    }
    // 切换 workspace 时重置选中目录为根（selectedDir 不跨 workspace 持久化）
    set({ workspaceId, expandedDirs: expanded, selectedDir: '.' });
  },
```

3e. 修改 `deletePath`，在 `refreshDir` 后加 selectedDir 维护：

```typescript
  deletePath: async (workspaceId, filePath) => {
    set({ error: null });
    try {
      await ipc.file.delete(workspaceId, filePath);
      const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
      await get().refreshDir(workspaceId, parent);
      // 维护 selectedDir 一致性：删除的路径是 selectedDir 本身或其祖先时重置为根
      const sel = get().selectedDir;
      if (sel === filePath || sel.startsWith(filePath + '/')) {
        set({ selectedDir: '.' });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
```

3f. 修改 `renamePath`，在末尾加 selectedDir 维护：

```typescript
  renamePath: async (workspaceId, srcPath, dstPath) => {
    set({ error: null });
    try {
      await ipc.file.rename(workspaceId, srcPath, dstPath);
      const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '.';
      const dstParent = dstPath.includes('/') ? dstPath.slice(0, dstPath.lastIndexOf('/')) : '.';
      await get().refreshDir(workspaceId, srcParent);
      if (srcParent !== dstParent) await get().refreshDir(workspaceId, dstParent);
      // 维护 selectedDir 一致性：重命名的是 selectedDir 本身或其祖先时同步更新
      const sel = get().selectedDir;
      if (sel === srcPath) {
        set({ selectedDir: dstPath });
      } else if (sel.startsWith(srcPath + '/')) {
        set({ selectedDir: dstPath + sel.slice(srcPath.length) });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
```

3g. 在 `renamePath` 后面加 `refreshAllCached`：

```typescript
  /** 刷新所有已缓存目录（视图切换时同步外部变更） */
  refreshAllCached: async (workspaceId) => {
    const cachedDirs = [...get().tree.keys()];
    await Promise.all(cachedDirs.map((dir) => get().refreshDir(workspaceId, dir)));
  },
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/file.store.test.ts
```

预期：所有测试 PASS（原有 + 新增 12 个）。

- [ ] **Step 5: 类型检查**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
```

预期：无错误。

- [ ] **Step 6: 提交**

```bash
git add renderer/src/stores/file.store.ts renderer/src/stores/file.store.test.ts
git commit -m "feat(file.store): 加 selectedDir 状态 + refreshAllCached action

- selectedDir 记录当前选中目录（新建文件落点），不持久化
- selectDir action 供 FileTreeView 单击文件夹时调用
- deletePath/renamePath 内联维护 selectedDir 一致性
- refreshAllCached 并行刷新所有已缓存目录（视图切换同步外部变更）"
```

---

## Task 2: FileContextMenu — 目录级新建项

**Files:**
- Modify: `renderer/src/components/files/FileContextMenu.tsx`
- Test: `renderer/src/components/files/FileContextMenu.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 store（间接，通过 onNewFile/onNewDir 回调）
- Produces: `FileContextMenu` 新增 `onNewFile: () => void` 和 `onNewDir: () => void` 可选 props（仅 `isDirectory=true` 时渲染对应按钮）

**依赖**：Task 1（无直接代码依赖，但语义上 onNewFile 回调最终调 store.createPath）

- [ ] **Step 1: 写失败测试**

新建 `renderer/src/components/files/FileContextMenu.test.tsx`：

```typescript
// renderer/src/components/files/FileContextMenu.test.tsx
// FileContextMenu 右键菜单：目录级新建项 + 重命名/移动/删除。
// 纯展示组件，回调由调用方通过 props 注入。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileContextMenu } from './FileContextMenu';

const baseProps = {
  x: 100,
  y: 100,
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
  onClose: vi.fn(),
};

describe('FileContextMenu', () => {
  it('isDirectory=true 渲染「新建文件」「新建文件夹」按钮', () => {
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    expect(screen.getByText('新建文件')).toBeInTheDocument();
    expect(screen.getByText('新建文件夹')).toBeInTheDocument();
  });

  it('isDirectory=false 不渲染「新建文件」「新建文件夹」', () => {
    render(<FileContextMenu {...baseProps} isDirectory={false} />);
    expect(screen.queryByText('新建文件')).not.toBeInTheDocument();
    expect(screen.queryByText('新建文件夹')).not.toBeInTheDocument();
  });

  it('点击「新建文件」触发 onNewFile 并关闭菜单', () => {
    const onNewFile = vi.fn();
    const onClose = vi.fn();
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={onNewFile}
        onNewDir={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('新建文件'));
    expect(onNewFile).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('点击「新建文件夹」触发 onNewDir 并关闭菜单', () => {
    const onNewDir = vi.fn();
    const onClose = vi.fn();
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={onNewDir}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('新建文件夹'));
    expect(onNewDir).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('现有「重命名」「移动到…」「删除」按钮仍正常', () => {
    render(
      <FileContextMenu
        {...baseProps}
        isDirectory={true}
        onNewFile={() => {}}
        onNewDir={() => {}}
      />,
    );
    expect(screen.getByText('重命名')).toBeInTheDocument();
    expect(screen.getByText('移动到…')).toBeInTheDocument();
    expect(screen.getByText(/删除/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileContextMenu.test.tsx
```

预期：FAIL — `onNewFile`/`onNewDir` props 不存在，「新建文件」按钮未渲染。

- [ ] **Step 3: 实现 FileContextMenu 改动**

修改 `renderer/src/components/files/FileContextMenu.tsx`，替换整个文件：

```tsx
// renderer/src/components/files/FileContextMenu.tsx
// 文件/目录右键菜单：目录级新建 + 重命名 / 删除 / 移动。位置由调用方通过 clientX/Y 传入。
interface Props {
  x: number;
  y: number;
  isDirectory: boolean;
  onRename: () => void;
  onDelete: () => void;
  onMove: () => void;
  onClose: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件 */
  onNewFile?: () => void;
  /** 仅 isDirectory=true 时渲染：在该目录内新建文件夹 */
  onNewDir?: () => void;
}

export function FileContextMenu({
  x,
  y,
  isDirectory,
  onRename,
  onDelete,
  onMove,
  onClose,
  onNewFile,
  onNewDir,
}: Props) {
  return (
    <>
      {/* 全屏遮罩：点击或右键关闭菜单 */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <ul
        className="fixed z-50 bg-bg-secondary border border-border-subtle rounded shadow-lg py-1 text-sm text-neutral-200 min-w-[120px]"
        style={{ left: x, top: y }}
      >
        {/* 目录级新建：仅在右键目标是目录时显示 */}
        {isDirectory && (
          <>
            {onNewFile && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onNewFile();
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
                >
                  新建文件
                </button>
              </li>
            )}
            {onNewDir && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onNewDir();
                    onClose();
                  }}
                  className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
                >
                  新建文件夹
                </button>
              </li>
            )}
            <li className="border-t border-border-subtle my-1" />
          </>
        )}
        <li>
          <button
            type="button"
            onClick={() => {
              onRename();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
          >
            重命名
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => {
              onMove();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary"
          >
            移动到…
          </button>
        </li>
        <li className="border-t border-border-subtle my-1" />
        <li>
          <button
            type="button"
            onClick={() => {
              onDelete();
              onClose();
            }}
            className="w-full text-left px-3 py-1 hover:bg-bg-tertiary text-red-400"
          >
            删除{isDirectory ? '（含子项）' : ''}
          </button>
        </li>
      </ul>
    </>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileContextMenu.test.tsx
```

预期：5 个测试 PASS。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
git add renderer/src/components/files/FileContextMenu.tsx renderer/src/components/files/FileContextMenu.test.tsx
git commit -m "feat(FileContextMenu): 目录级右键新建文件/文件夹

isDirectory=true 时菜单顶部加「新建文件」「新建文件夹」两项，
通过 onNewFile/onNewDir 回调由调用方处理实际创建逻辑"
```

---

## Task 3: FileTreeView — 单击选中目录 + 高亮 + 接 context menu 新建

**Files:**
- Modify: `renderer/src/components/files/FileTreeView.tsx`

**Interfaces:**
- Consumes: Task 1 的 `selectDir` / `selectedDir` / `createPath`；Task 2 的 `FileContextMenu` 新 props
- Produces: 单击文件夹 = selectDir + toggleDir；目录高亮；右键目录可新建

**依赖**：Task 1（store）、Task 2（FileContextMenu 新 props）

- [ ] **Step 1: 实现 FileTreeView 改动（无独立单元测试——交互逻辑靠集成验证）**

> 说明：FileTreeView 是递归组件，状态依赖复杂（store + workspace + 本地 menu/renaming/moving），写隔离单元测试成本高且脆弱。本任务的正确性靠 Task 4 的 FileTree 集成测试 + 手动 QA 验证。若 reviewer 要求，可补 selectedDir 高亮的 snapshot 测试。

修改 `renderer/src/components/files/FileTreeView.tsx`：

1a. 从 store 解构 `selectedDir` 和 `selectDir`（在现有解构里加）：

```typescript
  const { tree, expandedDirs, selectedFile, selectedDir, loadDir, toggleDir, selectFile, selectDir, deletePath, renamePath, createPath } =
    useFileStore();
```

1b. 加目录级新建状态（在 `moving` state 后面）：

```typescript
  // 目录内新建状态：目标目录 + 类型（file/dir）
  const [creatingInDir, setCreatingInDir] = useState<{ dir: string; type: 'file' | 'dir' } | null>(null);
```

1c. 修改目录节点的 `<button>`，onClick 同时 selectDir + toggleDir，加高亮：

```tsx
              <button
                onClick={() => {
                  selectDir(fullPath);
                  toggleDir(fullPath);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path: fullPath, isDirectory: true });
                }}
                className={cn(
                  'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
                  selectedDir === fullPath && 'bg-accent-blue/20',
                )}
                style={{ paddingLeft: depth * 16 }}
              >
```

1d. 修改 `<FileContextMenu>` 调用，加 onNewFile/onNewDir（在现有 props 后面加）：

```tsx
      {menu && workspace && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          isDirectory={menu.isDirectory}
          onNewFile={
            menu.isDirectory
              ? () => setCreatingInDir({ dir: menu.path, type: 'file' })
              : undefined
          }
          onNewDir={
            menu.isDirectory
              ? () => setCreatingInDir({ dir: menu.path, type: 'dir' })
              : undefined
          }
          onRename={() =>
            setRenaming({ path: menu.path, value: menu.path.split('/').pop() ?? '' })
          }
          onDelete={async () => {
            const scope = menu.isDirectory ? '目录及其全部内容' : '该文件';
            if (!confirm(`确定删除${scope}？\n${menu.path}`)) return;
            await deletePath(workspace.id, menu.path);
            closeTabIfPath(menu.path);
          }}
          onMove={() => setMoving({ path: menu.path })}
          onClose={() => setMenu(null)}
        />
      )}
```

1e. 加 creatingInDir 的 PromptDialog（在 `moving` 的 PromptDialog 后面、`renaming` 的前面）：

```tsx
      {creatingInDir && workspace && (
        <PromptDialog
          title={creatingInDir.type === 'file' ? `在「${creatingInDir.dir}」内新文件名` : `在「${creatingInDir.dir}」内新目录名`}
          placeholder={creatingInDir.type === 'file' ? '如 foo.ts' : '如 utils'}
          onSubmit={async (name) => {
            const dir = creatingInDir.dir;
            const type = creatingInDir.type;
            setCreatingInDir(null);
            if (!name.trim()) return;
            const fullPath = `${dir}/${name.trim()}`;
            try {
              await createPath(workspace.id, fullPath, type);
            } catch (e) {
              alert(`创建失败：${e instanceof Error ? e.message : String(e)}`);
            }
          }}
          onClose={() => setCreatingInDir(null)}
        />
      )}
```

- [ ] **Step 2: 类型检查**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
```

预期：无错误。

- [ ] **Step 3: 运行现有测试确认无回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/file.store.test.ts src/components/files/FileContextMenu.test.tsx
```

预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add renderer/src/components/files/FileTreeView.tsx
git commit -m "feat(FileTreeView): 单击文件夹选中+展开 + 目录级新建

- 单击文件夹同时调 selectDir（高亮为新建落点）和 toggleDir（展开/折叠）
- 选中目录行加 bg-accent-blue/20 高亮
- 右键目录菜单接 onNewFile/onNewDir，弹 PromptDialog 输入名后
  createPath 到该目录"
```

---

## Task 4: FileTree 工具栏 — 读 selectedDir + activeView 刷新触发

**Files:**
- Modify: `renderer/src/components/files/FileTree.tsx`
- Test: `renderer/src/components/files/FileTree.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `selectedDir` / `refreshAllCached`；`useUiStore` 的 `activeView`
- Produces: 工具栏新建按钮根据 selectedDir 拼路径；切到 files 视图触发 refreshAllCached

**依赖**：Task 1（store）

- [ ] **Step 1: 写失败测试**

新建 `renderer/src/components/files/FileTree.test.tsx`：

```typescript
// renderer/src/components/files/FileTree.test.tsx
// FileTree 工具栏：新建按钮根据 selectedDir 拼路径 + activeView 切换触发刷新。
// store 已在 Task 1 测过；本测试聚焦工具栏与 store 的集成。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from './FileTree';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';
import type { DirEntry } from '../../ipc/types';

const ROOT_ENTRIES: DirEntry[] = [
  { name: 'a.ts', isDirectory: false, size: 0 },
];

const mockApi = {
  file: {
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(ROOT_ENTRIES),
    read: vi.fn(),
    write: vi.fn(),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  localStorage.clear();
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
    selectedDir: '.',
    error: null,
    workspaceId: null,
  });
  useWorkspaceStore.setState({
    workspaces: [{ id: 'ws-1', name: 'ws', path: '/tmp/ws', gitEnabled: true, coordinatorInstanceId: null }],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });
  useUiStore.setState({ activeView: 'im' });
  mockApi.file.create.mockClear();
  mockApi.file.list.mockClear();
  mockApi.file.list.mockResolvedValue(ROOT_ENTRIES);
});

describe('FileTree 工具栏 selectedDir 集成', () => {
  it('selectedDir="." 时工具栏新建文件调 createPath 传裸文件名', async () => {
    render(<FileTree onSelectFile={() => {}} />);
    // 点新建文件按钮
    const newFileBtn = screen.getByTitle('新建文件');
    fireEvent.click(newFileBtn);
    // PromptDialog 输入
    const input = await screen.findByPlaceholderText(/可含子目录/);
    fireEvent.change(input, { target: { value: 'foo.ts' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'foo.ts', 'file');
    });
  });

  it('selectedDir="src" 时工具栏新建文件调 createPath 传 src/foo.ts', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    render(<FileTree onSelectFile={() => {}} />);
    const newFileBtn = screen.getByTitle('新建文件（到 src）');
    fireEvent.click(newFileBtn);
    const input = await screen.findByPlaceholderText(/可含子目录/);
    fireEvent.change(input, { target: { value: 'foo.ts' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'src/foo.ts', 'file');
    });
  });

  it('selectedDir 变化时工具栏 tooltip 更新', () => {
    useFileStore.setState({ selectedDir: 'src' });
    render(<FileTree onSelectFile={() => {}} />);
    expect(screen.getByTitle('新建文件（到 src）')).toBeInTheDocument();
    expect(screen.getByTitle('新建文件夹（到 src）')).toBeInTheDocument();
  });
});

describe('FileTree activeView 刷新触发', () => {
  it('从 im 切到 files 时触发 refreshAllCached', async () => {
    // 预置一个已缓存目录
    useFileStore.setState({ tree: new Map([['.', ROOT_ENTRIES]]) });
    useUiStore.setState({ activeView: 'im' });
    render(<FileTree onSelectFile={() => {}} />);
    expect(mockApi.file.list).not.toHaveBeenCalled();
    // 切到 files
    useUiStore.setState({ activeView: 'files' });
    await waitFor(() => {
      expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
    });
  });

  it('已在 files 视图时 activeView 不变不重复触发', async () => {
    useFileStore.setState({ tree: new Map([['.', ROOT_ENTRIES]]) });
    useUiStore.setState({ activeView: 'files' });
    render(<FileTree onSelectFile={() => {}} />);
    // 初次渲染触发一次
    await waitFor(() => {
      expect(mockApi.file.list).toHaveBeenCalledTimes(1);
    });
    // 同值 setState 不应再触发（useEffect 依赖未变）
    useUiStore.setState({ activeView: 'files' });
    expect(mockApi.file.list).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileTree.test.tsx
```

预期：FAIL — tooltip 不含「（到 src）」、activeView 切换未触发 list。

- [ ] **Step 3: 实现 FileTree 改动**

修改 `renderer/src/components/files/FileTree.tsx`，替换整个文件：

```tsx
// renderer/src/components/files/FileTree.tsx
// 文件树入口组件：顶部工具条（刷新 / 全部折叠 / 新建）+ 从根目录 '.' 开始递归渲染。
// 工具栏新建按钮的落点跟随 selectedDir；切回 files 视图时刷新已缓存目录。
import { useState, useEffect } from 'react';
import { FileTreeView } from './FileTreeView';
import { PromptDialog } from '../common/PromptDialog';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';

interface Props {
  // 选中文件时触发的外部回调（全路径相对 workspace 根）
  onSelectFile: (filePath: string) => void;
}

export function FileTree({ onSelectFile }: Props) {
  const collapseAll = useFileStore((s) => s.collapseAll);
  const refreshDir = useFileStore((s) => s.refreshDir);
  const initWorkspace = useFileStore((s) => s.initWorkspace);
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeView = useUiStore((s) => s.activeView);
  const selectedDir = useFileStore((s) => s.selectedDir);
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);

  // workspace 切换时加载该 workspace 的展开态（按 workspace 隔离持久化）
  useEffect(() => {
    if (workspace) initWorkspace(workspace.id);
  }, [workspace, initWorkspace]);

  // 切回文件视图时刷新所有已缓存目录（agent/外部/git 可能改动了文件）
  useEffect(() => {
    if (activeView === 'files' && workspace) {
      void useFileStore.getState().refreshAllCached(workspace.id);
    }
  }, [activeView, workspace?.id]);

  // 刷新当前 workspace 根目录：失效缓存后重新拉取
  const handleRefresh = () => {
    if (workspace) {
      void refreshDir(workspace.id, '.');
    }
  };

  const handleCreate = async (name: string) => {
    const type = creating;
    setCreating(null);
    if (!name.trim() || !workspace || !type) return;
    // 根据当前选中目录拼接完整路径
    const targetDir = useFileStore.getState().selectedDir || '.';
    const fullPath = targetDir === '.' ? name.trim() : `${targetDir}/${name.trim()}`;
    try {
      await useFileStore.getState().createPath(workspace.id, fullPath, type);
    } catch (e) {
      alert(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // tooltip 文案：选中根目录时不显示「（到 .）」，子目录显示「（到 {dir}）」
  const targetLabel = selectedDir && selectedDir !== '.' ? `（到 ${selectedDir}）` : '';

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle sticky top-0 bg-bg-secondary z-10">
        <button
          type="button"
          onClick={handleRefresh}
          title="刷新"
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1"
        >
          🔄
        </button>
        <button
          type="button"
          onClick={collapseAll}
          title="全部折叠"
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1"
        >
          折叠
        </button>
        <button
          type="button"
          onClick={() => workspace && setCreating('file')}
          disabled={!workspace}
          title={`新建文件${targetLabel}`}
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-40"
        >
          📄＋
        </button>
        <button
          type="button"
          onClick={() => workspace && setCreating('dir')}
          disabled={!workspace}
          title={`新建文件夹${targetLabel}`}
          className="text-xs text-neutral-400 hover:text-neutral-200 px-1 disabled:opacity-40"
        >
          📁＋
        </button>
      </div>
      <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
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

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/files/FileTree.test.tsx
```

预期：5 个测试 PASS。

> 若 `screen.findByPlaceholderText(/可含子目录/)` 找不到元素，检查 PromptDialog 的 placeholder 是否匹配。若 PromptDialog 用 input 而非 form submit，需调整 fireEvent.submit 目标。

- [ ] **Step 5: 类型检查 + 全套测试**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
cd renderer && npx pnpm@9.0.0 vitest run
```

预期：typecheck 无错误；全套测试 PASS（105 + 新增 17 个）。

- [ ] **Step 6: 提交**

```bash
git add renderer/src/components/files/FileTree.tsx renderer/src/components/files/FileTree.test.tsx
git commit -m "feat(FileTree): 工具栏新建跟随 selectedDir + activeView 刷新触发

- 新建按钮读 selectedDir 拼接完整路径，tooltip 显示落点
- 订阅 activeView，切回 files 视图时 refreshAllCached 同步外部变更"
```

---

## Task 5: Monaco 全 UI 中文化

**Files:**
- Create: `renderer/src/monaco-setup.ts`
- Modify: `renderer/src/main.tsx`
- Modify: `renderer/vite.config.ts`
- Modify: `renderer/package.json`

**Interfaces:**
- Consumes: `monaco-editor` + `monaco-editor-nls` + `@monaco-editor/react` loader
- Produces: Monaco 从本地 npm 包加载，中文 locale，worker 走 Vite 打包

**依赖**：无（独立于 Task 1-4）

**说明**：此任务无单元测试——Monaco locale 是构建时配置，靠 build 验证 + 手动 QA。TDD 不适用，改为"配置 → build 验证 → 手动 QA"循环。

- [ ] **Step 1: 安装依赖**

```bash
nvm use 20
cd renderer && npx pnpm@9.0.0 add -D monaco-editor monaco-editor-nls
```

安装后检查 `node_modules/monaco-editor-nls` 实际结构，确认中文 locale 文件路径（可能是 `locale/zh-cn`、`locale/zh-cn.js` 或 `zh-cn`）。记下实际路径供 Step 3 用。

```bash
ls node_modules/monaco-editor-nls/
ls node_modules/monaco-editor-nls/locale/ 2>/dev/null || echo "no locale dir"
```

- [ ] **Step 2: 创建 monaco-setup.ts**

新建 `renderer/src/monaco-setup.ts`（若 Step 1 确认的 locale 路径不是 `monaco-editor-nls/locale/zh-cn`，替换 import 路径）：

```typescript
// renderer/src/monaco-setup.ts
// Monaco 配置：从本地 npm 包加载（离线优先）+ 中文 locale + worker 走 Vite 打包。
// 必须在 main.tsx 顶部、任何 <Editor /> 渲染前 import。
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// 中文语言包（Vite 打包进 bundle）
import 'monaco-editor-nls/locale/zh-cn';

// 配置 worker 工厂：Monaco 各语言服务在独立 worker 线程跑
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

// 让 @monaco-editor/react 用本地 npm 包而非 CDN
loader.config({ monaco });
```

- [ ] **Step 3: 在 main.tsx 顶部 import**

修改 `renderer/src/main.tsx`，在**第一行**（其他 import 之前）加：

```typescript
import './monaco-setup';
```

- [ ] **Step 4: 修改 Vite 配置**

修改 `renderer/vite.config.ts`，加 NLS alias 和 optimizeDeps：

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 把 Monaco 的 NLS 模块替换为中文化版本（monaco-editor-nls 标准用法）
      'monaco-editor/esm/vs/nls': path.resolve(__dirname, 'node_modules/monaco-editor-nls'),
    },
  },
  optimizeDeps: {
    // monaco-editor 体积大，预构建避免 dev 模式卡顿
    include: ['monaco-editor'],
  },
  server: {
    port: 5173,
  },
});
```

> 若 Step 1 确认的 monaco-editor-nls 入口结构不同，alias 的左侧 key 可能需要调整。常见替代：`'monaco-editor/esm/vs/nls.js'`。

- [ ] **Step 5: Build 验证**

```bash
nvm use 20
cd renderer && npx pnpm@9.0.0 build
```

预期：build 成功，无 worker 解析错误。若报错：
- `Cannot resolve 'monaco-editor/esm/vs/editor/editor.worker?worker'` → 检查 monaco-editor 版本，可能需要 `?worker` 改为直接 import
- `monaco-editor-nls locale not found` → 回到 Step 1 确认路径
- alias 不生效 → 尝试 `'monaco-editor/esm/vs/nls.js'` 作为 alias key

**备选方案（若上述 alias 方案走不通）**：

```bash
cd renderer && npx pnpm@9.0.0 add -D vite-plugin-monaco-editor
```

然后 vite.config.ts 改用插件（详见插件 README），移除手写 worker import 和 alias。monaco-setup.ts 简化为仅 `loader.config({ monaco })` + locale import。

- [ ] **Step 6: 验证中文 NLS 打包进 bundle**

```bash
cd renderer && grep -l "剪切" dist/assets/*.js | head -5
```

预期：至少一个 bundle 文件含中文 UI 字符串（如"剪切"/"复制"/"粘贴"/"命令面板"）。若为空，locale 未正确打包，回 Step 2/4 排查。

- [ ] **Step 7: 类型检查**

```bash
npx pnpm@9.0.0 typecheck
```

预期：双 workspace 无错误。

- [ ] **Step 8: 提交**

```bash
git add renderer/src/monaco-setup.ts renderer/src/main.tsx renderer/vite.config.ts renderer/package.json renderer/pnpm-lock.yaml
git commit -m "feat(monaco): 本地打包 Monaco + 中文 locale（离线优先）

- 装 monaco-editor + monaco-editor-nls devDep
- monaco-setup.ts 配置 worker 工厂 + loader.config 指向本地包
- Vite alias 把 monaco nls 模块替换为中文版
- main.tsx 顶部 import monaco-setup 确保在 Editor 之前执行"
```

- [ ] **Step 9: 手动 QA（用户在 macOS 上执行）**

```bash
cd /Users/stbearangel/dev/AiProject/momo-studio
git pull
nvm use 20
npx pnpm@9.0.0 dev
```

验证清单：
- [ ] 打开任意代码文件，Monaco 编辑器加载无报错
- [ ] 右键编辑器 → 菜单显示「剪切/复制/粘贴/...」（中文）
- [ ] 按 F1 → 命令面板显示中文命令
- [ ] hover 错误提示中文（若有语法错误）
- [ ] 断网测试：关闭网络，重启 app，Monaco UI 仍为中文

---

## Self-Review

### Spec coverage

| Spec 要求 | 对应 Task |
|---|---|
| selectedDir + selectDir | Task 1 Step 3c |
| deletePath 维护 selectedDir | Task 1 Step 3e |
| renamePath 维护 selectedDir | Task 1 Step 3f |
| initWorkspace 重置 selectedDir | Task 1 Step 3d |
| 单击文件夹 = selectDir + toggleDir + 高亮 | Task 3 Step 1c |
| 右键目录菜单加新建项 | Task 2 + Task 3 Step 1d/1e |
| 工具栏读 selectedDir 拼路径 | Task 4 Step 3 |
| 工具栏 tooltip 显示落点 | Task 4 Step 3 |
| refreshAllCached action | Task 1 Step 3g |
| activeView 切换触发刷新 | Task 4 Step 3 |
| Monaco 本地打包 + 中文 NLS | Task 5 |
| 备选 vite-plugin-monaco-editor | Task 5 Step 5 备选 |

✅ 全覆盖。

### Placeholder scan

无 TBD/TODO。所有步骤含完整代码。

### Type consistency

- `selectedDir: string` — Task 1 定义，Task 3/4 消费，类型一致
- `selectDir(dirPath: string): void` — Task 1 定义，Task 3 调用，签名一致
- `refreshAllCached(workspaceId: string): Promise<void>` — Task 1 定义，Task 4 调用，签名一致
- `FileContextMenu` 的 `onNewFile?: () => void` / `onNewDir?: () => void` — Task 2 定义，Task 3 传入，签名一致（Task 3 传入的是 `() => setCreatingInDir({...})` 无参函数）

✅ 一致。

### 风险点

1. **Task 4 测试的 PromptDialog 交互**：`fireEvent.submit(input.closest('form')!)` 依赖 PromptDialog 内部结构。若 PromptDialog 不用 form 包裹 input，需改用 button click。实施时若失败，先读 `renderer/src/components/common/PromptDialog.tsx` 确认结构。
2. **Task 5 monaco-editor-nls 路径**：Step 1 已要求先查实际结构。若与计划假设不符，Step 2/4 的 import/alias 路径需对应调整。
3. **Task 5 Vite worker 打包**：`?worker` import 是 Vite 5+ 标准用法。若项目 Vite 版本 < 5，需升级或改用 `worker-loader`（当前 renderer 应已是 Vite 5+）。

---

## 执行顺序

```
Task 1 (store) ──┬─→ Task 2 (FileContextMenu) ──→ Task 3 (FileTreeView)
                 ├─→ Task 4 (FileTree toolbar)
                 └─→ (无依赖)
Task 5 (Monaco) ──── 完全独立，可与任何 Task 并行
```

**推荐并行**：Task 1 完成后，Task 2+4+5 可并行；Task 3 等 Task 2 完成后执行。

**串行（保守）**：Task 1 → 2 → 3 → 4 → 5。
