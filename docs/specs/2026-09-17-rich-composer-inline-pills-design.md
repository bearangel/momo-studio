# 内联 Pill 富输入块（RichComposer）设计

- 日期：2026-09-17
- 状态：已批准（交互模型 A 内联 pill + 样式 A 填充底色式 + 命令 pill 无前缀图标）
- 上游：`docs/specs/2026-09-16-composer-context-system-design.md`（v2.11 上下文系统）、`docs/specs/2026-09-17-composer-ux-refine-design.md`（v2.11.1 @ 统一菜单——本设计取代其 §3.3 容器方案的 chip 行部分）
- 范围：**仅 renderer 交互层**——IPC 契约 / 主进程 / 落库 / context 展开 / MessageBubble 零改动

## 1. 背景与决策链

主机验收第三轮反馈：v2.11.1 把 chips 移到输入框容器内底部，但仍与正文割裂（像独立工具条）。目标交互（视觉伴侣确认）：**@ / # / 引入的技能、任务、指令、文件全部成为输入框文字流里的内联原子块（pill）**——光标处插入、随文字流动、整体一个文本块，无任何独立工具行（opencode / Claude / Slack 式）。

三项已确认决策：

- **D-1 交互模型**：内联 pill（contentEditable 富输入块替换 textarea）
- **D-2 视觉样式**：填充底色式——每类内容一种淡色底（agent 蓝 / 文件中性 / 技能紫 / 命令橙 / 任务绿），token 落设计系统语义色
- **D-3 命令 pill 无前缀图标**：显示 `/compact`，斜杠本身即前缀标识；`⌗`/终端图标仅用于菜单列表区分命令组与技能组

## 2. 架构

```
MentionInput（保留：菜单触发逻辑 / @ 双源搜索 / 📎 / 发送 / 草稿 / 只读）
 └─ RichComposer（新组件，替换 <textarea>）
     contentEditable div
       ├─ 文字节点（正常输入，IME 组字保护）
       └─ pill span（contenteditable="false" 原子块）
            data-kind ∈ {agent,file,task,skill,command}
            data-id（instanceId / path / taskId / slug / name）
            data-label（显示文本）
```

- pill 是 `contenteditable="false"` 的内联 `<span>`——浏览器天然把光标移动按原子块处理
- 每类 pill 一种语义底色（D-2），图标沿用 lucide（Bot/FileText/Zap/Terminal/Pin 12px），命令 pill 无图标（D-3）
- 序列化与反序列化只发生在**边界**：发送提取（DOM → segments → body+context）、草稿存取（segments JSON）

## 3. 序列化规则（发送边界）

编辑态内 pill 与文字平权混排；发送时一次遍历提取：

| pill | 显示 | 进正文 body | 进结构化数据 |
|---|---|---|---|
| agent | `@coder`（蓝底） | `@coder` | `mentionedInstanceIds[]` |
| 文件 | `▤ src/a.ts`（中性底） | `@src/a.ts` | `context.files[]`（按 path 去重） |
| 任务 | `#T-3 修复登录`（绿底） | `#T-3`（完整任务 id，与现有 `#${t.id}` 标记一致） | 无——conflict-detector 照旧解析正文 |
| 技能 | `⚡ 代码审查`（紫底） | **不进正文**（v2.11 语义：展开块由主进程注入 `<user-context>`，防双重曝光；气泡侧由 context chip 呈现） | `context.skills[]`（按 slug 去重） |
| 命令 | `/compact`（橙底，无图标） | `/compact` | 无——**整串拦截语义原样保留**：composer 仅含命令 pill（序列化恰为 `/^\/[A-Za-z0-9-]+$/`）时走 session.store 本地命令执行；混排则当普通消息发送 |

- **IPC 契约不变**：`sendMessage(body, mentionedInstanceIds, context)` 三参形状与含义照旧
- 同一 pill 重复插入：body 保留全部出现（等价手敲两遍），结构化数组去重
- 空 body + 仅技能/文件 pill：合法发送（v2.11 §7.1 语义保持——序列化后 hasContext 判定）

## 4. 交互细节

### 4.1 触发与插入（复用 v2.11.1 全部菜单逻辑）

- `@`（agent+文件双源）/ `/`（命令+技能）/ `#`（任务）触发正则、中文过滤、空查询默认列表、📎 直开——全部复用现有实现
- 菜单选中：在光标处把刚敲的局部输入（`@xx` / `/xx` / `#xx` 文字节点片段）替换为原子 pill，光标落到 pill 之后
- 📎 保留在框内左下角（v2.11.1 F3 布局不变）

### 4.2 原子编辑

- `←/→`：浏览器原生跳过 contenteditable=false 原子块
- Backspace 靠近 pill：先高亮（selected 态），再按一次整块删除（两段式防误触）
- 点击 pill：高亮选中态；Delete 键删除高亮 pill
- pill 之间/前后可继续输入任意文字（含中文）

### 4.3 IME 组字保护

`compositionstart` 至 `compositionend` 期间：不跑 detectTrigger、不操纵 DOM、Enter 不发送（isComposing/keyCode 229 现有判定保留）。

### 4.4 草稿 / 失败恢复 / 只读

- 会话草稿：`draftsRef` 存 segments JSON（`Array<TextSeg | PillSeg>`），切回原样重建（替代纯文本草稿——pill 不丢）
- 发送失败：恢复发送前 segments 快照
- 只读/无会话：contentEditable 置 `contenteditable=false` + 样式禁用态；placeholder 用 `:empty::before` 内容实现

## 5. 组件与文件结构

| 文件 | 职责 |
|---|---|
| `renderer/src/components/im/RichComposer.tsx`（新） | contentEditable 编辑面：pill 插入/删除/高亮、IME 保护、光标管理、segments 提取与重建、placeholder/只读 |
| `renderer/src/components/im/MentionInput.tsx`（改） | 以 RichComposer 替换 textarea；发送/草稿/失败恢复改用 segments；退役 `pendingMentions/pendingFiles/pendingSkills` 三数组与底部 chip 行 |
| `renderer/src/components/im/composer-segments.ts`（新） | segments 类型、DOM↔segments 提取/重建、序列化（body/mentions/context）——纯函数可单测 |
| 菜单/搜索/📎/发送链路 | 不动 |

## 6. 兼容与迁移

- 旧草稿（纯文本）首次载入按纯文字 segment 重建，不解析标记
- 发送侧主进程零感知：body 文本形态与 v2.11.1 完全一致（`@name` / `@path` / `#T-3` / `/name`）
- MessageBubble 气泡 chip（context_json）照旧

## 7. 风险与测试策略

contentEditable 为本项目首次引入，三大雷区专项锁：

- **IME**：组字期不触发菜单 / 不拆 DOM / Enter 不发（composition 事件序列用例）
- **光标与原子性**：pill 插入后光标落点、←/→ 跳过、Backspace 两段式删除、Delete 高亮删除
- **序列化**：五类 pill 的 body/context/mentions 映射表逐行锁（含技能不进正文、命令整串拦截、去重、空 body + 技能合法）
- 草稿往返（pill 不丢）、发送失败恢复、只读态、菜单复用回归（@ 双源/中文过滤/默认列表）
- e2e：contentEditable 用 `type()`（`fill()` 不适用），触发流（@ 选文件 → / 选技能 → 输入文字 → 发送 → 气泡 chip）重写
