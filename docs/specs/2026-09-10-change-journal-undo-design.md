# 变更账本与撤销设计（v2.5.0 系列 · 工具防御第三期）

- **状态**：已批准（brainstorming 完成，2026-09-10）
- **上游**：工具体系对标分析 10 项改进之安全网线；经三轮用户澄清重塑（多仓库场景 / 无 git 机器 / 交叉撤回）
- **前序**：v2.3.0 FileTools 防御硬化、v2.4.0 ShellTools OS 沙箱（均已合并）
- **同批决策**：多仓 git 工具（就近仓库解析 + 跨仓 add/commit）立为独立后续 spec；worktree 并行隔离维持推迟

## 1. 背景与动机

平台对用户的隐性安全承诺是「agent 改了我的文件，我能看清、能撤销」。现状有三个盲区（brainstorming 三轮澄清挖出）：

1. **回滚盲区**：外层 git 基线对 workspace 内嵌的独立 git 仓库（前端/后端/需求多工程）不透明——外层 `git reset` 回滚不掉内层仓库的改动
2. **无 git 机器盲区**：simple-git / git 工具全部 spawn 系统 git 二进制——非研发用户的机器上，安全网从未织起（建 workspace 即失败或降级）
3. **commit 语义盲区**（本 spec 仅记录，修法在后续 git spec）：多仓 workspace 下 agent 的 git 操作全部落在外层影子仓库，内层真实仓库永远脏

对标两条业界路线：opencode 式**工具层 journal**（写前快照，零 git 依赖，per-message 粒度）vs Claude Code 式 **git checkpoint**（影子提交，机制无关的 ground truth）。本 spec 选 **journal 为主干 + git 为机会主义探测器**：journal 覆盖全画像用户（文职/研发/多仓/无 git），git 探测器补 bash 造成的账外变更。

## 2. 目标

1. AI 工具层文件变更全量记账（write_file / edit_file / apply_patch / rm / mv），content-addressed 快照去重存储
2. 撤销语义安全闭环：hash 并发守卫、逆序撤回链、「回滚到此条之前」组合操作、撤销可再撤销
3. 变更审查 UI 两个入口：消息流 chip（消息粒度）+ 任务卡面板（任务粒度聚合）
4. git 探测器**多仓感知**：任务审查时对 workspace 内发现的所有仓库扫描未入账变更（bash 洞的事后补丁）
5. 磁盘有界：workspace 级配额滚动清理

## 3. 非目标（明确不做）

- bash 内部变更的**实时**记账（只有事后探测器）
- 用户侧 file:* CRUD（文件树手动增删改）不入账——用户主权操作
- 内嵌 git（dugite）与多仓 checkpoint——推迟，等主干落地后按真实缺口决定
- 多仓 git 工具就近解析——独立后续 spec（§4 的仓库发现函数为其预留复用）
- worktree / 快照并行隔离——后续 spec
- 跨任务三方合并语义（撤回 = 逐文件逆序写回，不做 merge）
- Windows 平台（跟随 spec #8）

## 4. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | journal 主干（opencode 模型）取代原设想的 worktree / git checkpoint | 用户澄清：非研发用户无 git、多仓 workspace 常见——journal 零依赖零假设；三条路线对比中通用性最高、复杂度最低 |
| D2 | 记账点单点收口：FileTools 写类操作 + ApplyPatchTools 在**落盘前**调 recordChange | v2.3 C1 / v2.4 resolveShellSpawn 同款「单一接入点」纪律 |
| D3 | 撤回 hash 守卫 + 逆序语义 + 组合回滚 | 用户澄清交叉撤回场景：任务 A/B 同改一文件时，naive 撤回 A 会静默毁掉 B——守卫默认拦截，逆序组合才放行 |
| D4 | git 探测器懒执行、只读、多仓感知、无 git 优雅降级 | 机会主义增强不反噬主干；多仓感知顺带修复探测器自身的多仓盲区 |
| D5 | 撤销动作本身记账（对称条目） | 撤销可再撤销；崩溃窗口孤儿条目由 hash 守卫归为安全方向 |
| D6 | blob 落 userData 文件系统（内容寻址），条目入 state.db | 条目轻量可查询可事务；大内容不泡 DB |
| D7 | 配额滚动清理对齐审计配额先例（auditQuotaMb） | 仓库既有模式；默认 200MB/ workspace + 30 天双条件 |

## 5. 架构设计

### 5.1 模块形态

```
electron/src/main/journal/
  types.ts      — JournalEntry / RevertOutcome / ScanResult 等类型
  store.ts      — 账本仓库（journal_entries 表 CRUD + blob 读写 + 引用计数）
  recorder.ts   — recordChange(ctx, path, op, before?, after?, oldPath?)：工具层唯一记账点
  revert.ts     — revertEntries(ids, { force })：hash 守卫 + 逆序写回 + 对称记账
  detector.ts   — discoverRepos(workspaceDir)（限定深度找 .git，缓存）+ scanUnjournaled(taskId)
  quota.ts      — 配额计量 + 滚动清理（最旧任务组优先，引用计数归零删 object）
  ipc.handlers  — journal:list / journal:revert / journal:scan / journal:quota 通道
```

### 5.2 数据模型（migration v33）

```sql
journal_entries (
  id TEXT PRIMARY KEY,               -- je_<uuid>
  workspace_id TEXT NOT NULL,
  task_id TEXT,                      -- 可空：快速会话无任务
  session_id TEXT NOT NULL,
  message_id TEXT,                   -- 消息粒度归组（流式 chip 用）
  stream_session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,           -- write_file / edit_file / apply_patch / rm / mv / undo
  path TEXT NOT NULL,                -- workspace 相对路径（展示与对账键）
  op TEXT NOT NULL,                  -- create / modify / delete / rename
  before_hash TEXT, after_hash TEXT, -- sha256 内容寻址；create 的 before 为空
  old_path TEXT,                     -- 仅 rename
  created_at INTEGER NOT NULL
)
CREATE INDEX idx_journal_task ON journal_entries(workspace_id, task_id);
CREATE INDEX idx_journal_message ON journal_entries(workspace_id, message_id);
```

- **blob 存储**：`userData/journal/<workspaceId>/objects/<hash[0:2]>/<hash>`——同内容跨条目共享一份（引用计数）；undo 对称条目复用既有 blob，零额外存储
- **归组三级**：条目（工具调用）→ 消息（message_id）→ 任务（task_id）；快速会话走 session/message 两级

### 5.3 记账点（写前记账，write-ahead）

| 工具 | op | 记账内容 |
|---|---|---|
| write_file 新建 | create | before 空，after=新内容 |
| write_file 覆盖 | modify | before=旧内容，after=新内容 |
| edit_file | modify | 同上 |
| apply_patch add/update/delete | create/modify/delete | 逐文件条目（复用其既有备份读取） |
| rm | delete | before=整文件内容（目录递归 = 每文件一条） |
| mv | rename | old_path + before；目标存在时叠加一条 modify |
| undo（§5.4 对称记账） | 视原 op 逆操作 | before=当前，after=写回内容 |

read_file / list / grep / glob 不记账。**bash 不经过账本**——由 §5.5 探测器事后补。

### 5.4 撤销语义

```
revertEntries(ids, { force = false })，按 path 分组后逐文件逆序（created_at DESC）执行：
  对每条目：
    hash(当前文件) == after_hash → 正常撤回：
      create   → 删除文件
      modify   → 写回 before 内容
      delete   → 重建 before 内容（附备注）
      rename   → 移回 old_path（目标存在叠加警告）
    hash != after_hash → 已漂移（其后被任务 B / 手动 / shell 改过）：
      force=false → 跳过 + 黄标
      force=true  → 强制写回（UI 明确警告「将丢失其后全部变更」）
    文件不存在 → create：无需动作；其余：重建 before + 备注
  每次写回前记对称条目（撤销可再撤销）
  返回 RevertOutcome[]：reverted / skipped-diverged / restored-missing / no-op / failed
```

**交叉撤回**（任务 A/B 同改 1.txt，撤 A）：

```
默认：hash(v2) ≠ A.after(v1) → 拦截 + 黄标「此后有变更：任务 B @时间 / 手动 / shell」
正确姿势 = 逆序：先撤 B（v2→v1 ✓）再撤 A（v1→v0 ✓）
UI 组合操作：[回滚 1.txt 到任务 A 之前] = 自动逆序组合该文件全部后续撤回 + 本条，
逐步守卫逐步汇报，任一步拦截即停。
任务级 [撤回全部] 同理逐文件逆序，绝不乱序批量写回。
```

**崩溃一致性**：条目先于文件变更写入。孤儿条目（记账后写盘前崩溃）：撤回时 hash(当前)==before → 归为 no-op，安全方向。

### 5.5 git 探测器（多仓感知）

```
discoverRepos(workspaceDir)：
  限定深度（默认 3 层）walk 找 .git 目录 → [workspaceRoot(外层), inner1, inner2...]
  结果缓存（workspace 目录 mtime 失效）；后续多仓 git spec 复用此函数

scanUnjournaled(taskId)（懒执行：用户打开审查面板时才跑）：
  对每个发现的仓库：git -C <repo> status --porcelain + diff --name-only
  与该 task 的 journal 路径集做差（路径按仓库根 relativize 对齐）
  返回：{ journaled: [...], unjournaled: [...], repos: [...], degraded: false }
  无 git（git 探测失败）→ degraded: true，UI 显示「本机无 git，无法交叉核对」
```

- 只读不写，不产生 commit；git 路径走 v2.4 已有解析（系统 git 优先）
- 未入账区文案诚实标注：「经 shell 命令或用户手动修改——无法区分」

### 5.6 IPC 面（4 通道）

`journal:list(scope: {taskId?} | {messageId?})` → 条目 + blob 内容摘要（diff 用）；`journal:revert(ids, {force})` → RevertOutcome[]；`journal:scan(taskId)` → ScanResult；`journal:quota`（get/set，并入设置页）。preload + types.d.ts 双端同步（boundary-rules）。

## 6. UI 设计

### 6.1 消息流「变更」chip

AI 消息有账本条目 → 气泡下方 `N 处变更` chip（交互复用 DispatchChip 模式）。点开：该消息逐文件 before/after diff + 每文件 [撤回] + [全部撤回]（逆序守卫语义，结果逐文件呈现，含黄标与强制选项入口）。

### 6.2 任务卡「变更审查」面板

任务详情分区：按消息分组聚合 diff + 未入账区（§5.5）+ [回滚全部入账变更]。任务终态后依然可用（账本持久）。「回滚到此条之前」组合操作在黄标详情中提供（§5.4）。

### 6.3 撤回结果呈现

reverted / 已漂移跳过（黄标 + [强制撤回]）/ 重建缺失（备注）/ no-op——逐文件结果列表，不静默。

## 7. 保留策略

- workspace 级 blob 配额，默认 **200MB**；设置页暴露（「会话设置」分类「变更保留」项）
- 超限滚动清理：最旧**任务组**整组删除（快速会话按消息组）；blob 引用计数归零才删 object 文件
- 30 天硬上限（终态任务组）；双条件取先到
- 条目行数不计费，只计 blob 字节

## 8. 测试策略

| 层 | 手段 |
|---|---|
| store/recorder | 真实临时 workspace + 真实 state.db；内容寻址去重断言（同内容两条目一 blob）；五 op 矩阵（create/modify/delete/rename/undo） |
| revert 语义 | 正常 / hash 漂移跳过 / 强制 / 缺失重建 / create 撤回删文件 / rename 撤回移回 / **交叉撤回**（A/B 同文件：默认拦截 + 逆序组合成功）/ 撤销的撤销——**每分支专项用例** |
| 记账点接线锁 | 真实 doExecuteTool 路由跑 write_file/edit_file/apply_patch/rm/mv，断言条目落账（v2.3 C1 同款防线——防「测试手动记账、生产没接」） |
| 探测器 | fake git 输出解析；多仓 fixture（外层 + 内层两 repo）；未入账差集；无 git 降级 |
| 配额清理 | 注入小配额 + 新旧任务组 fixture → 只删最旧、引用计数正确、object 文件物理删除 |
| UI | chip / 审查面板 colocated 测试（mock journal IPC） |

## 9. 验收清单

1. 消息 chip 显示 `N 处变更`，diff 正确
2. AI 改后用户手改同一文件 → 撤回被黄标拦截；强制选项可用且警告明确
3. 任务 A/B 交叉改同文件 → 撤 A 默认拦截；「回滚到 A 之前」逆序组合成功
4. bash 改文件 → 审查面板未入账区可见（多仓 workspace 下内层仓库变更也可见）
5. 撤回后 git status 恢复干净（各仓库分别验证）
6. 200MB 配额触发滚动清理；30 天硬上限
7. 撤销本身可再撤销（对称条目）
8. 快速会话（无任务）chip 路径可用
9. 无 git 容器/机器：主干全可用，探测器显示降级提示

## 10. 风险与开放问题

1. **rm 大目录记账体积**：递归每文件一条 + 全内容 blob——配额是唯一防线；可在 rm 前提示体积超阈值需确认（实现时评估，不阻塞设计）
2. **探测器与用户变更的混淆**：任务窗口内用户手改的文件也会进「未入账」区——文案已诚实标注无法区分；后续可按 mtime 与任务时间窗交叉缩小归因（v2.5.x）
3. **blob 目录的备份/迁移**：userData 清空 = 撤销历史丢失（可接受，与审计日志同级）；文档注明
4. **内层仓库 commit 语义盲区**：本 spec 只修探测，agent 提交仍走外层——由后续「多仓 git 工具」spec 解决（D 决策已立）
