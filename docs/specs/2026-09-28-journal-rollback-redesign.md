# 变更回滚重构：预检驱动的整体回滚（journal rollback redesign）

- **状态**：已批准（brainstorming 完成，2026-09-28）
- **上游**：`docs/specs/2026-09-10-change-journal-undo-design.md`（v2.5 变更账本——本 spec 重构其 §6.2 任务面板并补会话级入口，journal 主干机制不动）
- **需求原点**：用户的原始诉求 = 「某次会话/任务完成后，对 agent 修改的内容不满意 → 整体回滚」（opencode 式撤离心智）

## 1. 背景与问题

v2.5 交付的「变更审查」面板对照原始需求存在三个结构性错位：

1. **主次颠倒**：需求主角是「一键整体回滚」，实现却把回滚做成折叠面板深处的小按钮，80% 面积给了 diff 浏览——做成了审计查看器，不是撤销工具
2. **会话级入口缺失**：原始诉求的第一个场景就是「某次**会话**完成后整体回滚」，但快速会话（无任务）只有逐消息 chip 逐条撤回，无会话粒度入口
3. **回滚语义事后呈现**：漂移拦截、未入账不撤等安全边界只在执行**后**的黄标里暴露；「整体回滚 ≠ 100% 回到过去」应在按下按钮**前**讲清楚

实现硬伤：面板按消息分组但组标题渲染裸 `streamSessionId`（不透明内部 ID，用户不可读）；「变更审查」命名暗示审查门禁但并无门禁语义。

## 2. 目标

1. 任务面板信息架构倒转：主操作「回滚此任务全部变更」前置，diff 明细降为次要折叠区
2. 回滚前预检（dry-run）：先呈现「将回滚 / 将拦截 / 不在范围」，确认后才执行
3. 会话级整体回滚入口（快速会话 + 协作会话通用），覆盖会话内全部消息含子 agent dispatch 写入
4. 消灭裸 `streamSessionId` 分组：明细改按文件分组
5. 命名统一：任务/会话级整体动作叫「**回滚**」，消息 chip 逐条动作保持「撤回」

## 3. 非目标（明确不做）

- 会话级未入账扫描（bash 账外核对绑定任务上下文，不随本批蔓延）
- 审查门禁（approve/reject 状态机、任务完成前强制审阅）——YAGNI
- journal 记账点、hash 守卫、逆序执行、对称记账等主干机制——不动
- 消息 chip（`ChangesChip`）逐条撤回路径——不回归、不改形态

## 4. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 预检驱动重构（electron 新增 dry-run 通道 + UI 主角倒转），弃「纯 UI 重排」（预检落空）与「审查门禁化」（超需求） | 预检是「回滚前讲清楚」的唯一正解；门禁远超整体回滚诉求 |
| D2 | 预检结果复用 `RevertOutcome` 形状，语义 = `force=false` 的逐条预测 | renderer 复用五态渲染与分组逻辑；类型面最小增量 |
| D3 | 预检的链式虚拟状态模拟必须与执行语义**逐位一致**：per path 逆序，撤回成功后虚拟态 = 该条 before；拦截/no-op 不改变虚拟态 | 同文件多版本链下，独立判定会把旧条目全部误判漂移 |
| D4 | 强制覆盖用**全局**勾选（默认不勾），不用逐文件勾 | 批量逆序执行序不可拆（拆两批调用破坏全局 created_at DESC）；逐文件粒度留给既有黄标行「回滚到此文件此条之前」兜底 |
| D5 | 会话级查询走 `session_id` 单列 scope（新 store 方法 + 索引） | 子 agent dispatch 写入与父消息同 `session_id` 不同 `streamSessionId`——session scope 恰好是「本次会话全部变更」的正确语义 |
| D6 | 明细分组从「消息」改「文件」（全量条目 `groupByPath`） | 「任务/会话总共动了哪些文件」才是回滚心智；消息级上下文由 chip 在会话内提供，面板不再重复 |
| D7 | 新索引走 migration **048** 独立模块（`048_journal_session_index.ts`，约定同 032-047） | 仓库迁移惯例；最新已至 047 |

## 5. 架构设计

### 5.1 electron：预检通道

`revert.ts` 重构——把 `revertOne` 内嵌的「读当前字节 + hash 判定 → 分支决策」抽成纯决策函数：

```
classify(entry, current: Buffer | null): Plan
  Plan = { outcome: RevertOutcome, action: 'delete-file' | 'write-before' | 'move-back' | 'none' }
```

- **执行路径**（现行为不变）：classify → 按 action 写回 → 对称记账（recordInverse）
- **预检路径**（新）：classify-only，不写盘、不记账

新 IPC 通道 `journal:preview(workspaceId, ids): RevertOutcome[]`：

- 执行序与 `revertEntries` 完全一致（全局 `created_at` DESC）
- **链式虚拟状态模拟**（D3）：`Map<path, Buffer | null>` 虚拟态，首次触碰某 path 时读真实磁盘播种；其后同 path 条目以虚拟态判定——撤回成功 → 虚拟态 = 该条 before blob；`skipped-diverged` / `no-op` → 虚拟态不变；rename 同时迁移 oldPath/newPath 两侧虚拟态
- 查不到的 id → `no-op + 条目不存在`（与执行路径同文案）
- 预检与执行间的竞态：预检仅是呈现优化，执行时守卫仍然生效——UI 文案标注「以执行时守卫为准」

### 5.2 electron：会话级查询

- `store.ts` 新增 `listBySession(workspaceId, sessionId): JournalEntry[]`
- `journal:list` scope 增加 `sessionId?: string` 第三键（优先级：`taskId` > `streamSessionId` > `sessionId`；三键皆空 → `[]`，语义不变）
- migration **048**：`CREATE INDEX idx_journal_session ON journal_entries(workspace_id, session_id);`

### 5.3 IPC 面（boundary-rules 双端同步）

| 通道 | 变更 |
|---|---|
| `journal:preview` | **新增**——preload + `types.d.ts` `JournalApiSurface` 同步 |
| `journal:list` | scope 类型加 `sessionId?: string` |

### 5.4 renderer：共享回滚核心组件

新组件 `renderer/src/components/common/JournalRollback.tsx`：

```
JournalRollbackSection({ workspaceId, entries }): 
  汇总行（N 处变更 · M 个文件）
  → 主按钮「回滚全部变更」（danger）
  → 点击调 journal:preview → 确认面板：
      将回滚 X 文件（清单）
      将拦截 Y（黄标 + 漂移说明，D3 链式语义下的真实预测）
      将重建缺失 Z / no-op W（折叠为计数行）
      [强制覆盖已漂移文件] 全局勾选（默认不勾，警示文案「将丢失其后全部变更」）
      [确认回滚] [取消]
  → 执行 revert(ids, force=勾选) → JournalOutcomeList 五态结果
  → 幂等二次查询刷新（对称记账，撤回条目仍留账）
```

任务面板与会话弹窗共用；错误路径（preview/revert 整批抛错）错误行呈现不静默。

### 5.5 renderer：任务面板重构（`TaskChangesPanel.tsx`）

分区更名「变更审查」→「**变更与回滚**」（`TaskDetailPanel.tsx` 按钮文案同步）。展开后：

1. 顶部：`JournalRollbackSection`（§5.4）
2. 明细区（默认折叠）：**按文件**分组（全量条目 `groupByPath`，净 diff = 首条 beforeText → 末条 afterText）——`groupBySession` / `SessionGroup` 及裸 `streamSessionId` 渲染**删除**
3. 未入账区（保留现样式）：scan 差集 + 诚实归因文案；确认面板中由「未入账文件不随回滚」声明呼应
4. 黄标行「回滚到此文件此条之前」组合操作**保留**（`journal:rollbackFileBefore` 不动）

### 5.6 renderer：会话级入口

`MiddlePanel.tsx` 会话头部（`RoomToolBudgetBadge` / `ExportChatButton` 同排）新增 `SessionRollbackButton`：

- 挂载懒查 `journal.list({ workspaceId, sessionId })`，空账不渲染（被动 affordance，失败 warn 留痕——`ChangesChip` 同契约）
- 点击弹 `ui/Dialog`，标题「回滚本次会话变更」，内容 = `JournalRollbackSection`（§5.4）
- 覆盖语义：该 session 全部条目（含子 agent dispatch 写入，D5）

## 6. 测试策略

| 层 | 手段 |
|---|---|
| preview 决策函数 | 抽出后与重构前行为等价（既有 `revert.test.ts` / `revert-binary.test.ts` 全量回归） |
| preview 链式模拟 | 同文件三版本专项：v0→v1→v2 磁盘=v2 全绿（两条均 `reverted`）；磁盘漂移 v3 → 该 path 全部 `skipped-diverged` 且虚拟态不变；rename 链两侧虚拟态迁移 |
| preview 无副作用 | 断言文件内容/mtime 不变、账本无新条目、blob 无新增 |
| listBySession | 同 session 多 streamSessionId 条目聚合；跨 session 不串 |
| migration 048 | up/down 常规（既有 migration 测试模式） |
| JournalRollbackSection | 预检→确认→执行流；强制勾选分支（force 参数透传）；preview/revert 抛错呈现 |
| TaskChangesPanel | IA 倒转（主按钮先行）；明细按文件分组断言（不再出现 streamSessionId 文案）；未入账区保留 |
| SessionRollbackButton | 空账不渲染；有账渲染 + Dialog 流；懒查失败降级隐藏 |
| 回归 | `ChangesChip.test` / `TaskChangesPanel.test` 更新后全绿 |

## 7. 验收清单

1. 任务完成后打开任务卡，「变更与回滚」展开第一眼是「回滚此任务全部变更」主按钮
2. 点击主按钮先见预检：将回滚 / 将拦截（黄标）/ 重建缺失 / 未入账不随回滚——确认后才执行
3. agent 改后用户手改同文件 → 预检即黄标（不再事后惊讶）；勾选强制 → 覆盖成功且警告明确
4. 快速会话头部出现回滚按钮（无变更不可见）→ 弹窗整体回滚，子 agent 写入一并覆盖
5. 明细按文件分组，界面无裸 `streamSessionId`
6. 预检绝不写盘、不记账（单测断言）
7. 既有消息 chip 逐条撤回、「回滚到此文件此条之前」路径不回归
8. 任务终态后回滚依然可用（账本持久，现状保持）

## 8. 风险与开放问题

1. **revert.ts 重构回归风险**：决策逻辑抽出必须行为等价——靠既有 revert 测试全量回归兜底；classify 函数签名保持纯函数（无 IO），store/blob 读取留在调用侧
2. **预检-执行竞态**：预检后文件再被改 → 执行时守卫拦截，结果五态如实呈现；UI 文案已标注「以执行时守卫为准」
3. **会话级误伤面**：长会话早期正常工作 + 晚期不满意时整体回滚会连早期一起撤——确认面板的文件清单即防误伤手段（用户可先看清单再决定）；逐文件粒度走明细区既有路径
