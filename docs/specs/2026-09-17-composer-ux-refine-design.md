# 会话输入框交互精简（v2.11.1）设计

- 日期：2026-09-17
- 状态：已批准（方案 A + 📎 框内左下角）
- 上游：`docs/specs/2026-09-16-composer-context-system-design.md`（v2.11 上下文系统）
- 范围：**仅 renderer 交互层**——主进程 / IPC / 落库 / context 展开链路零改动

## 1. 背景与主机验收反馈

v2.11 输入框上下文系统主机实测三条反馈：

| # | 反馈 | 根因 |
|---|---|---|
| F1 | `/` 可过滤命令但无法过滤技能，技能多只能拖滚动条 | 触发正则 `\/([A-Za-z0-9-]*)$` 字符集不含中文——预置技能名即中文（代码审查等），敲中文菜单即关；`@` / `#` 同病（中文名敲不进触发态） |
| F2 | 📎 点击只插 `@/` 文本，菜单不出现，须手敲字符；`@/` 独立语法多一种交互心智（opencode：agent 与文件统一 `@`） | (a) 空 query 时主进程 `searchNames` 固定返回 `[]`，菜单渲染条件 `fileHits.length > 0` 永假；(b) `@/` 是与 `@agent` 分离的第二触发语法（v2.11 D4 设计，实测推翻） |
| F3 | @agent / @文件 / 技能的 chips 显示在输入框顶部工具条，交互不友好（Kimi：chips 在输入框内部整体呈现） | chips 行渲染在 textarea 边框外上方，与独立 InputToolbar 条形成三层堆叠 |

## 2. 设计决策

- **D-A（F1）**：`/`、`@`、`#` 三触发捕获字符集从 `[A-Za-z0-9-]` 放宽为非空白字符集——中文名直接进入过滤。命令分支保留整串锚定与 `//` 转义语义；`@` 分支含 `/`（统一文件触发的前置条件）；`#` 分支与 `@` 互斥。
- **D-B（F2）**：移除 `@/` 独立语法，`@` 单触发统一菜单（opencode 式）：同一浮层 agent 组 + 文件组，同一查询词双源过滤，分组消歧。📎 点击直接打开菜单，空查询文件组显示根目录默认列表。
- **D-C（F3）**：输入区改单一容器框（Kimi 式）：textarea 无边框置顶，chips 行框内底部（换行 + 限高滚动），📎 框内左下角；成员 / 新建任务保留框外上方独立条（会话级操作）。

## 3. 改动明细

### 3.1 触发正则放宽（`MentionInput.detectTrigger` / `insertMention`）

| 分支 | 现正则 | 新正则 | 语义保持点 |
|---|---|---|---|
| 命令 | `^\/([A-Za-z0-9-]*)$` | `^\/([^\s/]*)$` | 整串锚定（句中 `/` 不触发）；`//` 转义不触发（第二 `/` 不在字符集） |
| @ 统一 | `(?:^|\s)@([A-Za-z0-9-]*)$` | `(?:^|\s)@([^\s#]*)$` | 含 `/`（文件路径）与中文（agent 名）；`#` 互斥排除 |
| 任务 | `(?:^|\s)#([A-Za-z0-9-]*)$` | `(?:^|\s)#([^\s@]*)$` | `@` 互斥排除 |

- `insertMention` / `selectFile` 的局部替换正则字符集同步放宽（否则选不中局部输入）。
- 过滤逻辑零改动（`includes` 本就支持中文）。
- 预置技能：`/代码` 命中「代码审查」（name）；`/review` 命中 slug `code-review`。

### 3.2 `@` 统一菜单（移除 `@/`）

- **状态收敛**：删 `fileMode` / `fileQuery` 双轨态；`@` 触发时 `query` 单源双用——agent 组本地过滤（`filteredMembers`）+ 文件组防抖搜索（`searchNames`，FILE_SEARCH_DEBOUNCE_MS 不变）。
- **菜单结构**：同一浮层两组，agent 组在前文件组在后；任一组有命中即渲染；标题行「选择要 @ 的 agent / 引用文件」。
- **选择行为**：
  - agent：`insertMention('@名字')`，`pendingMentions` 不变；
  - 文件：插 `@{path}`（无 `/` 前缀，与 agent 同形），`pendingFiles` 结构不变；替换正则放宽后 `@路径局部` 可选中。
- **📎 点击**（`fileTriggerTick` 效果重写）：聚焦 + 若光标前无 `@` 局部态则追加 `@`（空格防粘连规则不变）+ 打开菜单。**空查询默认列表**：`@` 菜单空查询即显示（📎 与手敲 `@` 同一行为）——`ipc.file.list(workspaceId, '.')` 过滤出文件（`isDirectory === false`）截 8 条（FILE_MENU_LIMIT）作为文件组初始值；用户输入即切搜索结果。不动主进程 `searchNames`（FileTree 零影响）。
- **正文标记**：文件标记 `@src/foo.ts` 纯展示（mentions / context 均结构化，不解析正文）；`@path` 与 agent 名撞串时由 `<user-context>` 文件块与结构化 mentions 消解，无下游解析风险。

### 3.3 Kimi 式输入容器

```
框外上方（保留）：[成员] [新建任务]          ← InputToolbar（📎 移除）
框外提示：readOnly 提示 / commandHint
┌─────────────────────────────┐ ← 单一容器：rounded-lg border
│ textarea（透明无边框，rows≥2）│    bg-surface-2，focus-within
│                             │    态 border-focus 上移容器
│ [📎] [chips···wrap 限高滚动] │ ← 框内底行：📎 左下 + chips 行
└─────────────────────────────┘
```

- chips 行：`pendingMentions` / `pendingSkills` / `pendingFiles` 三类混排（现样式 token 不变），`flex-wrap` + `max-h-24 overflow-y-auto`，空则整行收起（📎 独占底行仍渲染）。
- 📎：`IconButton` ghost 形态入框内底行左侧；`fileTriggerTick` 信号机制不变。
- 发送仍为 Enter（无发送按钮，维持现状）。
- 视觉细节（间距 / token / focus 态）实现时遵循 `docs/dev/design-system.md`，只用语义 token。

## 4. 兼容性

- **旧消息**：正文 `@/path` 标记是纯文本展示，不解析；chips 走 `context_json` 结构化数据，零迁移。
- **主进程**：零改动（`searchNames` / `file.list` / IPC / 落库 / 展开全不动）。
- **FileTree**：`searchNames` 语义不变，零影响。

## 5. 测试策略

- **renderer 单测**（`MentionInput.test.tsx` 重写触发流用例）：
  - 正则放宽：`/代码` 过滤技能命中、`@中文名` 过滤 agent、`#中文` 过滤任务、`//` 转义与句中 `/` 不触发保持；
  - `@` 统一：同 query 双组渲染、agent/文件选择各自插标与登记、`@路径局部` 替换；
  - 📎：点击直接开菜单 + 空查询默认列表（mock `file.list`）+ 输入后切搜索；
  - chips：框内渲染、三类混排、限高滚动（类断言）、移除交互不回归。
- **e2e**（`composer-context.spec.ts` 触发流更新）：`@` 统一选文件 → 发送 → 气泡 chip 全链路。
- 回归面：`InputToolbar.test.tsx`（📎 移除断言更新）；发送失败恢复 / 会话切换清空等既有用例不动。
