# 工作区编辑器四项优化设计

**日期**：2026-08-03
**范围**：v1.2 后续迭代（IM 体验优化第二批）
**状态**：设计已批准，待出实施计划

## 背景与问题

用户反馈四个工作区编辑器的体验问题：

1. **新建文件总落在根目录** — 在文件树选中某子文件夹后，工具栏 📄＋/📁＋ 创建的文件/文件夹仍然落在 workspace 根目录，而非选中的子目录。
2. **Monaco 编辑器右键菜单英文** — Cut/Copy/Paste/Command Palette 等内置菜单项全英文，与 UI 其余部分的中文风格不一致。
3. **Monaco F1 命令面板英文** — 同根因，Monaco locale 全局英文导致所有 UI 表面（右键菜单、F1、hover、错误提示）一起英文。
4. **Agent 创建文件后文件树不刷新** — 在 IM 区 dispatch 文件创建任务给 agent，agent 写盘后，切回 Files 视图，文件树显示陈旧缓存，需重启 app 才能看到新文件。

## 设计目标

- 文件夹选中 + 工具栏新建跟随 + 右键菜单就地新建（解决问题 1）
- Monaco 全 UI 中文化，离线可用，开箱即用（解决问题 2 + 3）
- 切回 Files 视图自动同步外部变更（解决问题 4）
- 不引入新架构，不破坏现有测试

## 非目标（YAGNI）

- ❌ 多语言切换（中/英 toggle）—— 个人应用，固定中文
- ❌ Monaco 主题定制 —— 保持现有 `vs-dark`
- ❌ 重构 `detectLanguage` —— 够用
- ❌ 文件夹排序 —— 与本次需求无关
- ❌ `fs.watch` 实时监听 —— OrbStack 环境有已知坑，v1 范围过度

---

## 第 1 节：文件夹选中 + 新建跟随

### 数据模型变更

`renderer/src/stores/file.store.ts` 新增：

```typescript
interface FileState {
  // ... 现有字段保留
  /** 当前选中目录（新建文件的落点）。'.' 表示根目录 */
  selectedDir: string;
  /** 设为当前选中目录（单击文件夹时调用） */
  selectDir: (dirPath: string) => void;
  /** 重命名/移动目录时同步更新 selectedDir（复用 renameTab 模式） */
  renameSelectedDir: (oldPath: string, newPath: string) => void;
}
```

`selectedDir` **不做持久化**——它是临时操作上下文，每次进入 workspace 默认为 `'.'`。原因：持久化会让用户困惑"为什么工具栏建的文件不知跑哪了"。

### UX 行为

**单击文件夹** = 同时做两件事：

1. `selectDir(fullPath)` — 高亮该文件夹作为"当前新建目标"
2. `toggleDir(fullPath)` — 展开/折叠子树

这是 VS Code 的行为：单击文件夹既选中又展开。文件夹行加 `bg-accent-blue/20` 高亮（复用现有文件选中样式）。

**右键文件夹** → `FileContextMenu` 新增两项（仅在 `isDirectory === true` 时显示）：

- 「新建文件」→ 弹 `PromptDialog`，输入名后 `createPath(${fullPath}/${name}, 'file')`
- 「新建文件夹」→ 同上，type 为 `'dir'`

**工具栏 📄＋/📁＋** → `handleCreate` 改为读取 `selectedDir`：

```typescript
const targetDir = useFileStore.getState().selectedDir || '.';
const fullPath = targetDir === '.' ? name : `${targetDir}/${name}`;
await createPath(workspace.id, fullPath, type);
```

**视觉提示** — 工具栏按钮 hover tooltip 改为「新建文件（到 {selectedDir}）」，让用户明确知道落点。

### 边界情况

| 情况 | 处理 |
|---|---|
| 选中目录本身被删除 | `deletePath` 执行后检查：若 `selectedDir === deletedPath \|\| selectedDir.startsWith(deletedPath + '/')`，重置为 `'.'` |
| 选中目录的祖先被删除（递归删除场景） | 同上 `startsWith` 检查覆盖 |
| 选中目录被重命名/移动 | `renamePath` 内部检查：若 `selectedDir === oldPath`，设为 `newPath`；若 `selectedDir.startsWith(oldPath + '/')`，替换前缀为 `newPath` |
| workspace 切换 | `initWorkspace` 重置 `selectedDir = '.'` |

---

## 第 2 节：Monaco 全 UI 中文化

### 现状

`renderer/src/components/editor/CodeEditor.tsx` 用 `@monaco-editor/react` 的 `<Editor>`，默认从 jsdelivr CDN 加载 Monaco，locale 英文。无 `loader.config()`，无 worker 配置。

### 方案

**本地打包 + 中文 NLS**（离线优先，符合"开箱即用"）。

### 依赖

`renderer` 新增：

- `monaco-editor`（devDependency，与 `@monaco-editor/react` peer 版本对齐，约 `^0.52.0`）
- `monaco-editor-nls`（中文语言包，通过模块替换实现）

### 实现细节

**新文件** `renderer/src/monaco-setup.ts`（在 `main.tsx` 顶部 import，确保在 `<Editor>` 之前执行）：

```typescript
// 配置 Monaco：本地 npm 包加载（离线优先）+ 中文 locale + worker 打包
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// 中文语言包（Vite 打包进 bundle）
import 'monaco-editor-nls/locale/zh-cn';

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
```

**Vite 配置变更**（`renderer/vite.config.ts`）：

```typescript
export default defineConfig({
  // ... 现有配置
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
});
```

**CodeEditor.tsx** 改动最小：`@monaco-editor/react` 检测到 `loader.config({ monaco })` 后自动用本地包，CDN 隐式依赖消失。`detectLanguage` 等其他逻辑不变。

### 影响范围

- 右键菜单：`Cut/Copy/Paste/...` → `剪切/复制/粘贴/...` ✅
- F1 命令面板：所有命令中文化 ✅
- hover/错误提示/查找替换等附属 UI 一起中文化 ✅
- 不影响代码内容、语法高亮、保存逻辑

### 已知风险与备选

1. `monaco-editor-nls` 的 alias hack 在某些 Vite 版本上偶尔不稳定。若走不通，备选方案是 `vite-plugin-monaco-editor`（实施计划里写明回退步骤）。
2. `monaco-editor-nls/locale/zh-cn` 的具体 import 路径需在实施时验证（不同版本路径可能是 `monaco-editor-nls/locale/zh-cn.js` 或 `monaco-editor-nls/zh-cn`）。实施第一步先 `pnpm add` 后查 `node_modules/monaco-editor-nls` 实际结构确认。
3. renderer bundle 增加 ~5MB（gzip 后 ~1.5MB），桌面应用可接受。
4. Monaco worker 加载失败时 Monaco 自带降级（main thread 模式），不阻塞编辑；控制台 warning。

---

## 第 3 节：视图切换刷新文件树

### 根因

`file.store.ts` 的 `tree: Map<string, DirEntry[]>` 缓存目录列表。`FileTreeView` 的 `useEffect` **只在 `!entries`（首次未缓存）时调 `loadDir`**。一旦缓存过一次，永远不刷新，除非：

- 用户点 🔄 手动刷新
- 用户在 UI 里通过 `createPath`/`renamePath`/`deletePath` 触发

Agent 通过 `runtime-entry.ts` → `WorkspaceFS.writeFile()` 直接写盘，**没有任何 IPC 通知 renderer 失效缓存**。

### 方案

**切到 Files 视图时刷新所有已缓存目录**（方案 A）。

覆盖所有变更来源（agent/git/外部编辑），实现最小可靠。fs.watch 在 OrbStack 环境有已知坑，v1 范围过度。

### 实现

**`file.store.ts`** 新增 action：

```typescript
/** 刷新所有已缓存目录（视图切换时同步外部变更） */
refreshAllCached: async (workspaceId: string) => {
  const cachedDirs = [...get().tree.keys()];
  await Promise.all(cachedDirs.map((dir) => get().refreshDir(workspaceId, dir)));
},
```

**`renderer/src/components/files/FileTree.tsx`** 新增订阅：

```typescript
const activeView = useUiStore((s) => s.activeView);

useEffect(() => {
  // 切回文件视图时刷新所有已缓存目录（agent/外部/git 可能改动了文件）
  if (activeView === 'files' && workspace) {
    void useFileStore.getState().refreshAllCached(workspace.id);
  }
}, [activeView, workspace?.id]);
```

### 成本

- 每次切到 Files 视图触发 N 次 `list` IPC（N = 已缓存目录数，通常 2-5）
- 本地 fs，每次 < 5ms，用户无感
- 不影响 IM/Agent 视图

---

## 测试策略

### 单元测试（新增）

**`file.store.test.ts`**：

- `selectDir('.')` / `selectDir('src')` 正确设置选中目录
- `selectedDir` 不持久化（`initWorkspace` 不读取它）
- `renameSelectedDir(old, new)` 更新 `selectedDir`
- 删除当前选中目录后 `selectedDir` 重置为 `'.'`
- `refreshAllCached` 并行刷新所有已缓存目录
- 空缓存时 `refreshAllCached` 不调任何 `list`

**`FileContextMenu.test.tsx`**（新建）：

- `isDirectory=true` 渲染「新建文件」「新建文件夹」按钮
- `isDirectory=false` 不渲染这两项
- 点击触发对应回调

**`FileTree.test.tsx`**（新建，目前无覆盖）：

- `selectedDir='src'` 时工具栏 📄＋ 调 `createPath` 传 `'src/foo.ts'`
- `selectedDir='.'` 时工具栏 📄＋ 调 `createPath` 传 `'foo.ts'`
- tooltip 显示当前目标目录

### 手动验证（无单元测试可写）

**Monaco 中文化**：

- `pnpm build` 后检查 bundle 含中文 NLS 字符串（grep bundle 验证打包成功）
- 运行时断网验证：Monaco 全部 UI 中文 + 无网络请求（用户在 macOS 上 `pnpm dev`）

### 验收清单

- [ ] 文件树工具栏 📄＋/📁＋ 创建到 `selectedDir`
- [ ] 单击文件夹高亮选中 + 展开/折叠
- [ ] 文件夹右键菜单含「新建文件」「新建文件夹」
- [ ] Monaco 右键菜单中文
- [ ] Monaco F1 命令面板中文
- [ ] Monaco hover/错误提示中文
- [ ] Agent 在 IM 区创建文件后，切到 Files 视图立即可见
- [ ] 断网状态下 Monaco 全 UI 仍为中文
- [ ] `pnpm typecheck` 双 workspace 通过
- [ ] `pnpm test` 全套通过（renderer 105+ → 新增约 12 个测试）

---

## 影响范围汇总

### 改动文件

| 文件 | 改动类型 |
|---|---|
| `renderer/src/stores/file.store.ts` | 新增 `selectedDir` + `selectDir` + `renameSelectedDir` + `refreshAllCached` |
| `renderer/src/components/files/FileTree.tsx` | 工具栏读 `selectedDir`；订阅 `activeView` 触发刷新；tooltip |
| `renderer/src/components/files/FileTreeView.tsx` | 单击文件夹调 `selectDir`；高亮样式 |
| `renderer/src/components/files/FileContextMenu.tsx` | 新增「新建文件」「新建文件夹」按钮（仅目录） |
| `renderer/src/monaco-setup.ts` | 新文件：Monaco 本地加载 + 中文 NLS + worker 配置 |
| `renderer/src/main.tsx` | 顶部 import `./monaco-setup` |
| `renderer/vite.config.ts` | NLS alias + optimizeDeps |
| `renderer/package.json` | 加 `monaco-editor` + `monaco-editor-nls` devDep |
| `renderer/src/stores/file.store.test.ts` | 新增 6 个测试用例 |
| `renderer/src/components/files/FileContextMenu.test.tsx` | 新文件：3 个测试 |
| `renderer/src/components/files/FileTree.test.tsx` | 新文件：3 个测试 |

### 不改动

- `electron/` 全部（Monaco 是 renderer-only，文件 IPC 已支持任意路径）
- `CodeEditor.tsx` 的 `detectLanguage`、保存逻辑、tab 管理
- 现有 IM 组件、Agent 编排逻辑

---

## 开放问题

无。设计已与用户确认通过。
