# 会话消息渲染优化设计（v2.1 会话 UI 打磨）

- **日期**：2026-09-06
- **状态**：已确认（用户 2026-09-06 拍板，待实施）
- **范围**：renderer 会话消息渲染层（工具调用卡片 / markdown 表格 / 代码块 / 会话体验细节）
- **上游输入**：用户三项抱怨 + 业界调研（sst/opencode `7c2199d`、charmbracelet/crush `35a7bca`、gemini-cli `85aca16`、open-webui `0a7c158`、assistant-ui / Vercel ai-elements / Dify 的 shiki 迁移记录）

## 1. 背景与问题

会话回复中文本显示不友好，用户提出三项抱怨，代码勘察全部定位：

| # | 抱怨 | 根因 |
|---|---|---|
| 1 | 工具调用展开显示 `参数: { "path": "." }` 之类的参数 JSON，是噪音 | `ToolCallChip` 展开面板同时渲染参数 JSON 与结果 |
| 2 | 表格边框看不出是表格 | `.md-body table` 边框用 `--border-subtle`（#1f2023），画在 `--surface-2`（#181a1f）气泡上对比度趋近于零 |
| 3 | 代码没有代码展示工具的形态 | `ReactMarkdown` 裸渲染：无语法高亮、无语言标签、无复制（本轮用户明确不要复制按钮） |

勘察额外发现（一并修复）：

- **链接拦截缺口**：`SafeAnchor` 只接在 `MessageBubble`（静态气泡）；`AgentStreamBubble` / `SubAgentSection` / `ThinkingSection` 三处流式渲染漏接，恶意 markdown 链接可走浏览器默认行为（S2 安全要求全调用点拦截）
- **md-body 排版缺口**：无 h1–h4 / ul / ol / img / hr 样式——agent 输出 `# 标题` 时用浏览器默认 2em 巨大字号撑爆气泡
- `ThinkingSection` 流式无任何视觉反馈（`void isStreaming` 占位）
- 消息无时间戳、无消息级复制；工具错误原文多行渲染易撑爆布局

## 2. 目标 / 非目标

**目标**：消息渲染收敛到单一组件入口；工具调用「摘要行 + 结果优先」；表格 / 代码块达到业界 agent 工具的默认观感；七项体验增强落地。

**非目标（明确不做）**：

- 代码块复制按钮、行号（用户拍板不要；opencode 聊天正文路径同样无行号）
- opencode 式 worker + `@shikijs/stream` 增量 tokenize 流式高亮架构（调研 Tier 3，卡顿实测出现前不投入）
- turn footer 元信息行（Agent · Model · 42s）、上下文压缩分隔线、MCP determinate 进度条
- 渲染层以外的改动（stream-aggregator 聚合契约、IPC、存储均不动）

## 3. 用户决策记录（2026-09-06）

经可视化对比（mockup 用真实暗色 token 渲染）逐项拍板：

| 决策点 | 选择 |
|---|---|
| 工具调用卡片 | **A · 摘要行 + 结果优先**：折叠行 = 工具名 + 按工具提炼的关键参数；展开只看结果，参数收进次级开关 |
| 表格 | **A · 全边框网格**：`--border-strong` 全边框 + 表头填充 `--surface-3`（注：opencode 用横向发丝线，本设计尊重用户「辨识度优先」偏好，同时吸收其工程细节） |
| 代码块 | **A · GitHub 式**：语言标签行 + 语法高亮，**不带复制按钮** |
| 其他优化项 | 全选：只读工具分组合并 / 结果 10 行折叠 / 思考区流式动画 + 高度上限 / 消息时间戳 / 错误展示优化 / 消息级复制按钮 |
| 自定义补充 | 子 agent 嵌套区背景与主气泡区分，**对比度不要过强** |
| 实现路径 | **方案二 · 收敛共享 MarkdownBody**（放弃各组件原地小修的方案一） |

## 4. 详细设计

### 4.1 共享渲染层

**新组件 `renderer/src/components/im/MarkdownBody.tsx`**：

- `react-markdown` + `remark-gfm`，统一 `components` 映射：
  - `a` → `SafeAnchor`（从 `MessageBubble` 迁出共用，四处调用点全部生效，堵住安全缺口）
  - `code` / `pre` → 新组件 `CodeBlock`（见 4.2）
  - `table` → 外包 `<div class="md-table-wrap">`（`overflow-x: auto`）横向滚动容器
- Props：`{ children: string; deferHighlight?: boolean }`；`deferHighlight=true` 时代码块退化为纯文本 `<pre>`（流式性能保护，见 4.2）
- 四处调用点机械替换：`MessageBubble` / `AgentStreamBubble`（text 段）/ `SubAgentSection`（text 段）/ `ThinkingSection`
- 行内/块级 code 判定：react-markdown v10 已移除 `code` 组件的 `inline` prop——通过 HAST 节点父级是否为 `pre` 判定，禁止 `className.includes('language-')` 式误判（无语言标注的围栏代码块会被错判为行内）

**`SafeAnchor` 迁移**：`MessageBubble.tsx` 内的私有实现迁至 `MarkdownBody.tsx` 导出，`MessageBubble` 改为引用（行为不变，归属渲染层）。

### 4.2 代码块（CodeBlock 组件 + shiki）

**新组件 `renderer/src/components/im/CodeBlock.tsx`**：

- 结构（对应决策「GitHub 式、无复制」）：

  ```
  ┌─ 边框 --border-strong，圆角 8px ────────────┐
  │ ts · · · · · · · · · · · · · · (语言标签行)  │  ← surface-1 底，11px tertiary 等宽
  │ <语法高亮代码体>                             │  ← github-dark / github-light
  └──────────────────────────────────────────────┘
  ```

- 无语言标注的围栏代码块：不渲染标签行，代码体纯文本渲染（无语言即无高亮可做）
- **shell 降饱和**：`bash` / `sh` / `zsh` / `shell` / `console` 围栏**不做语法高亮**，代码体用 `text-secondary` 单色渲染——终端输出不是源码，不与正文代码争夺视觉权重（opencode 同款判断）

**shiki 集成**（调研结论：`react-syntax-highlighter` 已被 assistant-ui 标记废弃、Vercel ai-elements / Dify 先后移除；`rehype-highlight` 语法精度低且无组件定制挂点）：

- 依赖 `shiki`（v3，`shiki/core` 入口 + `createJavaScriptRegexEngine` JS RegExp 引擎——不引 Oniguruma WASM，渲染进程免 WASM 初始化）
- highlighter **单例惰性创建**；语言按需 `import('shiki/langs/<lang>.mjs')` 动态加载（Vite 自动分包），首块代码到达才初始化
- 语言白名单（映射 + 降级）：`typescript` `tsx` `javascript` `jsx` `json` `css` `html` `python` `go` `rust` `sql` `yaml` `markdown` `bash` `sh` `shell` `console`（后四类走降饱和路径）；围栏语言不在白名单 → 纯文本渲染，不报错
- **双主题一次渲染**：`codeToHtml` 传 `themes: { light: 'github-light', dark: 'github-dark' }`，靠 shiki 输出的 CSS 变量（`--shiki-dark` 系列）+ `.dark` 作用域切换，主题切换**不触发重新高亮**
- **流式不实时高亮**：`AgentStreamBubble` / `SubAgentSection` 在 `isStreaming && isLastSegment` 的 text 段传 `deferHighlight`；`ThinkingSection` 展开内容同理。流式期间代码块纯文本，段稳定（流结束 / 非末段）后恢复高亮

### 4.3 工具调用卡片（ToolCallChip 重写）

**折叠行（摘要行）**——`renderer/src/lib/describe-tool-call.ts` 纯函数：

```
[状态图标] [工具名·等宽] [关键参数摘要·tertiary] …… [耗时] [chevron]
```

- 工具名映射（同构 opencode `getToolInfo`）：

  | 工具 | 摘要取值 | 例 |
  |---|---|---|
  | `read_file` / `write_file` / `edit_file` | 路径**仅文件名**（全路径毁掉单行 chip） | `read_file · app.ts` |
  | `bash` | 命令首行，超长截断 | `bash · git status` |
  | `grep` | pattern + 可选 path | `grep · "useState" in src/` |
  | `glob` | pattern | `glob · **/*.test.ts` |
  | 其他 / `mcp:*` | 按优先级键 `description > query > url > filePath > path > pattern > name` 取第一个非空字符串值 | `mcp:github · create_issue` |

- 未知工具除主摘要外最多补 **2 个** `k=v` 标量参数（主摘要用过的键不重复）
- 状态图标沿用 lucide（执行中 Loader2 旋转 / 成功 CircleCheck / 失败 CircleX），16px / stroke 1.75 规范不变

**展开面板（结果优先）**：

- 面板内容 = **仅工具结果**：等宽 11px、`surface-1` 底、`border-strong` 边框、行高 1.55
- **10 行折叠**：结果超过 10 行显示前 10 行 + 「展开剩余 N 行」条（点击全量展开），替代现在的 `max-h-[300px]` 滚动
- **次级「参数」开关**：面板底部小字 `▸ 参数`，默认收起，点击展开参数 JSON（排查通道保留，默认不打扰）

**连续只读工具分组合并**——`renderer/src/lib/group-segments.ts` 纯渲染层辅助函数：

- 输入 `StreamSegment[]`，把**连续 ≥ 2 个**只读工具段（`read_file` / `glob` / `grep` / `list_files`）合并为 `{ kind: 'context-group', items }`（单个不合并，照旧独立 chip）
- 分组 chip 折叠行：`✓ 收集上下文 · 3 次读取 · 1 次搜索 · 耗时`；展开后每条**单行摘要**（describeToolCall 输出），无嵌套手风琴、无结果体
- **纯渲染层实现**，`AgentStreamBubble` / `SubAgentSection` 渲染前过一遍该函数；stream-aggregator 聚合契约不动（重启一致性路径零风险）
- `todowrite` 工具调用不再单独渲染 chip（TodoSection 已展示，双份冗余）——在该函数中一并过滤

**错误态**：

- 失败 chip 错误结果在展开面板**压平为单行**（换行→空格，`title` 属性悬浮看全文），不再多行撑爆布局
- 「用户拒绝 / permission denied」类失败降级为 warning 黄 tone（不再是满红 ERROR）——权限拒绝是用户意志，不是故障

### 4.4 md-body 样式清单（globals.css）

| 元素 | 规则 |
|---|---|
| `table` | 全边框 `--border-strong`；表头填充 `--surface-3` + `font-weight:600`；单元格 `padding: 6px 12px`、`text-align: start`、`vertical-align: top`；外层 `.md-table-wrap` 横向滚动 |
| `pre`（CodeBlock 接管前兜底） | 保持现状灰底，双轨过渡期防裸露 |
| 行内 code | 保持现状（`surface-2` 底 + `border-subtle` + 圆角） |
| `h1–h4` | 气泡内克制尺寸：h1 15px → h4 13px，全部 `font-weight:600`、上下 margin 8/4（消灭浏览器默认 2em） |
| `ul` / `ol` | `margin: 4px 0 8px`、`padding-left: 20px`、行高 1.7 |
| `img` | `max-width: 100%` + 圆角 6px |
| `hr` | `border-subtle` |
| `a` / `blockquote` | 保持现状 |

全部走语义 token，符合 v2.1 设计系统（禁硬编码色值 / Tailwind 默认色阶）。

### 4.5 会话体验增强

1. **消息时间戳**：`ImMessage.createdAt` 格式化 `HH:mm`，11px `text-tertiary`；agent 消息显示在名字行旁，自己消息显示在气泡外侧（左右对齐随气泡）
2. **消息级复制**：流式结束（status ≠ streaming）后 hover 气泡出现「复制」小按钮（气泡 footer 区右缘，`opacity` 过渡）；复制整条回复 markdown 源文（`message.body`）；`onMouseDown` `preventDefault` 保护选区；2s「已复制」状态反馈。代码块复制按钮不做（用户决策），两者互不影响
3. **思考区**：执行中折叠条加微光动画（CSS keyframes，violet tint 上呼吸式 opacity）；展开内容高度封顶约 10 行（`max-height: 220px` 内部滚动）。思考耗时显示**本轮不做**——聚合层 segments 不携带时间戳，扩展聚合契约超出本轮范围（YAGNI）
4. **子 agent 区分（低对比度）**：`SubAgentSection` 容器加 `bg-surface-1`（比气泡 `--surface-2` 深一档）+ 圆角右侧 + 保留既有 `border-l-2 border-strong` 左竖线——嵌套可辨识、对比度克制
5. 流式消息链接拦截补齐（§4.1 MarkdownBody 全调用点生效，归入渲染层而非单独修补）

### 4.6 涉及文件

**新增**：

- `renderer/src/components/im/MarkdownBody.tsx`（含 SafeAnchor 迁入）
- `renderer/src/components/im/CodeBlock.tsx`
- `renderer/src/lib/describe-tool-call.ts`
- `renderer/src/lib/group-segments.ts`
- 上述四者的 colocated 测试文件

**修改**：

- `renderer/src/components/im/ToolCallChip.tsx`（重写：摘要行 + 结果优先 + 10 行折叠 + 次级参数 + 错误单行化 + warning 降级）
- `renderer/src/components/im/AgentStreamBubble.tsx`（接 MarkdownBody / groupSegments / deferHighlight / 复制按钮）
- `renderer/src/components/im/SubAgentSection.tsx`（同上 + `bg-surface-1` 区分）
- `renderer/src/components/im/ThinkingSection.tsx`（接 MarkdownBody + 动画 + 高度上限）
- `renderer/src/components/im/MessageBubble.tsx`（SafeAnchor 改引用 MarkdownBody；时间戳经 MessageFrame）
- `renderer/src/components/im/MessageFrame.tsx`（名字行时间戳槽位）
- `renderer/src/styles/globals.css`（§4.4 清单）
- `renderer/package.json`（+ `shiki`）

**不动**：electron 主进程、`stream-aggregator.ts`、`stream.store.ts`、IPC 契约、DispatchChip / TodoSection / TaskReplyCard。

## 5. 测试计划

| 层 | 内容 |
|---|---|
| 单测（colocated） | `describe-tool-call.test.ts`：每工具映射 + 优先级键回退 + 截断 + k=v 上限；`group-segments.test.ts`：连续合并 / 单个不合并 / 非只读打断 / todowrite 过滤 / 与 thinking/text 段交错；`MarkdownBody.test.tsx`：语言标签渲染、无语言围栏、行内 code 不误判、表格滚动容器、SafeAnchor `preventDefault`；`CodeBlock.test.tsx`：shell 降饱和、白名单外语言降级纯文本、deferHighlight 纯文本 |
| 组件测试（更新） | `ToolCallChip.test.tsx` 重写（摘要行 / 展开仅结果 / 10 行折叠 / 次级参数开关 / 错误单行 title / 拒绝降级 warning）；`AgentStreamBubble.test.tsx` + `MessageBubble.test.tsx` 适配（分组渲染 + SafeAnchor 全调用点 + 时间戳 + 复制按钮出现条件） |
| 回归锁 | 现有 MessageList / stream-aggregator / restart-consistency 测试**必须零改动通过**（渲染层收敛不动聚合与存储，动了就是越界） |
| 验收命令 | `npx pnpm@9.0.0 typecheck`（双 workspace）+ `npx pnpm@9.0.0 --filter momo-studio-renderer test`；electron workspace 不受影响但全量跑一遍 |

## 6. DoD

1. 三个原始抱怨点肉眼可验：工具展开无参数 JSON、表格一眼是表格、代码块带语言标签与语法高亮
2. 流式消息内链接点击被 SafeAnchor 拦截（与静态消息行为一致）
3. 暗色 / 明色主题切换代码高亮正确跟随，无需刷新
4. typecheck 双 clean；renderer 测试全绿（含新增）；electron 测试全绿（零改动）；现有回归锁零改动通过
5. 长会话（大量工具调用 + 多代码块）滚动无明显卡顿（流式期间不高亮的保护生效）

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| shiki 动态 import 分包后首块高亮闪烁 | highlighter 单例 + Promise 缓存；未就绪期间渲染纯文本，就绪后高亮（与 deferHighlight 同路径，无专门 loading态） |
| `md-table-wrap` 改变 DOM 结构影响现有测试 | 现有 md-body 相关断言逐条过一遍，仅气泡内表格样式变化，列表级测试不涉及 |
| group-segments 漏掉某类段导致渲染缺段 | 类型上穷举 `StreamSegment['kind']`（switch exhaustive），编译期兜底 |
| `.dark` 作用域与 shiki CSS 变量命名冲突 | shiki 双主题输出变量名固定（`--shiki-dark-*`），作用域限定 `.md-body pre` 内 |
