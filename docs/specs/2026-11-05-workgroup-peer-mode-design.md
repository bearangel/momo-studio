# 工作组平行模式（peer mode）设计——协议 1.10.0 / hub 0.6.0 / studio 2.1.0-alpha.58

日期：2026-11-05（深夜授权自主实施）
状态：已批准（brainstorming 全流程逐节确认：契约 → 三链路 → UI/测试）
上游讨论：本 spec 由 2026-11-05 会话对齐定稿，所有裁定见 §9 裁定记录。

## 1. 背景与目标

现有工作组（momo-hub M2）是严格主从模型：1 组长 + N 平级成员，**组长独占**镜像/委派/调度/查看/邀请，委派的任务书携带完整执行编排（agent/团队），worker 侧自动建会执行。

两个真实场景驱动本设计：

- **主从模式（现状）**：一个用户多台设备，主节点调度算力——现有功能零变化。
- **平行模式（新增）**：多人多角色团队（需求/研发/测试），节点 = 人的工位。需求完成后把任务委派给研发的设备，研发完成后委派给测试，测试把缺陷任务委派回研发——**人对人的任务接力**。

核心差异：平行模式下委派的是**草稿**（不含执行编排），由**接收方节点拥有者**自行安排执行；执行全程回传发送方（全程可见闭环）。

## 2. 模式与术语

| 术语 | 定义 |
|---|---|
| 主从模式 `leader-follower` | 现状。组长独占镜像（按名落同名副本）/委派（完整任务书）/查看/调度；least-busy 组内调度可用 |
| 平行模式 `peer` | 任意成员可点对点委派**草稿**；落点=接收方**绑定空间**；镜像可选（组长发起，落绑定空间，接收方可拒）；节点查看全组禁用；无 least-busy |
| 绑定空间（承接空间） | 平行组成员在入组/组设置里声明的唯一本地工作空间：外来草稿落这里、平行组镜像落这里 |
| 草稿（draft） | 平行委派载荷：仅 title/prompt/priority；**禁止** agentSlug/team/dependsOn/permissionTier |

一个工作空间可同时是「平行组的承接槽（入）」与「主从组的镜像源（出）」——两角色正交，零冲突（例：研发人员既是平行组组员，又用自己的研发空间建主从组调度自有设备）。

## 3. 协议契约（momo-hub 协议包 1.9.0 → 1.10.0）

### 3.1 组模型扩展

```
GroupInfo += { mode: 'leader-follower' | 'peer' }   // 旧 hub 不回该字段 → studio 按 leader-follower
GroupMember += { bound?: boolean, boundWorkspaceName?: string, acceptsMirror?: boolean }
```

- `group.create { groupName, mode?, bindWorkspaceName? }`：peer 组**必须**带组长绑定空间；lf 组绑定字段忽略
- `group.join { inviteCode }`：载荷不变（绑定走独立 `group.bind`，两步式入组——见 §6.2）
- **新增** `group.bind { groupId, workspaceName }` / `group.unbind { groupId }`：绑定/解绑（幂等，最后一次生效；绑定信息为组级登记——hub 记 (group,node)→workspaceName + acceptsMirror）
- **新增** `group.setMirrorAccept { groupId, accepts: boolean }`：镜像接受开关翻转（独立于绑定，入组后任意时刻）
- `GROUP_RPC` 目录增 `bind`/`unbind`/`setMirrorAccept` 三方法，METHOD_REQUIRED_MINOR 登记为 **10**（1.9 旧节点调即 unsupported_method 可读降级）
- peer 组入组/建组的节点 protoVer minor ≥ 10（hub 建组闸 + 入组闸）；studio 建组界面在 hubProtoVer < 1.10 时不出「平行模式」选项

### 3.2 委派通道：draft 变体（复用 `task.delegate`）

```
DelegationTask += { draft?: true, priority?: number }
```

- **hub 平行组守卫**（分流规则）：
  - `leader-follower` 组：守卫不变（leader-only，现状零变化）
  - `peer` 组：任意成员可调 `task.delegate`；但载荷 task 段出现 `agentSlug`/`team`/`dependsOn`/`permissionTier` 任何一键 → 整包拒 `bad_request`（深度防御：防异构客户端把完整编排 smuggle 进平行组——静默换班禁令）
  - peer 组委派要求目标**已绑定**：hub 查绑定登记，未绑定 → `forbidden「目标节点未绑定承接空间」`
  - draft 任务要求目标 protoVer minor ≥ 10（`node_unsupported`，同团队派发版本门机制）
- `workspaceName` 字段：peer 委派时 = **发送方源空间名**（纯展示元数据「来自 X 的空间Y」），接收方不用于解析（peer 按绑定解析）；lf 委派语义不变（按名对账）
- `task.assigned` 事件透传 draft/priority（随事件过不持久化——与 agentSlug/team 同生命周期）

### 3.3 账本与上报：零状态机变更

- ledger 状态机七态不动（pending/running/waiting/done/failed/interrupted/cancelled + D6 续传 + interrupted 回收）
- **`task.report` 载荷 status 增 `'pending'` 值**：进度拍不改账本状态、只记 progress 转发——承载「已接收/已安排」两类生命周期拍（对账键同 id=taskId）
- **progress.kind 枚举扩两值**：`'received'`（草稿已落接收方看板）/ `'arranged'`（接收方已指派 agent/团队）；hub 白名单校验同步扩
- **拒收 = `failed` + reason `declined:<理由>`**：与既有 worker decline 文案约定同源；发送方卡片按 `declined:` 前缀渲染拒收样式
- peer 委派的取消：`task.cancel` 权限放宽为 **peer 组任意成员可取消自己发起的**（`by_node_id` 对账；lf 组维持 leader-only）——hub cancel 守卫按组模式分流

### 3.4 镜像两段式：apply 目标扩展

```
MirrorRequest += { applyTo?: 'binding' | 'name' }   // 缺省 'name'
MirrorApplyPayload += { applyTo?: 'binding' | 'name' }
```

- peer 组镜像：hub 校验目标 `acceptsMirror=true`（否则 `forbidden「对方未接受本组镜像」`）→ apply 载荷带 `applyTo:'binding'` → worker 解析本地绑定空间 replace 落盘
- lf 组镜像路径逐字节不变（applyTo 缺省 name）
- peer 组镜像源 = 组长绑定的空间（一组一源裁定，§9）

### 3.5 版本门

`PROTOCOL_VERSION = '1.10.0'`；`PEER_DELEGATION_REQUIRED_MINOR = 10`（team 门=9 不动）。hub 版本 0.5.0 → 0.6.0。

## 4. 数据模型

### 4.1 hub 侧（packages/hub，迁移 v9）

- `groups` 表 + `mode TEXT NOT NULL DEFAULT 'leader-follower'`（存量组全落 lf，零行为漂移）
- 新表 `group_bindings (group_id TEXT, node_id TEXT, workspace_name TEXT NOT NULL, accepts_mirror INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, node_id))`——绑定登记与镜像开关同表（一次入组两决定）；FK 级联随 group_members

### 4.2 studio 侧（electron，新迁移）

- 新表 `hub_group_bindings (group_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, accepts_mirror INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`——接收方本地权威（hub 只存名字，本地存 workspaceId 供落点解析）
- `tasks.origin` 新值 `'peer_draft'`：接收方看板识别外来草稿行（来源徽标 + 安排/拒收/完结操作 + boot 对账排除 + 删除即拒收钩子）
- `tasks.delegation_id` 复用现有列：接收方行的回传挂接键（发送方行现状已用）
- `tasks.routing_json` 复用 node 变体 + `peerDraft: true` 标记：发送方外派卡显示「平行·→节点X」
- 零新状态列：生命周期靠 origin + delegation_id + 进度拍 kind 三角表达；本地任务状态机不动（draft→assigned→in_progress→completed 天然咬合「收到→安排→执行→完结」）

## 5. 三条核心链路

### 5.1 发送链（平行草稿委派，发送方）

1. CreateTaskDialog 执行位置按组分流：所选组 mode=lf → 现状形态原样；mode=peer → 草稿形态（节点选择器：成员行标「已绑定✓空间名 / 未绑定✗ / 版本过旧」；仅标题/描述/优先级；无 agent/团队/权限档位/least-busy）
2. 提交 → `hub:submitRoutedTask` peer 分支：行落库（pending，routing_json 带 peerDraft 标记）→ `task.delegate { task: { title, prompt, draft: true, priority? } }`
3. 瞬断/被拒 → 行保留待处理（现状重试入口：待派发卡）；成功 → delegation_id 回写
4. 发送方看板行：`pending`(已送达) → [received拍]已接收 → [arranged拍]已安排 → 首 running拍 → in_progress → done/failed；`declined:` → failed + 拒收样式

### 5.2 接收链（草稿在接收方的生命周期）

1. `task.assigned(draft)` 到达 → DelegationRunner **draft 分支**：
   - 闸：acceptTasks 开关沿用；并发闸跳过（草稿不执行不占槽）
   - 解析落点：本地 hub_group_bindings[group_id] → 无绑定 → `declined:未绑定承接空间`（hub 已闸，本地深度防御）
   - 落库：绑定空间 + status='draft' + origin='peer_draft' + delegation_id 挂接 + title/description(prompt)/priority
   - 上报 received 拍（status:'pending' + kind:'received'）
2. 接收方看板（草稿行带「来自 X」徽标，X=发送方节点名）：
   - **安排** → 现有编辑弹窗指派 agent/团队/会话（全本地自由，draft→assigned）→ 上报 arranged 拍
   - **拒收** → 理由确认 → report failed `declined:理由` → 本地行删除
   - **启动** → 现有 startTask 链路（assigned→in_progress 建执行会话）→ **回传接管**：delegation_id 触发 runner 建 ActiveRun（复用 tick 进度拍 + 终态上报，sessionTail 数据源同款）
   - **完结** → 本地 complete（执行自然终态，或拆子任务后手动完结）→ report done
3. 边界裁定：
   - **删除即拒收**：删除 peer_draft 行且 delegation_id 在场 → 强制 `declined:对方已删除任务` 上报（杜绝发送方永挂 pending）
   - **重启**：boot 对账（reconcileDispatchTasksAtBoot）排除 origin='peer_draft' 行；重连后按 delegation_id 扫本地 in_progress 的 peer_draft 行重新接管续拍
   - **断线终态**：终态上报缓冲重试（复用 report 失败缓冲语义）
   - **本地依赖**：接收方可给草稿加本地依赖（本地闸照常）；跨节点依赖协议已拒（§3.2）

### 5.3 镜像链（平行组）

1. 组长镜像 UI（监控台「统一镜像」批量动作）：成员按 acceptsMirror ∧ 已绑定过滤（置灰+原因）；源=组长绑定空间
2. 现有两段式：snapshot → hub 闸(acceptsMirror) → apply `{ applyTo:'binding' }` → worker mirror-applier 解析本地绑定空间 replace 落盘（conflict/diffSummary 现状复用）
3. 入组弹窗「接受镜像」旁护栏文案：「接受后组长的统一镜像将覆盖此空间内容」——成熟自有空间的成员应关闭（如研发空间场景）

## 6. UI 改动清单

| 界面 | 改动 |
|---|---|
| 建组弹窗 | + 模式单选卡片（lf=现有描述 / peer=团队协作描述）；peer 必选绑定空间下拉；hub < 1.10 时平行项不出 |
| 入组流程 | 两步式：join 成功后 peer 组 → 追加「绑定承接空间 + 接受镜像（单选+护栏）」弹窗；跳过=未绑定成员（组设置可补绑） |
| 监控台 | peer 组：查看入口全组隐藏；+「统一镜像」批量动作；节点卡绑定状态行 |
| 组设置 | peer 组：换绑、镜像开关翻转 |
| 创建任务弹窗 | 执行位置按组分流（§5.1）；routingPrecheck 返回扩展 groups[].mode + members[].{bound, boundWorkspaceName} |
| 任务看板 | 发送方：委派卡 received/arranged 渲染、declined 拒收样式；接收方：peer_draft 徽标 + 安排/拒收操作 |

UI 实现走 momo-ui-preview-rules 静态预览门禁（建组/入组/委派分流三个 P1 面；深夜自主阶段以设计系统 token 纪律 + 事后截图验收替代，见验收报告）。

## 7. 测试策略

- **SimHub 扩展**（studio m2-integration 假 hub 同步真实守卫）：peer 守卫（任意成员可委派 / 载荷键白名单逐键拒收：agentSlug、team、dependsOn、permissionTier 各一条）、绑定 RPC、acceptsMirror 闸、applyTo:binding、pending 拍透传、版本门
- **hub 侧测试**（packages/hub/tests）：groups（mode/绑定/开关/门槛）、delegations（peer 分流守卫、pending 拍、peer cancel 放宽）、mirror（applyTo+acceptsMirror）
- **端到端**（双 studio headless A=组长 B=组员）：建 peer 组(A绑定) → B 入组+绑定+开镜像 → A 草稿委派 → B 落板(draft) → B 安排 → B 执行 → 全程拍回传 → 完结 → A 行 completed；分支：拒收带理由 / 删除即拒收 / 重启重连续拍 / 瞬断重试
- **studio 单测**：dispatch-submit（peer 载荷形状/未绑定预检）、delegation-runner（draft 分支/boot 排除/重新接管）、mirror-applier（applyTo 解析）、delegation-sync（新拍 kind 映射/declined 渲染）
- **回归锁**：现有主从全链路测试一行不改、必须全绿（dispatch-submit / delegation-runner / m2-integration / task-routing / groups 既有套件即锁）
- **错误路径专项**：未绑定、拒收、删除、断线、重启五条独立用例

## 8. 非目标（scope 锁）

- 平行组无 least-busy 组内调度、无跨节点依赖、无节点查看（含组长）、无站内「提醒对方绑定」通知（人类协调）
- 模式建组定死不可切（建组时选定，终身不变；换模式=建新组）
- 主从模式零变化（含按名镜像、least-busy、仅组长委派/查看）
- 不做绑定多空间（一节点一组一空间；多项目=多组）
- 平行组镜像源不做多选（恒=组长绑定空间）

## 9. 裁定记录（brainstorming 定稿）

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 闭环=方案A 全程可见（复用 task.report 回传链） | 用户 2026-11-05 |
| 2 | 平行组节点查看全组禁用（隐私） | 用户 |
| 3 | 落点=绑定空间（取代「公开空间清单」方案 C） | 用户提案，双向优化 |
| 4 | 双轨：平行走绑定、主从镜像保留按名建副本 | 用户（解决单绑定 vs 主从多空间镜像冲突） |
| 5 | 入组/建组提供「接受镜像同步」单选开关（可后改） | 用户 |
| 6 | 主从组入组不绑定（按名机制不变，绑定仅平行组） | 双轨必然推论，默认裁定 |
| 7 | 模式建组定死不可切 | 默认裁定（推荐 A） |
| 8 | 草稿可拒收（带理由）；拆子任务时委派行=跟踪单元，接收方手动完结 | 默认裁定 |
| 9 | 拒收复用 failed+declined: 前缀；received/arranged=进度拍 kind | 设计裁定（账本零变更） |
| 10 | 平行组协议门槛 minor 10（沿用团队派发门机制） | 设计裁定 |
| 11 | 技术路线=方案一（扩展 delegate 通道 draft 变体） | 用户「走你推荐的」 |
| 12 | momo-hub 独立仓库：协议单源在 hub 仓库，studio 经 tag pin；本次本地 link 过渡，审核后打 v0.6.0 tag 恢复 pin | 实施约束（不做 GitHub push） |

## 10. 实施与发布顺序

1. momo-hub：协议包 1.10.0 + hub 0.6.0（迁移 v9）+ 测试 → 本地 commit
2. studio：pnpm override `link:../momo-hub` 过渡消费 → 主进程 → renderer → 测试 → 版本 2.1.0-alpha.58
3. 端到端验收（DeepSeek 真模型驱动 worker 侧执行）→ `.omo/qa-reports/` 报告
4. 人工审核后：momo-hub 打 tag v0.6.0 推 GitHub → studio 移除 override 恢复 `github:bearangel/momo-hub#v0.6.0` → pnpm install
