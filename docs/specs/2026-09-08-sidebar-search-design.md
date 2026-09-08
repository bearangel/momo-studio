# 侧边栏搜索（会话 / 文件 / 看板）设计

- 日期：2026-09-08
- 状态：已评审通过（用户确认方案 B 与全部六节设计）
- 版本基线：v2.2.0-p1 之后
- 上游讨论：用户需求「会话、文件、看板需要支持搜索」

## 1. 背景与目标

三个侧边栏视图（im 会话 / files 文件 / tasks 看板）目前均无文本搜索能力：

- 会话列表 `RoomList` 只按 `lastMessageAt` 排序平铺，会话数随任务执行累积后难以定位
- 文件树 `FileTree` 懒加载目录，只能靠人工逐层展开找文件
- 看板 `TaskSidebarPanel` 只有 status / assignee / sort 三个下拉，无文本过滤

目标：为三个视图各内嵌一个搜索输入框，**输入即过滤**，帮助用户快速定位会话、文件、任务。

### 1.1 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 搜索深度 | 轻量过滤：会话搜标题、文件搜文件名、看板搜标题+描述 | YAGNI；全文搜索（FTS5/内容扫描）留待真实需求出现再做 |
| 交互形态 | 侧边栏内嵌过滤框（VS Code 树过滤式） | 与现有三视图侧边栏结构零冲突；全局命令面板工作量不成比例 |
| 架构方案 | 方案 B：renderer 内存过滤 + 主进程轻量 `file:searchNames` IPC | 每个域用最便宜的可用数据源；文件树懒加载缓存不完整，必须主进程扫描 |
| 匹配规则 | 大小写不敏感、子串包含；中文直接匹配 | 不做拼音 / 分词；个人桌面数据量下够用 |

### 1.2 非目标（明确不做）

- 会话消息内容全文搜索（FTS5 索引 `messages` 表）
- 文件内容搜索（grep 式扫描）
- 全局统一搜索面板（Ctrl+K）
- 搜索状态持久化（切视图 / 切 workspace 自然丢失）
- 搜索历史 / 高亮匹配片段

## 2. 总体架构

```
┌─ im 视图 ──────────────────┐   ┌─ tasks 视图 ──────────────┐   ┌─ files 视图 ─────────────────┐
│ RoomList                   │   │ TaskSidebarPanel          │   │ FileTree                     │
│  ┌───────────────────────┐ │   │  ┌──────────────────────┐ │   │  ┌────────────────────────┐  │
│  │ 🔍 搜索框              │ │   │  │ 🔍 搜索框             │ │   │  │ 🔍 搜索框               │  │
│  └───────────────────────┘ │   │  └──────────────────────┘ │   │  └────────────────────────┘  │
│  sessions.filter(title)    │   │  TaskFilters(含 text)      │   │  query 非空：扁平结果列表     │
│  （renderer 内存）          │   │  tasks.filter(title+desc)  │   │  query 空：FileTreeView 原样 │
│                            │   │  （renderer 内存）          │   │  （防抖 200ms → IPC）        │
└────────────────────────────┘   └───────────────────────────┘   └──────────────┬───────────────┘
                                                                                │ file:searchNames
                                                                ┌───────────────▼───────────────┐
                                                                │ 主进程 WorkspaceFS.searchNames │
                                                                │ 递归扫描 workspace 目录        │
                                                                └───────────────────────────────┘
```

匹配与状态规则（三域统一）：

- 大小写不敏感子串包含（两端 `toLowerCase()` 后比对）
- 空输入（含 trim 后为空）= 不过滤，恢复原视图
- 搜索状态为组件本地瞬态，不进 store 持久化、不跨视图共享

## 3. 会话搜索（im 视图）

**改动文件**：`renderer/src/components/im/RoomList.tsx`

- `RoomList` 顶部（列表滚动区外）加一行搜索框：`Search` lucide 图标（16px / stroke 1.75）+ 受控 input + 有值时显示清除按钮（`X` 图标）
- `const [filter, setFilter] = useState('')`；渲染列表 = `sessions.filter(s => s.title.toLowerCase().includes(q))`
- 过滤后为空 → 空态文案「无匹配会话」（与现有「暂无会话」空态区分；不显示刷新按钮）
- 过滤只影响渲染列表：选中会话、重命名 / 解散悬停操作、实时推送（`receiveMessage` 重排）不受影响
- 样式走语义 token（`bg-surface-*` / `text-secondary` 等），禁 emoji 图标

## 4. 看板搜索（tasks 视图）

**改动文件**：`renderer/src/components/task-board/TaskFilters.tsx`、`TaskSidebarPanel.tsx`、`TaskList.tsx`

- `FilterState` 加 `text: string` 字段；`TaskFilters` 在 status / assignee 下拉**之前**渲染文本输入框，onChange 更新 `text`（受控组件，与现有三下拉同模式）
- `TaskSidebarPanel.filteredTasks` 在现有 status / assignee 过滤上 **AND 叠加**：

  ```ts
  list = list.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q),
  );
  ```

- `TaskRow.title` 与 `TaskRow.description` 均为非空 string（types.d.ts 契约），无需空值防御
- `TaskList` 加可选 prop `emptyText?: string`：过滤无结果时 `TaskSidebarPanel` 传「无匹配任务」，默认仍「暂无任务」
- 排序、排队名次（queueRanks）、远端节点只读分区均不改动

## 5. 文件搜索（files 视图）

唯一的跨进程改动。按 `momo-boundary-rules` 执行 IPC 契约变更：双端类型对齐 + preload 接线 + 两 workspace typecheck。

### 5.1 主进程

**`electron/src/main/files/workspace-fs.ts`** — 新增方法与类型：

```ts
/** 文件名搜索命中项（file:searchNames 返回行） */
export interface SearchHit {
  /** 相对 workspace 根的全路径（含目录前缀，'/' 分隔） */
  path: string;
  isDirectory: boolean;
}

// WorkspaceFS 类内
async searchNames(query: string, limit = 200): Promise<SearchHit[]>
```

实现约束：

- 从 workspace 根递归遍历（`fs.promises.readdir(dir, { withFileTypes: true })`）
- **排除条目**：名称以 `.git` 前缀开头（小写比较，作用于文件与目录，与 `listDir` 现有规则一致）或等于 `node_modules`；其余目录（含其他隐藏目录）均进入
- **符号链接目录不进入**（`dirent.isDirectory()` 为 false 的 symlink 不递归），防环防逃逸；但符号链接文件可作普通条目匹配
- 匹配对象 = 条目名（basename，不含目录前缀），大小写不敏感子串；命中即收集，目录本身也参与匹配
- **双上限**：结果条数 `limit`（默认 200）+ 遍历条目总数 10,000（防病态深目录拖死主进程），任一达上限即停止遍历返回已有结果
- 返回顺序不做规定（renderer 不依赖顺序语义）

**`electron/src/main/files/ipc.handlers.ts`** — `registerFileHandlers` 内新增：

```ts
ipcMain.handle(
  'file:searchNames',
  async (_evt, workspaceId: string, query: string) => {
    const wsFs = getWorkspaceFs(workspaceId);
    return wsFs.searchNames(query);
  },
);
```

复用 `getWorkspaceFs` 实例缓存；`query` 由 renderer 保证 trim 非空才调用（主进程仍对空串返回 `[]` 短路）。

### 5.2 IPC 契约（双端对齐）

**`renderer/src/ipc/types.d.ts`**：

- `SearchHit` 接口（注释注明「与 electron 端 workspace-fs.ts 的 SearchHit 对齐（跨进程独立定义，仅结构对齐）」，仿 `DirEntry` 现有模式）
- `FileApiSurface` 加方法：`searchNames(workspaceId: string, query: string): Promise<SearchHit[]>`

**`electron/src/preload/index.ts`**：加 `file:searchNames` 绑定（照抄现有 `file:list` 三行模式）。

### 5.3 renderer（`renderer/src/components/files/FileTree.tsx`）

- 工具条（刷新 / 折叠 / 新建）下方加搜索框（样式规范同 §3）
- **本地 state**：`query: string`、`results: SearchHit[]`、`searching: boolean`、`searchError: string | null`
- **防抖 + 竞态守卫**：`useEffect` 监听 query，trim 后非空时 200ms 定时器触发 IPC；组件内 `useRef` 持有递增请求序号，响应返回时序号不匹配则丢弃（旧响应不覆盖新结果；卸载时清理定时器）
- **视图切换**：query（trim 后）非空 → 主体渲染扁平结果列表（替代 `FileTreeView`）：
  - 每行：`FileText` / `Folder` lucide 图标（16px / stroke 1.75）+ 条目名 + 父目录路径（`text-tertiary` 小字）
  - 文件行点击 → 既有 `onSelectFile(path)` 打开编辑器；目录行点击无操作（不可展开）
  - 结果为空 → 「无匹配文件」
  - 结果达 200 条上限 → 列表尾部一行「已显示前 200 条匹配」（`text-tertiary`）
- query 清空 → 立即恢复 `FileTreeView` 原样（树缓存与展开态未动，天然无损恢复）
- `name` 属性由 renderer 从 `path` 最后一段派生，IPC 不重复传

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `file:searchNames` IPC 失败（workspace 不存在 / 磁盘错误） | 结果清空 + `searchError` 置中文文案，搜索框下方一行 `text-status-error` 提示；不弹窗、不阻塞树视图（query 清空即消失） |
| query trim 后为空 | 不发 IPC，恢复树视图 |
| 快速连续输入 | 防抖合并 + 竞态守卫，最终结果只对应最后一次 query |
| 会话 / 看板过滤 | 纯内存操作，无失败路径 |
| 看板搜索完整性 | 受 `task.store.load` 的 500 条截断约束（既有行为，非本次引入；个人桌面场景基本碰不到） |
| 文件搜索噪音 | 硬编码排除 `.git*` / `node_modules`；不解析 `.gitignore`（解析成本与维护复杂度不成比例，明确非目标） |
| 切视图 / 切 workspace | 搜索状态随组件卸载自然丢失，无残留 |

## 7. 测试计划

### 7.1 electron 单测（`electron/tests/files/`，镜像 `src/` 结构）

`workspace-fs` 搜索用例（临时目录构造）：

1. 嵌套目录中的文件按名命中，`path` 含目录前缀
2. 大小写不敏感（query 小写命中大写文件名）
3. 子串包含（非前缀匹配）
4. 目录名命中返回 `isDirectory: true`
5. `.git*` 前缀排除规则与 `listDir` 完全一致（`.git` 目录不进入；`.gitignore` 等前缀条目同样不返回——文件树本就不显示它们，搜索结果与树可见性保持一致）
6. `node_modules` 目录不进入
7. 符号链接目录不递归进入；无环死循环
8. limit 截断（构造超限文件数）
9. 遍历总数上限触发时安全返回
10. 空 query 返回 `[]`

`ipc.handlers` 测试扩展：`file:searchNames` 通道注册 + 参数透传到 `searchNames`（仿现有 handler 测试模式）。

### 7.2 renderer 单测（贴源 colocated）

- `RoomList.test.tsx` 扩展：输入过滤命中 / 无匹配空态「无匹配会话」/ 清除后恢复全量
- `TaskFilters.test.tsx` 扩展：`text` 输入受控 onChange 进 `FilterState`
- `TaskSidebarPanel` 过滤链路：text 与 status AND 叠加、title / description 双字段命中（组件级或抽出纯函数均可，以最小 mock 保真为准——遵循 `momo-test-rules`，mock 不得简化掉 store 订阅语义）
- `TaskList`：`emptyText` prop 生效
- `FileTree.test.tsx` 扩展：防抖触发（vi fake timers）、结果渲染、文件行点击回调 `onSelectFile`、清空恢复树、错误态文案

### 7.3 验收标准

- `npx pnpm@9.0.0 typecheck` 双 workspace clean
- `npx pnpm@9.0.0 test`（electron + renderer）全绿
- 手动冒烟（macOS 主机，非阻塞 CI）：三视图各输入关键词确认过滤 / 恢复行为

## 8. 实施切片建议（供 writing-plans 展开）

1. 主进程：`WorkspaceFS.searchNames` + 单测
2. IPC 契约：handler + types.d.ts + preload + 两 workspace typecheck
3. renderer 文件搜索：`FileTree` 搜索框 + 结果列表 + 竞态守卫 + 单测
4. renderer 会话搜索：`RoomList` 过滤框 + 单测
5. renderer 看板搜索：`FilterState.text` + `TaskSidebarPanel` 叠加 + `TaskList.emptyText` + 单测

切片 1→2→3 有依赖；4、5 与 1-3 完全并行。
