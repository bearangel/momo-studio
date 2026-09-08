# 平台重构进度 Ledger（v2.0）

## 全局

- 分支：main
- v1.7.4 BASE：e997d01a
- Plan A 完成 HEAD：ecb43e8
- 当前阶段：Plan B

## Plan A 状态：✅ 完成（13 commits，637+365 测试全绿）

详见 `.superpowers/sdd/workspace-a/` 各 task 文件。

## Plan B 状态：🔄 进行中

| Task | 状态 | Commit | Review | 备注 |
|---|---|---|---|---|
| B1 tasks migration v19 | 🔄 NEXT |  |  | tasks 表 + conflict_strategy + agent_definitions |
| B2 tasks repo + 状态机 | pending |  |  |  |
| B3 MemoryProvider + SQLiteMemoryProvider | pending |  |  |  |
| B4 MentionParser | pending |  |  |  |
| B5 MentionInput + TaskChip | pending |  |  |  |
| B6 decideResponse 三种路由 | pending |  |  |  |
| B7 任务创建 UI + IPC | pending |  |  |  |
| B8 任务启动 4 机制 | pending |  |  |  |
| B9 冲突处理器 + ConflictDialog | pending |  |  |  |
| B10 任务工具 | pending |  |  |  |
| B11 runtime-entry 集成 MemoryProvider | pending |  |  |  |

## Plan D 状态：pending（依赖 B）
## Plan C 状态：pending（独立，v2.0 联网）

## v2 fix: agent-online-semantics-redesign (2026-08-14)

Plan: docs/superpowers/plans/2026-08-14-agent-online-semantics-redesign.md
Base commit: fa52daf


### Task 1: complete (commits fa52daf..1a9826e, review clean)
- 类型补全 AgentAssignment.lastRunning 字段（electron + renderer types.d.ts + rowToAssignment）
- Spec Deviation (justified)：测试 SQL 改用 createWorkspace helper 模式（避免 NOT NULL 约束失败）
- Minor findings M1-M3 记入最终清理清单
- 双 workspace 1260/1260 tests pass + typecheck clean


### Task 2: complete (commits 1a9826e..97361a1, review clean after C1 fix)
- isAgentRunning 改为查 DB last_running（替代 runtimes.has）
- Review 发现 C1（auto-start.ts:67 死锁），fix 引入 isV1SubprocessAlive 解耦
- I1-I3 false positive（pre-existing v1.5.8 stopAgent 行为，非 Task 2 引入）
- 双 workspace 1263/1263 + 19 new tests pass + typecheck clean


### Task 3: complete (commits 97361a1..6161788, review clean)
- 新增 destroyTaskDrivenRuntime + stopAgentRuntime helper
- 偏离 brief：as any → as unknown as 满足 strict-no-any；DB seed 用 helper
- Minor M4: 动态 import 防御性（future cleanup）


### Task 4: complete (commits 6161788..8c21aea, review clean)
- agent:stop IPC handler 改用 stopAgentRuntime（替代 v1 stopAgent）
- 偏离 brief：mock 用 hoisted Map 替代 _handlers；as unknown as；DB seed 用 helper
- 全 electron 862/862 + 双 typecheck clean


### Task 5: complete (commits 8c21aea..1f84f7b, review clean)
- 核心 bug 修复：initTaskDrivenRuntime 加 lastRunning 过滤
- 抽取到 init-runtime.ts（index.ts 225→111 行）
- 返回 RouterService 实例供 setRouterService 注入
- Mutation test 验证：移除 filter 后 2/3 测试失败（测试有效）
- 双 workspace 1272/1272 tests pass + typecheck clean


### Task 6: complete (commits 1f84f7b..623be33, review clean)
- rebuildSubAgents 过滤 !sub.lastRunning
- PM dispatch 工具列表仅含在线 sub
- 867/867 tests pass + typecheck clean


### Task 7: complete (commits 623be33..fdfa700, review clean)
- maybeRestartMainForSubChange helper + agent:stop/start 末尾触发
- sub 状态变化自动重启 parent main 刷新 dispatch 工具列表
- 3 tests pass (含 main 已停早返边界 case)
- 全 agent suite 430/430 + typecheck clean


### Tasks 8+9: complete (commits fdfa700..fdf0a2e, review clean)
- 删除 agent.store running state + syncRunningStates
- UI 组件统一改读 assignment.lastRunning
- Implementer 主动发现 + 修复 brief 漏掉的 4 文件（AgentOrchestrator/AssignmentCapabilitiesDialog/MessageInput/MainLayout）
- Cleanup audit: 0 orphaned running references
- 1277/1277 tests pass + typecheck clean


### Task 10: complete (commits fdf0a2e..dc1b405, no review needed for doc-only)
- auto-start.ts 注释更新（无行为变更）
- 全测试套件 1277/1277（renderer 407 + electron 870）
- typecheck 双 workspace clean
- §7 标准 7/8/9 自动验证；1-6 需 GUI smoke test

## 全部 10 个 task 完成


### Final review fix: complete (commits dc1b405..f403256, re-review APPROVED)
- C1: ensureTaskDrivenRuntime / createTaskDrivenRuntime 写 last_running=1
- I1: restartMainForSubChange / restartCoordinatorInstance 改用 stopAgentRuntime
- I2: 新增 agent-start-stop.test.ts 3 个集成测试（含 mutation 验证）
- Side effect: 2 个既有测试 mock 同步更新
- 873/873 tests + typecheck clean + mutation test 验证有效

## 全部工作完成（12 commits + 1 final fix）

## v2 fix: router-service-lazy-init (2026-08-14)

Plan: docs/superpowers/plans/2026-08-14-router-service-lazy-init.md
Base commit: 9add711


### Task R1: complete (commits 9add711..fd7555b, review clean)
- 新建 router-bootstrap.ts (100 行) + 5 单元测试
- ensureRouterService / destroyRouterService / __resetRouterServiceForTest
- 全 electron 878/878 + typecheck clean


### Task R2: complete (commits fd7555b..606ada9, review clean)
- ensureTaskDrivenRuntime 末尾动态 import + 调用 ensureRouterService
- Placement 正确：在 if (!agentWarmPools.has) 块内 + try/catch
- Implementer 升级 brief placeholder test 为真实契约测试
- 880/880 electron + 407/407 renderer pass


### Task R3: complete (commits 606ada9..ce65487, review clean)
- initTaskDrivenRuntime 改用 ensureRouterService 统一入口
- 返回值改 Promise<void>；删除手动 RouterService 创建
- helpers 迁移到 router-bootstrap；index.ts autoRestoreSession 同步简化
- 880/880 tests pass + typecheck clean


### Task R4: complete (commits ce65487..f5f37c5, review clean)
- index.ts before-quit 改用 destroyRouterService
- setRouterService import 移除；无 orphan 引用
- 880/880 + 407/407 pass + typecheck clean


### Task R5: complete (commits f5f37c5..19bd3a5, review clean)
- 3 场景集成测试（init 路径 / startAgentRuntime 路径 / 批量幂等）
- task-driven-dispatch-chain.test.ts 保留（刻意隔离）
- electron 883/883

### Final review: APPROVED WITH MINOR
- 6 项交叉审计全过（生命周期/清理对称/竞态/端到端链路/v1 零回归/测试诚实度）
- M1 已修：lazy 路径补 populateProviderBuckets（commit 3302053）
- 其余 4 Minor 可 defer（见 final-branch-review.md）

## router-service-lazy-init 全部完成（6 commits）

## 2.0.0 P1 session-core（feat/v2.0.0-p1-session-core，基线 75897b8）

### Task 1: complete (commits 75897b8..dfd2278, review clean)
- v23 migration 落地（sessions/session_members + 6 处列操作 + DROP room_settings）
- 5 个老迁移测试适配 applyUpToVersion 模式（dfd2278）
- 45/45 migrations 套件通过
- Minor（defer 给终审）：① 017 测试 beforeAll 共享 DB 顺序耦合（id='m1' 复用）② apply 前导 6 份拷贝可抽 helpers.ts ③ af1293e 单独 checkout 时老测试红（squash 可消）④ 023 缺 afterAll(db.close())（brief 骨架责任）⑤ 023:696 注释与 CREATE TABLE IF NOT EXISTS 轻微矛盾

### Task 2: complete (commits dfd2278..f667ab2, review clean)
- sessions/repo.ts 接口逐字落地 + settings SessionSettings 语义 + messages/repo 列迁移 + 全仓 typecheck 修复（120 文件）
- 897/897 electron + 407/407 renderer + typecheck 双 clean
- 过渡态跟踪（Important, plan-mandated）：/sync 回放对 dispatch/task_reply 缺少 matrix_event_id 守卫，T2→T11 间重启可能重复落盘——Task 7 派发时评估廉价缓解，T12 根除
- Minor（defer）：getRoomsForWorkspace/CreateRoomInput 注释漂移；createMatrixSpace 无生产调用方待 T12；RoomToolBudgetBadge 命名待 T8-11；fixture 空行/旧 Space 占位

### Task 3: complete (commits f667ab2..313cc4d, review clean after fix round)
- session-ops.ts（SessionSummary/成员 JOIN/团队会话保护）+ 10 用例
- 修复轮：renameSession 契约名对齐 + createSession 事务原子性（含回滚测试）
- 907/907 electron + typecheck 双 clean
- Minor（defer）：报告 §3 残留旧名；workspaceId '' 真值语义；rename/delete 不存在 id 静默 no-op 无测试；N+1（已自曝）

### Task 4: complete (commits 313cc4d..508a413, review clean)
- RouterService：InternalEvent/routeEvent 更名 + routeUserChat plain 入口 + findAssignmentByAgentUserId
- routeUserChat 两分支（生成/尊重 streamSessionId）有测试；910/910 + typecheck 双 clean
- Minor（defer）：RoutedEvent alias 本可在本 diff 消除（T12 必删清单已记录）；默认 streamSessionId 测试未断言 UUID 形态

### Task 5: complete (commits 508a413..19f7903, review clean)
- internal-event.ts + internal-event-bridge.ts 契约落地；spawner/bootstrap 接线；runtime-entry 非 v1 路径 sendEvent 全替换
- v1 分支零改动经审查员对 HEAD 源码核实；919/919 + 407/407 + typecheck 双 clean
- 计划内中间态（跟踪）：/sync 用户消息路由已断开（T7 重建 SessionService 入口）；sendTaskReplyEvent 待 T6-8 接通；routeAbortDispatch 仍是 stub（T8）
- Minor（defer）：桥类型窄化浅（sender/sessionId 未验证）；router 缺失事件静默丢；测试文件末尾换行/注释混排

### Task 6: complete (commits 19f7903..040bb7e, review clean)
- stream-relay.ts 独立模块（handleStreamChunk/getEventBuffer/abortStreamBySessionId/setAbortResolver）+ StreamChunk 字段 session 化 + runtime-manager 瘦身
- 926/926 + 407/407 + typecheck 双 clean；网络中断后续接完成
- Important（plan-mandated，已被 T13 追踪）：v1 fallback agent 停止按钮 no-op（agent:abortStream 仅达 task-driven runners）
- 裁定：T2 遗留 /sync 重放重复窗口不在 T7 加缓解（sync-manager 是 T12 删除对象，缓解代码即废弃代码）——T11 停 /sync 即关闭窗口
- Minor（defer）：生产 resolver closure 无直接测试；routeChunkToBuffer 双重暴露；size>0 弱代理；3 处 mock 死键

### Task 7: complete (commits 040bb7e..ee723bb, review clean)
- SessionService：sendUserMessage 写入链（INSERT→touch→push→P2P→冲突→路由）+ resolveTarget 四分支 + router/window 注入接线
- 940/940 + typecheck 双 clean + eslint 0
- Minor（defer，下游行为备注）：团队会话 @ 非成员时协调 agent 会接待（原"!hasAnyMention"守卫未进新模型，brief 决定）；SessionRouter 多 streamSessionId? 可选字段待 T8 确认；测试 seed 裸 SQL 列清单
- 阶段一（T1-T7 立新）完成 → 进入阶段二（切流量）

### Task 8: complete (commits ee723bb..d813fde 含 controller lint 修复, review clean)
- session:* 9 invoke + 2 push 改名 + preload session 命名空间（api.session.*）+ im 桥接保持旧 UI 可用
- 956/956 + 407/407 + typecheck 双 clean；分支 lint 与 main 基线平价（6 预存）
- ⚠️ T9 必办交接：session.onMessage 只听 session:message，sync-manager/p2p 仍发 im:message——T9 切 store 时必须同时处理这两个发送方（反向桥接或改名），否则 Matrix 同步/P2P 消息不达新 store
- Minor（defer）：event-buffer.ts:11 注释半更新；ExportMessage 沿用 Matrix 命名字段（导出器改造时清理）

### Task 9: complete (commits d813fde..dfb8bfc, review clean)
- session.store 全量切换（26 场景 1:1 + 5 新 RED）+ preload 反向桥（session.onMessage 双听）+ 正向桥删除 + im.store 删除
- 413/413 renderer + 964/964 electron + typecheck 双 clean
- 交接 T11/12：删「反向桥（Task 9）」grep 锚点 + 3 个 im:message 发送方改名/删除
- Minor（defer）：refreshSessionList 1s 双拉冗余（T11 顺手清）；unsubscribe 测试占位断言；RoomList dissolved 告警随原子删除合理消失

### Task 10: complete (commits dfb8bfc..1375b10, review clean)
- createWorkspace→团队会话；agent 分配→本地身份 agent-<slug>-<suffix6> + session_members；buildSpawnOpts 新形状；RouterService 直达 assignmentId 路由
- v1 分支提前删除经裁定为结构性强制（base 已不可达死代码，行为保持）
- 958/958 + 413/413 + typecheck 双 clean
- **T13 范围扩展（必办）**：task_reply 回传链接线——runTaskChatLoop 完成时发 reply（sendTaskReplyEvent 已就绪零调用方）+ taskMessageListener 处理 'task-reply'；补端到端集成测试（现 dispatch 靠 9min 超时失败，主子调度生产不可完成）
- **T12 范围扩展（必办）**：task/starter.ts 仍调 createPlainRoom+inviteBotToRoom（对本地身份必败）——改 session-ops 创建 task_execution 会话
- Minor（defer）：runtime-entry.ts:325 旧注释段矛盾；agent_user_id 无 UNIQUE；seedFixture 预置 bot token 陈旧；文案/参数名残留

### Task 11: complete (commits 1375b10..1a90bc0, review clean)
- 切换点生效：boot 链零 Matrix 流量；auth 全删；App.tsx workspace 分支 + CreateWorkspaceDialog 首启态
- starter.ts 提前修复（裁定正当：活路径 + auth 删除后必挂/复活 Conduit）——task_execution 本地会话 + assignee 入 session_members
- T9 移交的 refreshSessionList 双拉已清偿；949/949 + 409/409 + typecheck 双 clean
- Minor（defer→T12 顺手）：starter.ts 三步写非事务（孤儿 session 行）；App.tsx load 失败与空列表不可区分；preset/sourceSessionId 路径不入成员表（v2 语义补全）

### Task 12: complete (commits 1a90bc0..ac51236, review clean)
- Matrix/Tuwunel 全家删除（54 files, −3226）；matrix-js-sdk 出库；im:* invoke 全删（onConflict 保留）；p2p 改发 session:message；反向桥删除；broadcastRuntimeChanged 迁 session-service；starter 事务化+回归测试
- 902/902 + 409/409 + typecheck 双 clean + build exit 0；grep 三项零残留
- Important（plan-mandated→并入 T13）：auto-start/message-target-resolver 死文件头注释失真（sync-manager 已删）+ 无 T13 标记
- Minor（defer）：integration-wiring 测试标题 im:message 失真；README Tuwunel 段落（docs task）；e2e conduit 引用

### Task 13: complete (commits ac51236..65915ce, review clean)
- task_reply 回传链接线（sub 发送→routeTaskReply→notifyTaskReply 广播→PM handleTaskReply；集成测试 56ms resolve 对比旧 9min 超时）
- v1 双轨删除（runtime-manager 661 行 + auto-start + message-target-resolver + decide-response）；AgentRuntimeOpts→runtime-config；runtime-entry 1571→899 行
- 858/858 + 409/409 + typecheck 双 clean
- ⚠️ 预存缺口登记（T8/后续）：子进程 audit:toolCall / mcp:* child IPC 在 task-driven 路径无消费者（audit.ts 注释失实已指认）；abort listener 累积（dispatch-wait）；routeAbortDispatch logs-only
- Minor（defer）：dispatch-wait 段头注释重复；MAX_TASK_SEGMENTS 注释过时

### Task 14: complete (commits 65915ce..8c2b696, 含验收 3 commits)
- 残留扫描 0 命中（migrations 历史SQL 14 处合法分类）；typecheck/测试/build 全绿；xvfb 冒烟通过（17→23 增量迁移真实验证 + 零 Matrix 进程）
- 交互式验收（真实 LLM 流式/重启一致性）留待 macOS 主机——DoD 唯一未闭环项

### Final review: APPROVED (fix round dab4414 验证通过)
- 6 项交叉审计全过；4 项 pre-merge 修复（2 失实注释 + 1 过期契约注释 + sqlite-provider 角色判定 agent-* 误判 user）
- 最终门禁：860/860 + 409/409 + typecheck 双 clean
- P2 开工清单（终审裁定）：① mcp:*/audit:toolCall child-IPC 桥恢复（spawner messageHandler 扩展 ~20 行）② routeAbortDispatch 真实现 ③ macOS 主机交互验收 ④ agent:stream 死推送处理
- DEFER-OK：abort listener 累积 / taskDriven 列 / 旧 sender 显示 / App.tsx load 歧义 / N+1 / 命名漂移

## P1 session-core 全部完成（20 commits, 75897b8..dab4414）

## 2.0.0 P2 ui-shell（feat/v2.0.0-p2-ui-shell，基线 c8f6c90）

### P2 Task 1: complete (commits c8f6c90..551c5d5, review clean)
- 无边框窗口 + window-ipc 四通道 + window-state kv 持久化（clampToDisplays 纯函数）
- 864/864 + 409/409 + typecheck 双 clean
- Minor（defer）：clamp 仅查左上角；getAllWindows()[0] vs 分离 DevTools；崩溃不存状态
- 预存 lint（runtime-entry ×2 / task-tools ×1）→ T11 收尾 chore

### P2 Task 2: complete (commits 551c5d5..157277c, review clean after fix round)
- TitleBar + WorkspaceTabs（右键菜单/重命名/删除/打开目录）+ workspace:rename/openDirectory 通道 + MainShell 接线
- 修复轮：mac 红绿灯 78px 占位 + rename 空名校验（测试锁定）
- 871/871 + 436/436 + typecheck 双 clean
- ⚠️ T3 必办移交：首启空态无 TitleBar（frameless 无拖拽/关闭）——T3 处理 App.tsx 空态外壳
- Minor（defer）：拖拽区点击不关右键菜单（补 window blur 兜底）；菜单无键盘可达性；MainShell 组合无直接测试

### P2 Task 3: complete (commits 157277c..583fd56, review clean)
- ActivityBar + Sidebar/ViewSidebar 统一侧边栏 + TaskBoardView 拆分（selectedTaskId store 化）+ LeftRail/WorkspaceSwitcher/ResizableSidebar 退役 + App 空态 TitleBar（T2 移交清偿，embedded 方案）
- renderer 461/461 + typecheck 双 clean
- Minor（defer）：空态双表单叠影（＋ 开 modal 盖内嵌）；embedded 取消无操作；Ctrl+Shift+B 未排除；筛选态随折叠丢失

### P2 Task 4: implemented (commit 5fedeab) ——⏸ 已暂停：实现完成、未审查
- SettingsCategory +default_model/about −account；7 菜单重排 190px；Esc/← 返回；占位组件就位
- renderer 473/473 + electron 871/871 + typecheck 双 clean
- **恢复点：T4 待 review（package 命令 base=583fd56）→ 通过后 T5 起**
- 位置：阶段 A 完成（T1-T4），下一步阶段 B（T5 v24 数据模型）

### P2 Task 4: complete (commits 583fd56..5fedeab, review clean)
- SettingsCategory 增删 + 7 菜单重排 190px + Esc/← 返回 + 占位组件（T7 替换）
- renderer 473/473 + electron 871/871 + typecheck 双 clean
- Minor（defer）：store 初始值断言套套逻辑；Esc 双监听毛边（settings+tab 菜单同按）；5 文件行尾换行
- 阶段 A（T1-T4）完成 → 阶段 B（设置功能）

### P2 Task 5: complete (commits 5fedeab..ffb99b6, review clean)
- Migration v24 逐字落地 + provider platform/ProviderModel CRUD + GlobalSettings 扩展（auditQuotaMb 默认 100 + 四类 DefaultModelRef）
- 895/895 + 473/473 + typecheck 双 clean；存量行回填/幂等不重置均有真 DB 测试
- Minor（defer）：CHECK 测试裸 toThrow 可收紧；upsert ghost provider FK 抛错未测（T6 可锁定）；悬空引用 T8 消费端记账

### P2 Task 6: complete (commits ffb99b6..9793d8b, review clean)
- fetchRemoteModels(SSRF 镜像) + 5 provider IPC + 两列 ProviderSettings + ProviderDialog platform 化 + ProviderModelList
- 912/912 + 495/495 + typecheck 双 clean；ghost FK 锁定测试落地
- Minor（defer）：ProviderModelList 切换 stale 响应无 stale-guard（可 key= 对齐）；检查连接空 model 兜底两处不一致；徽标 N+1 IPC

### P2 Task 7: complete (commits 9793d8b..8796d44, review clean after fix round)
- DefaultModelSettings 四卡级联下拉 + About（修复轮补 electronVersion）+ 清除断言加固 + init try/catch
- renderer 507/507 + electron 912/912 + typecheck 双 clean
- Minor（defer）：About.test 模块级 mock；SettingsView 桩缺 system；stale modelId 回显；EOF newline

### P2 Task 8: complete (commits 8796d44..280ad0b, review clean)
- audit/quota.ts + insert.ts + spawner audit:toolCall 桥（闭包补身份 + 200 计数巡检）+ 3 IPC + AuditLog 配额卡
- 937/937 + 515/515 + typecheck 双 clean；滞回回归锁（711 行带内 no-op）
- Minor（defer）：tools/shared/audit.ts 过时注释（说无消费者——本任务就是恢复者）；getQuota 双查询；enforce 循环全表重扫 + batchSize 无下界；输入不回显覆盖值

### P2 Task 9: complete (commits 280ad0b..3432fff, review clean after fix round)
- MCP child-IPC 桥 + 死通道防御（4 send 站点）+ 非错误收敛 + 池惰性填充 ensureMcpStarted（controller 范围扩展，P1 终审项端到端闭合）
- 950/950 + typecheck 双 clean；冻结协议完好经复审核实
- 观察（defer）：sendMcpResponse 吞所有 send 异常（取舍正确）；全仓无进程级 unhandledRejection 兜底（纵深防御）

### P2 Task 10: complete (commits 3432fff..d829909, review clean)
- routeAbortDispatch 实装（广播 abortStream 同构 notifyTaskReply）+ agent:stream 死推送全链删除（含回归锁负向断言）
- 954/954 + 515/515 + typecheck 双 clean
- Minor（defer）：空 runners 双日志；缺 task_id 分支未单测；dispatch-wait.ts:114 持久化措辞漂移（P1 遗留，transient 桥下"后续启动也能收到"不成立——正式记 P3 清单）

### P2 Task 11: complete (commit 9f75b75)
- 残留扫描零活代码命中；typecheck/test/build 全绿；xvfb 冒烟通过（ABI 坑按 AGENTS.md 预案处置：electron-rebuild 后 Window ready + 16 组 IPC + v24 migration + 零 Matrix）
- 观察（defer）：electron bin 在 workspace .bin；dist stale 残留需 build clean（P3）；冒烟前需 electron-rebuild 切 ABI

## P2 ui-shell 全部完成（11 commits, c8f6c90..9f75b75）——待终审

## Final review fixes
- README.md:513 技术债行勘误——「model_providers 表无 platform 字段」已加删除线 + 重写为「v24 已加 platform 列 + CHECK 约束 + 设置页显式下拉；运行时接线归 P3」（spawn-helpers 需把 provider.platform 传入 createLLMProvider 的 model.provider）
- README.md:520 已知限制条目勘误——「LLM platform 按 baseUrl 启发式检测」改写为「设置层已可显式指定 platform（v24），但运行时仍走 baseUrl 启发式（P3 待办）」
- README.md 技术债务跟踪表追加两条 P3——「provider.platform 运行时接线」+「provider testConnection 空 model 兜底不统一」
- electron/src/main/agent/tools/shared/audit.ts:6-11 头注释纠偏——删除「v2 P1 暂无主进程侧消费者」过时措辞，改写为「runtime-spawner messageHandler audit:toolCall 分支消费 → insertToolCall 落库 + 200 计数配额巡检」如实描述现状（P2 Task 8 已恢复该桥）

### P2 Final review: APPROVED (fix round fdc941b 验证通过)
- 6 项交叉审计全过（布局组合/provider 链/审计链/MCP 链/死代码/范围扩展）；Deferred-Minor 无 MUST-FIX
- 修复轮：README 技术债勘误 + platform 接线 P3 记账 + audit.ts 注释纠偏
- 最终门禁：954/954 + 515/515 + typecheck 双 clean + build + xvfb 冒烟

## P2 ui-shell 全部完成（16 commits, c8f6c90..fdc941b）——已过终审可合并

### 合并前门禁观察（如实记录）
- 首轮 root test 出现 1 次 renderer 失败（未捕获到用例名，grep 截断）；随后连续 5 轮全绿（515+954 ×2 root 级 + 3 次 renderer 单独）
- 判定：一次性 flaky（与项目已知 vitest transform cache 偶发 stale 特征吻合）；P3 观察清单记录，若复现需定位捕获用例名

## 2.0.0 P3 cleanup-ipc（feat/v2.0.0-p3-cleanup-ipc，基线 3676f8a）

### P3 Task 1: complete (commits 3676f8a..2ecafd8, review clean after fix round)
- provider.platform 运行时接线（buildSpawnOpts→RuntimeConfig.modelPlatform→createLLMProvider 显式 provider；undefined 回退启发式）
- 960/960 + 515/515 + typecheck 双 clean；修复轮补注释清剿
- Minor（defer）：undefined 用例 not.objectContaining 精度；parseConfig 字面量分支无专项测试

### P3 Task 2: complete (commits 2ecafd8..19c4190, review clean after fix round)
- defaultChatModel 写路径兜底（ghost warn 区分）+ testConnection 空 model 结构化错误 + Dialog 硬编码删除
- 966/966 + 515/515 + typecheck 双 clean
- Minor（defer）：README:516 技术债行过时（T9 收尾清）；DefinitionEditor 前置校验使 fallback 对标准 UI 潜伏（未来放宽表单才显性）；测试 EOF newline

### P3 Task 3: complete (commits 19c4190..840b061, review clean + follow-up verified)
- MentionInput 现役化（@/# 双菜单，diff ledger 9 项先行）+ MessageInput 退役 + 潜伏正则 bug 修复
- Follow-up：insertTask 默认 id 改 T-序号（nextTaskId max-scan）——#T mention 端到端闭合（repo↔regex 双侧配对锁定）
- 970/970 + 524/524 + typecheck 双 clean
- Minor（defer）：菜单无方向键导航/Enter 选首项；零匹配时 Enter 被吞；insertMention 光标边界；TASK_MENTION_REGEX 未导出（测试复刻有漂移风险）

### 观察记录（T4 期间）：实现者报告 renderer 37 失败「预存」——控制器复核单独跑 37/37 绿 + 全量 531/531 绿
- 判定：环境性 flaky（vitest 并行 transform cache 族），非预存失败；基线真实干净。P3 收尾时若复现需定位（与 P2 合并前 flaky 同族）

### P3 Task 4: complete (commits 840b061..415dce4, review clean)
- assignee 筛选实数据（dumb TaskFilters + sidebar 派生 + workspace 过滤）+ 进入执行会话接线（顺序断言锁定）
- 531/531 + typecheck 双 clean（控制器复核 37 失败为环境 flaky 非预存）
- Minor（defer）：TaskSidebarPanel 派生逻辑零覆盖；.catch 兜底对现行 selectSession 是死代码；按钮隐藏测试未隔离变量；makeTask 无类型锚定

### P3 Task 5: complete (commits 415dce4..4918b26, review clean)
- L2 能力面板挂载（AgentsView workspace tab）+ 头注释纠偏 + 链路核实（preload/types 抽查吻合）
- 536/536 + 970/970 + typecheck 双 clean
- Minor（defer）：无折叠交互 + L2 区无高度上限；报告误引 brief 原文（可信度注意）；测试死代码桩

### P3 Task 6: complete (commits 4918b26..0655eaa, review clean)
- merger 单一 owner（readAllocationLayer/readAssignmentDeltas 门面 + 类型 re-export）；spawn-helpers 重指向；CRUD 导出按 plan 约束保留
- 972/972 + typecheck 双 clean；relocation lock 真 DB 测试
- Minor（defer）：测试文件 EOF newline

### P3 Task 7: implemented (commit 78cfb52) ——⏸ 已暂停：实现完成、未审查
- resource:registerMcp/uploadSkill 收敛 + mcp:register/skill:uploadZip 退役 + Dialog 切换（grep 零活代码残留）
- 975/975 + 537/537 + typecheck 双 clean
- **恢复点：T7 待 review（package base=0655eaa）→ 通过后 T8（杂项收尾）→ T9（验收+终审）**
- 位置：P3 9 任务完成 7 个（T1-T6 已过审，T7 待审），剩 T8/T9

### P3 Task 7: complete (commits 0655eaa..78cfb52, review clean)
- resource:registerMcp/uploadSkill（listResources 复用取回，零手拼）+ mcp:register/skill:uploadZip 退役 + skill handlers 文件删除；grep 零活引用
- 975/975 + 537/537 + typecheck 双 clean；version? 超集裁定可接受（''→'1.0.0' 展示改善）
- Minor（defer）：ResourceLibraryView mock 桩返回 null；通道计数 arrayContaining 不精确；version 缺省变化记 CHANGELOG

### P3 Task 8: complete (commits 78cfb52..735e5a3, review clean)
- audit 分支 try/catch 对齐 MCP 风格（计数器语义核查为隐式正确取舍）+ abort 空日志 early return + dispatch-wait/v22 注释纠偏
- 977/977 + 537/537 + typecheck 双 clean
- Minor（defer）：空 runners info 抑制无直接断言（logger mock 惯例缺）

### P3 Task 9: complete (commit 4feabb2)
- 残留扫描三条全合规（13 命中全注释，分类在案）；typecheck/test/build 全绿零 flake；xvfb 冒烟通过（14 组 IPC 含 Resource；ABI 坑预案处置）
- 观察：60s timeout SIGTERM 偶发 FATAL 为强杀噪音（30s 复测干净）；交互验收留 macOS 主机

## P3 cleanup-ipc 全部完成（9 commits, 3676f8a..4feabb2）——待终审

## Final review fixes
- README p3 状态块 fallback 措辞纠偏：明确「新建时兜底；表单校验放宽与保存路径扩展留 P4」（消除「新建/保存」与「updateDefinition 无 fallback」描述偏差）
- mention-parser 孤儿处置：删 renderer/src/lib/mention-parser.ts + tests/lib/mention-parser.test.ts；两处同源正则注释指 conflict-detector.ts 的 TASK_MENTION_REGEX 为唯一权威源
- 正则权威源导出：conflict-detector.ts TASK_MENTION_REGEX 改为 export + JSDoc 标注唯一权威；tasks-repo.test.ts 改 import 该常量（消除漂移——终审 Minor 3）

### P3 Final review: APPROVED (fix round c02731f 验证通过)
- 5 项跨任务接缝全过（platform 链/T-id 约定/MentionInput 独占/IPC 面/L2 能力）；Deferred-Minor 无 MUST-FIX
- 修复轮：README fallback 措辞 + mention-parser 孤儿删除 + TASK_MENTION_REGEX 权威源导出
- 最终门禁：977/977 + 525/525 + typecheck 双 clean + build + xvfb 冒烟

## P3 cleanup-ipc 全部完成（13 commits, 3676f8a..c02731f）——已过终审可合并

## 2.0.0 P4 lan-sync（feat/v2.0.0-p4-lan-sync，基线待记）

### P4 Task 1: complete (commits ecf835f..f31fd71, review clean)
- protocols.ts 四接口 + 导出 guard；枚举收敛五实义值（hub-transport presence 属独立 wire 联合经核实）；P2pSync switch 化多路分发 + 双广播/双单发
- 986/986 + 525/525 + typecheck 双 clean
- Minor（defer）：guard status 宽松（T3 remote-cache 可收严）；报告浅拷贝措辞

### P4 Task 2: complete (commits f31fd71..e45f915, review clean)
- task-broadcast.ts（7 字段裁剪 + 镜像 no-op）+ 四 handler + scheduler 触发接线（吞错链三层闭环）
- 999/999 + 525/525 + typecheck 双 clean
- **T3 必办移交**：agent 自主终态（task-tools complete/fail + dispatcher 捡单）不触发广播且无兜底——T3 加低频周期重播（30s-60s interval）作为陈旧窗口兜底
- Minor（defer）：T1 回调占位未传（Task 3 接回时一并）；ipc.handlers 叶子 import vs 门面先例不一致

### P4 Task 3: complete (commits e45f915..4b8f031, review clean)
- remote-cache.ts 内存缓存（键控验签 fromNodeId）+ 45s 重播兜底（T2 移交清偿）+ p2p:getRemoteTasks + 看板远端只读分区
- 1007/1007 + 529/529 + typecheck 双 clean
- Minor（defer）：远端卡无 nodeId 悬停线索；相对时间断言时序敏感（毫秒级可忽略）

### P4 Task 4: complete (commits 4b8f031..2f01661, review clean after fix round)
- resource-share.ts（目录构建排除 skill 双层防线 + 缓存 + 读口 prune 修复轮）+ listResources 四源合并 + P2P tab + 六写通道触发 + 5min 兜底
- 1032/1032 + 531/531 + typecheck 双 clean
- Minor（defer）：短路测试未断言 listCustomResources 不调；resolveResourceById p2p 往返 T5 补测

### P4 Task 5: complete (commits 2f01661..40c6d60, review clean)
- resource-transfer.ts（requestId 配对三路清理 + 30s 超时 + not-found null 语义）+ 供给方组装保真 + install p2p 分支（item.slug+peerId 直消费优于 brief slice 方案）+ resolveResourceById 往返补测
- 1058/1058 + typecheck 双 clean；agent 副本/mcp 幂等非对称语义按 brief
- Minor（defer）：迟到 provide 无显式测试；agent 三次导入 def.slug 重复行；readToolRefs kind 未收窄字面量

### P4 Task 6: complete (commit e76c500)
- 残留扫描/只读铁律零命中；1058/1058 + 531/531 + build 全绿无 flake；xvfb 冒烟（ABI 预案处置 + 第二进程 mDNS browse 佐证发布）
- 发现（2.1 清单）：同身份双实例触发 bonjour Service name already in use 未捕获崩溃——P1 传输层既有，真实双机不触发

## P4 lan-sync 全部完成（7 commits, ecf835f..e76c500）——待终审

## Final review fixes
- renderer 导入反馈闭环：resource.store.installResource 包 try/catch（失败写 error 不 rethrow，避免 p2p 离线/未找到/超时 unhandled rejection）；成功设置 installNotice 字段；View 渲染一次性绿色横幅；filter 切换/setQuery/失败路径清掉陈旧提示；新增 store 级契约测试 + ResourceLibraryView install 失败/成功两条端到端
- 死 IPC 清理：移除 p2p:getSharedResources handler 注册（renderer 走 resource:list → listResources 间接消费 getSharedResources()）；index.ts 头注释通道数 7→6；resource-share.test.ts ⑥/⑥b 改直接调 getSharedResources()
- agent 导入 slug 后缀循环：resource-transfer.findFreeAgentSlug 抽离，候选序 orig → -from-{nodeId前4} → ...-N（cap 20）；新增 ⑤c 三次连续导入测试断言三个 distinct slug

### P4 Final review: APPROVED (fix round b546228 验证通过)
- 5 项跨任务接缝全过（协议闭环/缓存对称/广播不变量/只读铁律/UI 降级）；107 新测试
- 修复轮：导入反馈闭环 + 死 IPC 清理 + slug 后缀循环；独立复跑 1059/1059 + 537/537
- DEFER-OK（2.1 清单）：bonjour 双实例崩溃（~3 行 error 监听，置顶）；横幅文案两处化妆级

## P4 lan-sync 全部完成（8 commits, ecf835f..b546228）——已过终审可合并

## 2.0.0 P5 release（feat/v2.0.0-p5-release）

### P5 Task 1: complete (commits 4464fd6..f42ba86, review clean)
- upgrade/ 三模块（检测/导出/编排）+ boot 接线（runMigrations 前钩 + 迁移后 kv）；复用 formatRoomToMarkdown；WAL 真场景测试
- 1068/1068 + typecheck 双 clean；旧列名以 migration 源码核实
- Minor（defer）：rename 三件套无回滚（单实例+boot 无句柄，近零概率）；旧 agent sender 导出标 👤（化妆）；「最近 N 条」措辞
- T2 需容忍：导出失败仍返回空 exportDir

### P5 Task 2: complete (commits f42ba86..fb8801d, review clean)
- UpgradeNotice 非模态卡片（select-all 路径 + dismiss 清 kv 崩溃安全语义）+ App 单次 invoke 同屏 + system 双通道
- 548/548 + 1074/1074 + typecheck 双 clean
- Minor（defer）：dismiss promise 未接 catch；空目录文案轻微过度承诺；文案断言正则偏弱

### P5 Task 3: complete (commits fb8801d..7b03333, review clean after fix round)
- 三处版本 2.0.0 + README 发布块（修复轮：备份文件名对齐 legacy-upgrade.ts + 措辞机制中性化 + 报告勘误）
- 1074/1074 + 548/548 + build exit 0（NODE_OPTIONS=4g 防 Vite Monaco OOM）+ frozen-lockfile 零变更
- Follow-up（2.1）：NODE_OPTIONS 固化进 build 脚本或 vite chunk 拆分

### P5 Task 4: complete (commit f53204a)
- 残留扫描零命中；1074/1074 + 548/548 + build（asar 内嵌 2.0.0 验证）；xvfb 双启动冒烟（新库迁移 + 二次零重放 + 零 Matrix）
- DoD 七条对照：3/5/7 容器闭环，1/2/4/6 单测在册归主机清单——达发布 DoD 无阻塞

## P5 release 全部完成（5 commits, 4464fd6..f53204a）——待终审（2.0.0 五期收官）

## Final review fixes
- spec `2026-08-23-v2.0.0-platform-refactor-design.md` §8 追加 2026-08-24 裁定补记：agent 定义导入降范围为「导出 JSON + 手动导入」，2.0.x 恢复自动化
- `electron/src/main/upgrade/legacy-upgrade.ts` rename 三件套改为 -shm → -wal → 主库（最后）：部分失败时主库仍在原位 → 下次启动重触发检测幂等重试；避免主库先改名而 wal/shm 残留导致下次启动在陈旧 wal 旁建新库
- README 打包节新增 NODE_OPTIONS=--max-old-space-size=4096 build 一行（容器/低内存环境防 Vite Monaco OOM，2.1 拆 chunk 根治）
- tests/upgrade/ 全绿（3 describe / 15 it）+ electron 1074/1074 + typecheck 双 clean

### P5 Final review: APPROVED (Yes) + 收尾项 e60abe8 闭合
- Important（记录性）：spec §8 agent 导入降范围裁定补记；加固：备份改名 wal/shm 先/主库后（部分失败自愈）；README 打包 NODE_OPTIONS 说明
- 最终门禁独立复现：1074/1074 + 548/548 + build asar 2.0.0 + WAL 真场景实证
- DEFER（2.1）：NODE_OPTIONS 固化/vite chunk 拆分；空目录 kv success 标志；agent 导入自动化（2.0.x）

## P5 release 全部完成（6 commits, 4464fd6..e60abe8）——2.0.0 五期收官

## macOS 主机验收陪跑（2.0.0 发布后）
模式：用户在 macOS 主机实测全功能；容器侧待命——bug 报告 → 定位 → 修复 → 过审 → 合并推送。验收清单锚点：README DoD 表 1/2/4/6 + P4 双机联调 + 1.x 升级实测。

### 主机验收 P0 修复 ×2（ddf3970 + 本 commit）
- P0: sendTaskEndAndExit 裸调用 process.send 崩溃（错误路径全灭）+ LLM fetch 错误无 cause
- P0-2: stream-relay start/segment_boundary 不推 session:message（agent 气泡实时不可见）
- 全链路 harness（真实 LLM glm-5.3 + dist 生产代码）：主进程 E2E PASS
- 用户侧待复验；「owner 消息重启后不显示」未复现根因，待复验数据

### 主机验收 P0 修复 ×3（ddf3970 + b30c6af + 8fbb744）
- P0: sendTaskEndAndExit 裸调用 process.send 崩溃（错误路径全灭）+ LLM fetch 错误无 cause
- P0-2: stream-relay start/segment_boundary 不推 session:message（agent 气泡实时不可见）
- P0-3: aggregator 硬编码 final{status:'done'} + MessageBubble 不分发 failed/有 error（错误文本永远不可见）

主进程 e2e harness（dist 生产代码 + 真实 LLM glm-5.3）：PASS
- 用户消息 + agent 回复 + 66 events + final(done) 全部落库正确
- listMessagesBySession 返回用户行+agent 行双行（无主进程过滤）

症状 #2（重启后用户消息消失）：主进程数据层完全健康；DB 直查确认 user+agent 两行均在。
renderer 渲染层需实地复现或用户提供 sqlite 查询输出。

### P0-4（8fbb744 后续）：重启后用户消息不可见
- 根因：hydrateFromEvents 对零事件消息灌入 aggregateEvents([]) 默认 streaming 状态
- 用户 DB 实证：owner 消息全部落库正常（3 session 全有配对行）——纯 renderer 显示层
- 修复 + 回归锁 ×3；遗留：孤儿 streaming 行（崩溃时代数据）不改（与 P1 restart-consistency 语义冲突）

### P0-5：实时流式内容全部丢失（去重键误杀）
- 根因：event-buffer onFlush 传 id:'buffered' 占位（全部同 id）+ renderer 按 id 去重 → 首批后全部实时事件被丢弃
- 表现：实时只见"流式中"状态条；重启拉 DB 完整（用户 DOM 对比实证）
- 修复：insertEventBatch 返回真实 id 行 + renderer 去重改桶内 seq；回归锁 ×3
- 真实 LLM 复验：48 events / 48 唯一 id / done

## 主机验收累计：P0 ×5（错误路径崩溃 / 气泡不推 / 错误文本吞 / 用户消息幽灵流式 / 实时内容去重误杀）

### 功能优化：agent 回复时间线渲染（1b56b7b）
- segments 时间线聚合 + AgentStreamBubble 线性渲染（思考/工具/正文按实际发生顺序交错）
- 回归锁 aggregator ×5 + 组件 ×2；566 + 1079 全绿
- push 遇 GitHub TLS 间歇故障，待重试

### 功能优化：子 agent 工作过程实时显示（532cf69）
- 根因：AgentStreamBubble 从未传 subStream 给 DispatchChip（A9 遗留未接线）
- DispatchSegment 反查链 + chip 活动提示（💭/🔧/✍️ + ⏱）+ SubAgentSection 时间线化
- 回归锁 ×11；577 + 1079 全绿

### P0-6（cf5bc36）：dispatch 渲染成普通工具卡片
- 根因：上轮 DispatchSegment 依赖 dispatch_start 事件，但生产链路 dispatch 以 tool_call_start(isDispatch) 落库，该事件从不产生
- 聚合器按 isDispatch 分流；回归锁 ×4；581 全绿

### P0-7（bebeb2f）：dispatch 嵌套展开区空（ID 断链）
- 根因：PM chunk 查找键 UUID-A ≠ routeDispatch 自造子 task 流 id UUID-B；子消息 parentStreamSessionId 塞入幽灵 UUID-A
- 修复：dispatch 消息双流 id 字段（sub_stream_session_id 同源化 + tool_stream_session_id 语义归正为 PM 流 id）
- 回归锁 ×3；1082 + 581 全绿。注意：历史消息（修复前派发）嵌套展开仍为空——旧数据无同源 id，属预期

### 主机验收·嵌套展示攻坚收尾
- 容器真机探针（xvfb + CDP + 真实 LLM 数据 + renderer 重建）：chip 展开 → SubAgentSection 完整渲染 PASS
- __momoDebug 钩子 ship；容器基线输出（子行 messages+streamKeys 双命中）
- 用户侧仍空 → 待 __momoDebug() 输出定位（唯一未验环节 = 用户 app 的 store 状态）

### P0-8（用户 __momoDebug 输出定位）：dispatch 事件路由到团队会话
- 症状：用户会话 store 无子行（事件却进 streams）→ 子行落在 teamSessionId
- 根因：executeDispatch 用 config.teamSessionId 而非当前执行会话
- 修复：executionSessionId 线程化传入；harness 普通会话复现→修复后 PASS
- 1084 + 582 全绿

### 运维面对齐 2.0.0（8ee6eb4）
- dev.mjs 编排器（vite HMR + tsc watch + Electron 依序拉起）——根治 stale renderer 运维坑
- CI 删 Tuwunel 全段 / Node 22→20 / renderer build NODE_OPTIONS ×3
- setup/release 文档纠偏（错误包名、版本三处、conduit 段删除）；conduit-manual.md 删除
- 容器实测 dev 编排器：vite→tsc→Electron Window ready 全链路 PASS

### 运维面对齐 2.0.0（c9298bc + ci patch）
- dev.mjs 编排器（vite HMR + tsc watch + Electron 依序拉起）——容器实测全链路 PASS
- root build 固化 NODE_OPTIONS；setup/release 文档纠偏；conduit-manual.md 删除
- CI 变更（删 Tuwunel / Node 20 / renderer 内存）因 PAT 无 workflow scope 无法直推，
  以 docs/dev/ci-2.0.0-align.patch 入库，待主机 git apply + push

### dev 编排器热修：vite 探测被代理劫持（fetch→TCP）
- macOS 主机症状：vite+tsc 起来但 Electron 不启动——fetch 走 HTTP_PROXY 探不到 localhost
- 修复：node:net 裸 TCP 双栈探测；死代理环境模拟复现→修复后 Window ready PASS

## 主机验收陪跑会话收束（2.0.0 发布后）
- dev 编排器代理兼容修复经主机确认 PASS——dev 体验终态（vite HMR + tsc watch + Electron）
- 待主机遗留：git apply docs/dev/ci-2.0.0-align.patch（CI 文件需 workflow scope，容器凭据推不了）
- 本会话累计：P0 ×8 + 时间线渲染 + 子 agent 工作过程显示 + __momoDebug 钩子 + devops 对齐（含 2 热修）
- 测试基线：electron 1084 / renderer 582 / typecheck 双 clean

### 研发规则体系落地（628c57c）
- AGENTS.md 红线 + skills ×3（debug/test/boundary，场景化自动加载）+ engineering.md 完整复盘
- 自审通过：frontmatter 合规、name=目录名、触发词齐备

### 主机验收第二轮 4 问题（3545e97）
- #2 PM 自动接待：resolveTarget 加 main 角色分支（JOIN 取 role）
- #4 IME 选字误发：isComposing/keyCode 229 双判定
- #3 会话草稿：Map keyed by sessionId 切换保存恢复
- #1 邀请列表冷启动空：MainLayout 挂载即载 assignments（CDP 复现排除主链路后定位）
- 回归锁 +8；1088 + 586 全绿

## v2 fix: dispatch-parallel（2026-08-25）

Plan: docs/plans/2026-08-25-dispatch-parallel.md
Spec: docs/specs/2026-08-25-dispatch-parallel-design.md
Base commit: 35aa86d

### Task 1: complete (commits 35aa86d..d95a9df 含 plan/report docs 提交, review clean)
- dispatch-parallel.test.ts 478 行 8 用例：4 红（并发派发先后/chip 同时出现/sub-budget 均分/批次中断）/ 4 绿（回填顺序/预算截断/混排/重复检测）——精确命中 brief 预期
- 审查员字节级比对 brief 代码一致 + 自跑 typecheck clean + 串行执行推演验证 4 红断言必红
- Minor（defer→终审清单）：① test2 第三断言 10ms/50ms 时序敏感（brief 代码固有）② test6 残留 500ms 迟到回执（无害）③ 报告措辞两处（harness 未导出/mock 不读 this）④ 实现者跳过 typecheck（审查员已补验 clean）

### Task 2: complete (commits d95a9df..d8b6c7e, review clean)
- runtime-entry.ts 三段式重构（+167/−58）：execDispatchCall 闭包 / 游标 while / 段扫描截断 / allSettled 并发 / 保序回填 / 预算预扣均分
- 回归锁 4 红→全绿 8/8；6 既有套件 53/53 零回归；typecheck 双 clean
- 审查员独立推演 6 项并发风险全过（保序/中断/预算/游标完备/重复窗口/dispatchInfo 独立）+ 2 项 out-of-diff 核查（无未推进 continue / executeTool async 无同步抛）
- Minor（defer→终审清单）：① ti++;continue 单行写法（brief 逐字）② 段边界 abort 检查比旧串行更严格（settle 后 race 窗口内也立即 interrupted，§6.1 设计如此）③ 报告 Concern 3 推理略过度（代码正确）

### Task 3: complete (commits d8b6c7e..3a6750e, review clean)
- pm-agent.yaml 文案替换 + formatDispatchHint 第 5 条教学 + 测试 2 用例（TDD 红 1/9 → 绿 10/10）
- brief Step 2「其余 10 条」为计划笔误（8+2=10，红阶段应 1 红 9 绿）——实现者正确诊断未盲从
- Minor（defer→终审清单）：① YAML 教学文案无回归锁（brief 未要求，3 文件约束内不可加）② 用例 2 只锁 OR 早退分支的非 main 侧（main+空 subAgents 侧未锁，brief 代码如此）

### Task 4: complete (验收通过，无代码改动)
- electron 全量 154 files / 1195 tests 全绿零 flake；typecheck 双 clean；契约面 diff（dispatch.ts/stream-chunk.ts/preload/renderer）空输出
- 计数疑问已解：基线 dd2ad82 = 153 文件/1185 用例（计划中 1084 为 ledger 陈旧数字），+1 文件/+10 用例与本分支吻合
- 控制者亲自复跑新测试 10/10 绿 + 分支改动面核对（恰为预期 7 文件）

## dispatch-parallel 全部 4 Task 完成（35aa86d..3a6750e + 验收）——待终审

### Final review: APPROVED (Ready to merge = Yes, 2026-08-25)
- 零 Critical/Important；并发正确性/预算算术/保序/中断路径/契约零改动/下游就绪（WarmPool/activeTasks/routeDispatch）逐项源码级核实
- 修复轮（文档级）：spec §4 伪代码「段长 1 走原路径」改为「统一经批次路径（公式恒等）」+ plan Task 4 命令 dispatch.ts→dispatch-wait.ts 文件名勘误
- Deferred（下一 PR 顺手清单，合计 <30 行测试 + 1 行注释）：
  ① main+空 subAgents 早退分支锁 `expect(formatDispatchHint(makeConfig({role:'main'}))).toBe('')`
  ② pm-agent.yaml 教学文案锁（读 YAML 断言关键短语）
  ③ 单成员失败并发隔离用例（A 回 failed / B 正常，spec §12#3）
  ④ 段扫描被截成员签名窗口约束注释（若截断改「继续」需回滚窗口）
  ⑤ subStatus 按 errMsg.includes('超时') 判定 → dispatch 错误码结构化时一并处理
  ⑥ test2 时序断言余量放大 10/200ms（可选）；ti++;continue 拆两行（下次触碰顺手）
- 测试基线更正：electron 全量现值 154 文件 / 1195 用例（README 1074 为 P5 收官时点数，中间有增长）——后续验收以此为准

## dispatch-parallel 全部完成（8 commits, 35aa86d..终审修复轮）——已过终审

### 终审 Deferred 清单清偿（3/6，2026-08-25）
- ① main+空 subAgents 早退分支锁（OR 条件另一半）✅
- ② pm-agent.yaml 教学文案锁（readFileSync 断言双关键短语）✅
- ③ 单成员失败并发隔离用例（A failed / B completed，chip 状态+保序回填+stop 收敛三重断言）✅
- 13/13 全绿（新用例直接绿 = 锁当前正确行为）；typecheck 双 clean；相邻套件 23/23 零回归
- 剩余 defer：④ 段扫描窗口约束注释 / ⑤ subStatus 超时判定结构化（v1.4 既有，下次动 dispatch 错误处理时一并）/ ⑥ 时序余量放大与单行拆分（化妆级）

## agent-team-session-redesign（feat/agent-team-session-redesign，基线 3cde80f）

Plan: docs/plans/2026-08-31-agent-team-session-redesign.md
Spec: docs/specs/2026-08-31-agent-team-session-redesign.md

### Task 1: complete (commits 3cde80f..5f35c2d + 报告回填 523a007, review clean after fix round)
- migration v25 全量落地（members/teams/session_members 重建+is_leader/title_auto/default_agent/drop assignments+definitions.workspace_id）+ 必要偏差：同表直拷 + DROP INDEX idx_agent_definitions_workspace
- 修复轮：coordinator 悬空引用防护 UPDATE（去重后/直拷前）+ 去重×级联×重建三联动回归锁（RED=FK 中止取证）
- 6/6 + 023/024 + legacy-upgrade 15/15 全绿；typecheck 双 clean
- ⚠️ 全量 electron 245 失败/41 文件 = 预期破坏（stash 基线验证 1198/1198），留 T2-T15 重写；错误形态：96 team_session_id / 37 workspace_id / 10 agent_assignments
- Minor（defer→终审清单）：idx_wam_unique 未直接断言；last_running 搬迁未断言；test6 注释把去重级联归因为 DROP TABLE 隐式删除（断言不受影响）；agent_assignment_capabilities 空表残留（后续 task DROP）；MIN(rowid) vs created_at 语义（plan-mandated）

### Task 2: complete (commits 523a007..ccde99a + fix e51c053, review clean after fix round)
- 类型层切换：WorkspaceAgentMember/Team/titleAuto/isLeader + 15 文件机械调整（+323/−760）；结构性死亡代码删除（updateAssignmentRole/assignMain/sub-重启链，裁定授权）
- 修复轮：session:create 入参显式映射（字面量传参恢复编译期多余属性检查）+ 陈旧注释清理 + 报告第 5 处过渡态
- sessions-repo 12/12 + session.ipc.handlers 16/16；typecheck 双 clean；全量 226 失败/39 文件=基线严格子集零新增
- 过渡态披露 5 处（resolveTarget 收缩 / addToWorkspace 不入会话 / role 恒 standalone / deleteSession 无守卫 / session:create 字段改名）
- Minor（defer→终审）：基线对比需文件级清单；addSessionMember INSERT OR IGNORE 不支持 leader 升级（Task 7 换 upsert）；session-ops 注释「两表」实为三表
- Task 6 brief 必带：renderer session:create 字段对齐（memberInstanceIds）；Task 11：preload 悬空绑定（assignMain/updateAssignmentRole）

### Task 3: complete (commits e51c053..a26a354, review clean 一轮过)
- membership CRUD：addMember（async 偏离=keychain 语义）/removeMember（leader 守卫前置一切破坏性动作 + 事务内置空 default）/listMembers
- 范围扩展正当：runtime-registry/status 死 SQL 平移（T2 concern 4 指派 + 新流程硬依赖），9 例转绿
- membership-crud 9/9 + remove-assignment 重写 4/4（mock-db 反模式 → 真实迁移链 + keychain 注入）；全量 217/39 零新增（用例级 comm 验证）
- Minor（defer→终审）：addMember 行插入与 keychain 写非原子（注释建议）；「不存在 id 幂等」报告措辞；删除后 stop 抛错孤儿窗口（重启自愈）

### Task 4: complete (commits a26a354..ba31e2b+af07454, fix fbb997f, review clean after fix round)
- 团队服务七函数 + 事务原子性 + leader∈成员集 + ≥2 约束；3 项偏离（空名守卫/ws 收紧/幂等对齐）均评估接受
- 修复轮：addTeamMember 补 ws 归属校验（RED 实证漏洞）+ createTeam/addTeamMember 跨 ws 专项锁；Minor 顺手 2/3
- team-crud 25/25；typecheck 双 clean；全量 217/39 零新增（JSON 用例级集合对比——方法论升级）
- 遗留 Minor：getTeamRow `!` 非空断言（防御式）；全量对比统一 JSON reporter 建议（间歇 flake ±1~5 观测一次）

### Task 5: complete (commits fbb997f..853a98c, review clean 一轮过)
- setDefaultAgent（null 直清 / 非 null 校验 ws 归属 / 不存在 throw）+ getWorkspace 返回 defaultAgentInstanceId（T3 已备列映射）
- default-agent 5/5（含越 brief 的不存在 instanceId 错误路径专项）；typecheck 双 clean；全量 1026/217/39 零新增；renderer 624/624
- Minor（defer）：ws+instance 双不存在时错误文案先报成员（校验顺序）；IPC 通道 workspace:setCoordinator 旧名待 T6 改

### Task 6: complete (commits 853a98c..e1da545 + fix 7eff349, review clean after fix round)
- IPC 面全量切换：47 文件 +1172/−1106；退役通道四层零残留 + 负向注册锁；新通道 handler↔preload↔types 三方对齐；显式映射纪律全过
- 自裁①正当：SessionMemberInfo 生产者 isDefaultAgent→isLeader 快照（T2 契约偏差修正）；自裁②正当：AgentOrchestrator/AssignmentRoleEditor 类型强制提前删除（T12 缺额声明）
- 修复轮：session-ops.test.ts 整体重写 v25 契约锁（isLeader 快照独立性断言，生产路径写入）；头注释纠偏
- 本任务 43/43 + session-ops 31/31；typecheck 双 clean；renderer 621/621（−3 退役用例）；electron 全量 217→207/39→38（新基线）
- Minor（defer→终审）：isCoordinator 命名残留 runtime spawn-opts 域（RuntimeConfig 线协议面）；assign-local-identity fixture 死 role 字段；MentionInput.test describe 标题；session.store mockApi 死键 create；setDefaultAgent types Promise<void> vs {ok:true}

### Task 7: complete (commits 7eff349..837bee9, review clean 一轮过；网络中断后续接补完报告)
- 双流程真实现：insertSessionWithMembers 单事务核心（三路径收敛）；NoDefaultAgentError（message 子串契约与 T6 锁兼容）；CollabType 迁 session-ops 单一事实源
- title_auto 四象限 + 快照铁律测试（前提锁防 tautology）；session-ops 18/18 + handlers 20/20；全量 207/38 零新增
- Minor（defer→终审）：报告 createSession「系统命名路径仍在用」措辞失实（实为仅测试夹具）；collab 单 agent 跨 ws 仅 FK 校验（加固清单）；LSP never[] 全文件惯用法（单独 task 根治）

### Task 8: complete (commits 837bee9..e18fd8f, review clean 一轮过)
- session-naming.ts：截断占位（去换行 20 字）+ LLM 异步替换（leader 成员→def→provider→createLLMProvider 真实解析链）+ title_auto 竞态锁（SQL 守卫，并发双 final 确定性 Deferred 编排锁死）
- AND 裁定正确（OR 两处翻车各有专项锁）；mock 收窄仅 LLM 网络边界；19/19；全量 207/38 零新增
- **T9 必办移交（Important）**：① sender==='owner' 跨模块契约测试（生产写入路径落地时锁死字面量）；② repo.renameSession 单语句置 title_auto=0（飞行前手动改名防 LLM 覆盖）+ 回归测试
- Minor（defer→终审）：emoji 代理对切半；trim 在 slice 后前导空白耗预算；U+2028 未折叠；双 schedule 无 in-flight 去重

### Task 9: complete (commits e18fd8f..4ae5706 + fix d9aeadf, review clean after fix round)
- 路由五契约落地：pickRoutingTarget（mention 优先→is_leader 快照）/@ 直答/自动拉起（await ensureRunner 后派发不丢消息）/失效过滤（JOIN 过滤+readOnly）/命名接线（首条+首次 final）
- T8 双移交闭环：sender 'owner' 生产↔消费契约测试 + renameSession 单语句清 title_auto
- 修复轮 Critical：零 runner 启动 RouterService 不创建（两处早退删除+无条件 ensure+真实 bootstrap 接线测试+warn 留痕断言）
- session-service 重写转绿（基线 −18）；全量 189 红/1120 绿（新基线）零新增
- Minor（defer→终审）：失败流 final 也触发命名（白花 LLM）；自动拉起无 broadcastRuntimeChanged；首次拉起 spawn 时长计入 send 返回；rename 回归手抄守卫 SQL；resolveTarget 导出面；session-service.ts:10 头注释

### Task 10: complete (commits d9aeadf..c3764cd, review clean 一轮过)
- buildDispatchSnapshot（快照 JOIN+leader 子查询+跨会话并集去重）+ 注入条件 isLeader&&subAgents>0 + 线协议 isCoordinator→isLeader 两端改名（契约测试锁形状）
- 契约测试 10/10（真链路 JSON round-trip + buildRuntimeContext 导出消费）；删除 5 过时测试无覆盖丢失；全量 199→174 FAIL 净修复 25 零新增
- **插入 Task 10B（清理专项，最高优先）**：①agent_assignment_capabilities FK 悬空（v25 漏重建，agent:setMemberDeltas 生产炸）→ migration v26 重建 FK 指向 workspace_agent_members；②saveAgentDefinition 写已删 workspace_id 列（crud.ts:712 对应）；均预存 v25 债务，T12 UI 前必须清
- Minor（defer→终审）：离线成员入快照缺直接回归锁；slug 去重文档过强；runtime-entry:311 旧术语注释

### Task 10B: complete (inserted, commits c3764cd..7af6299, review clean 一轮过)
- v26 重建 agent_assignment_capabilities FK→workspace_agent_members + crud definitions 死列 4 处清理；setMemberDeltas 全链路回归锁（生产序列逐字对齐）
- 174→148 红净转绿 26 零新增；spawn-helpers FK 绕行 workaround 删除
- Minor（defer）：报告漏点 agent:list 传参消费方（行为净修复）；ipc.handlers:222 注释漂移；v25 级联用例断言平凡；runMigrations 无事务+CREATE 无 IF NOT EXISTS（基础设施债务）

### Task 11: complete (commits 7af6299..9135c40, review clean 一轮过)
- agent.store members 彻底更名 + teams 状态/7 action（teamsWorkspaceId reload 守卫）+ blockedTeams 透传；session.store 双会话 action + NO_DEFAULT_AGENT→needsDefaultAgent（重试复位时序锁）；workspaceId 消费清理（AgentLibrary source-only/DefinitionEditor 删 scope radio）
- renderer 643/643（+22 零新增）；typecheck 双 clean；preload 悬空绑定零残留
- Minor（defer）：WorkspaceAgentsPanel 直调 IPC 双路径（待删代码）；CreateTeamInput 本地重复声明；mock 文案微差；refreshTeams 未载时 no-op

### Task 12: complete (commits 9135c40..424ff25, review clean 一轮过, visual-engineering)
- AgentsView 双 Tab + MembersPanel（行内操作全走 store，⭐标记，blockedTeams alert）+ TeamsPanel（👑leader chip/成员chips/删除接真实）+ 退役组件删除（含计划外 AgentLibrary：AddToWorkspaceDialog 唯一消费方+定义管理归资源库）
- 接线深挖验证：移出语义由后端 stopAgentRuntime 承接无孤儿 runtime；T13 三占位 disabled+注释
- renderer 652/652（−12旧+21新 零新增）；typecheck 双 clean
- Minor（defer）：⭐断言偏弱；移出后 loadMembers 无回归锁；空成员分支无用例；MainLayout 注释漂移

### Task 13: complete (commits 424ff25..6569e42, TDD 红→绿一次转)
- 四弹窗：CreateAgentDialog（source agentView 自动入 ws+设默认勾选/library 仅定义；工具三档 safe/all/custom）、TeamDialog（editing 回填；≥2 校验；leader 已勾选单选禁用+取消自动清空；编辑 diff 序列 改名→adds→setLeader→removes 顺序锁）、CollabSessionDialog（名称可空=undefined 动态命名；agent/团队页签单选；失败读 store error）、DefaultAgentPickerDialog（成员单选→setDefaultAgent→onContinue；无成员引导；接线归 T14）
- 接线：MembersPanel/TeamsPanel 三占位启用 + 资源库创建入口 DefinitionEditor(create)→CreateAgentDialog(library)；DefinitionEditor 编辑能力共存未动
- renderer 691/691（652+39 零新增）；typecheck 双 clean；eslint 零输出
- Review 修复（Important #1 根因）：编辑 diff 基准改提交时 store 现状重读（editing prop 快照过期 → 部分失败重试命中 addTeamMember dup throw 死循环；后端显式 throw 非幂等）；找不到降级 editing+提示刷新；+2 重试用例 693/693
- defer：onContinue 签名 (instanceId) 供 T14；CreateAgentDialog 中文名 slug=中文（与 DefinitionEditor 一致）

### Task 13: complete (commits 424ff25..6569e42 + fix 72db42d, review clean after fix round, visual-engineering)
- 四弹窗（CreateAgentDialog source 语义/TeamDialog 编辑 diff/CooldownSessionDialog CollabTarget 对齐/DefaultAgentPicker）+ T12 占位接线 + 资源库入口切换；DefinitionEditor 编辑路径共存保留
- 修复轮（Important）：TeamDialog diff 基准改提交时 store 现状（三基准统一迁移），部分失败重试不死锁；+2 调用计数实锁用例；报告「幂等兜底」措辞勘误
- renderer 693/693 零新增；typecheck 双 clean
- Minor（defer→终审）：CreateAgentDialog addMember 失败后 def 已建 slug 冲突重试；ResourceLibraryView.test 注释漂移；Picker onContinue 在 try 内（T14 消费方注意）；切档不重置/切页签清目标无断言

### Task 14: complete (commits 72db42d..5b2f86e, review clean 一轮过, visual-engineering)
- 双常驻按钮 ⚡+👥 三分支流程（免弹窗直达+inputFocusTick 聚焦 / Picker 续链 / 无成员引导）；readOnly 三层判定（乐观/权威/校正，selectSession 无条件 loadMembers 保证无死层）；列表图标语义派生（👑前置+溢出+回退）；CreateRoomDialog 删除（工具上限能力由 Badge 保留）
- T13 移交落实：onContinue 消费方自 catch + 专项锁；测试基建修复 3 处
- renderer 719/719（+26 零新增）；typecheck 双 clean
- Minor（defer→终审）：报告用例数笔误（9→7）；乐观只读理论闪烁；text-[10px] 任意值；MentionInput mock undefined

### Task 15: complete (commits bce7c95..文档commit, 收官任务：退役清理+全量回归)
- 概念清零：grep 74→17 处（合法残留=migrations 历史 SQL+类型对齐注释）；AgentAssignment 别名双端删除；AGENT_CONFIG 线协议删 teamSessionId（5 spawn 站点+parseConfig+dispatch-wait 兜底）；workspace:getCoordinator 通道三处删除；dispatcher AgentMemberInfo 更名
- 148 红清账（基线实测 28 文件）：A 夹具修复 16 文件 / B 语义重写 8 文件 / C 退役删除 4 项（remove-cascade+coordinator 整文件、crud-assignment 10 条、ipc-stop-start Task7 describe）+ 保留迁移 7 条有效覆盖 / D 改名涟漪 3 文件即时修复——裁定对照表见 task-15-report.md
- 门禁：typecheck 双 clean；electron 160文件/1306 全绿；renderer 75/719 全绿；build exit 0；e2e 冒烟 smoke.spec 新增 1 passed + 旧 onboarding/e2e-full 标 skip（2.x 重写债在案）
- 文档：README Agent/会话章节 v25 化；AGENTS.md 架构关键点+关键文档；CHANGELOG [未发布] 段
- 遗留：AGENT_CONFIG role 死字段（grep 契约外，独立清理项）；e2e 2.x 重写；better-sqlite3 ABI 换算步骤（e2e↔单测互斥，见 smoke.spec 头注释）

### Task 15: complete (commits 5b2f86e..e7a3518 ×4 + fix e927adf, review clean after fix round)
- 概念清零：grep 终态 21 处全合法（migrations 历史 SQL+对齐注释），AgentAssignment 别名双端删除；148 红清账（A16/B8/C4/D3，净删 21 条退役断言，新覆盖溯源 Task3-10）
- electron 160 文件/1306 全绿 + renderer 719 全绿 + typecheck 双 clean + build exit 0 + e2e 冒烟 1 passed（旧 spec skip 待 2.x 重写）
- 修复轮：router-lazy-init mock 删 teamSessionId 虚构字段 + init-runtime 头注释纠偏
- Minor（defer→终审）：createWorkspace 死位置参数残渣；AGENT_CONFIG role 死字段（37 文件混布，2.x 债）；progress 数字笔误
- **全部 15 Task + 10B 完成，进入终审**

### 终审（whole-branch, ultrabrain）: Yes-with-fixes → 修复后闭账
- 覆盖：spec §3-§8 全落地（§7 八行边界 7/8→修复后 8/8）；跨任务七接缝全闭环实证（v1→v26 迁移链/sender owner/renameSession 竞态/isLeader 全链/NO_DEFAULT_AGENT 全链/readOnly 全链/悬空引用零残留）
- MUST-FIX 已修（1f3e218）：deleteDefinition 置空 default 引用 + leader 团队级联 warn + 回归锁 ×2；crud-assignment 9/9（控制器亲验）
- 门禁（终审实跑）：typecheck 双 clean / electron 1308 + renderer 719 全绿 / grep 21 处全合法
- 2.x 清单归档：e2e 重写（skip 旧 spec）＞ AGENT_CONFIG role 死字段+死位置参数 ＞ 加固包（addMember 原子性/dispatch-wait 空目标/collab 跨 ws 校验/broadcastRuntimeChanged）＞ macOS 主机验收（⚡直达/团队 dispatch/LLM 命名实测）
- 全程：16 任务（15+10B）×实现+审查双循环，Critical×1（T9 bootstrap）+ Important×5 全部修复闭环，Deferred Minor 59 条 triage 完毕（1 MUST-FIX 已修，58 DEFER-OK 归四组）

## v2.1 UI 设计系统 P0 地基期（2026-09-01，计划 docs/plans/2026-09-01-v2.1-ui-refactor-p0-foundation.md，main 分支经用户明示）
Task 1: complete (commits aed93dc plan-fix + 938d99f deps, review clean; Minor deferred: ①探针&&短路 ②task-1-brief陈旧grep行 ③报告头BLOCKED陈旧 ④计划"minified转义"措辞 ⑤README已知限制待Task20勘正)
Task 2: complete (commits 6318b62 plan修正 + 64f8db1 tokens + 2e5ae6c TS7016修复 + f730ab3 计划补遗; review clean after fix round; Minor deferred: ①计数锁不能区分2×:root错位 ②ColorGroup松签名靠运行时锁兜底; 教训=代收尾必须跑typecheck不能只跑vitest)
Task 3: complete (commits 0230a11 store + 3df3118 计划同步; review clean; Minor deferred: ①报告行数元数据 ②mock matches快照不可达缺口 ③mock dispatchEvent弱化不可达)
Task 4: complete (commit 35a4105 boot脚本+接线; review clean——审查者实测 build 验证 ./theme-boot.js 生产路径; Minor deferred: ①报告哈希关切无意义 ②index.html无尾换行预存)
Task 5: complete (commit d6fb85a Segmented; review clean; Minor deferred: ①radio键盘roving-tabindex/方向键缺失——brief层面范围决策,记为后续打磨项 ②两文件无尾换行)
Task 6: complete (commits a9c8ed9 六文件 + f27da1c 计划同步LucideIcon; review clean; Minor deferred: ①SettingsNav头注释残留"全文替换"指令措辞 ②nav侧同步注释单边化 ③svg断言注释措辞)
Task 7: complete (commit 31c214d Button; review clean——type翻转风险消费方普查8处显式submit零隐式依赖; Minor deferred: ①type默认值无回归锁 ②text-[13px]任意值注——Task1探针已证静态可用,README勘正留Task20 ③无尺寸断言)
Task 8: complete (commit 4f45862 Input; review clean; Minor deferred: ①报告行数统计不准 ②测试文件无尾换行 ③测试未断言旧token缺席)
Task 9: complete (commit 1f5a8cc IconButton; review clean; Minor deferred: ①无@ts-expect-error编译级回归锁 ②size/type默认未测 ③报告行数不准)
Task 10: complete (commit f2b7c40 Badge; review clean; Minor deferred: ①报告行数不准——连续多个任务报告元数据失真,终审提醒)
Task 11: complete (commit 3dceca5 Spinner; review clean; Minor deferred: ①EOF换行缺失 ②报告行数对调 ③测试2名与断言错位——brief继承)
Task 12: complete (commit eb1d410 Avatar; review clean; Minor deferred: ①EOF换行 ②报告行数不准 ③测试2标题过度承诺——brief继承 ④白字对亮色调对比度~3:1——设计层备注,终审triage)
Task 13: complete (commit cfb7356 Tooltip; review clean; Minor deferred: ①aria-describedby关联缺——设计迭代项 ②tooltip常驻DOM仅视觉隐藏——brief既定取舍 ③报告行数不准)
Task 14: complete (commits 58561f8 EmptyState + e587ff1 计划同步h3; review clean——preflight证实h3零视觉差; Minor deferred: ①测试文件路径注释重复两行 ②测试2句号断言弱——brief继承)
Task 15: complete (commit 3f49e48 Checkbox; review clean; Minor deferred: ①className死解构吞消费方类——简报既定,后续可改cn合并 ②无label分支未测 ③EOF换行 ④text-[13px]任意值视觉QA关注)
Task 16: complete (commit 5e89794 Select——首派超时零产出后重派成功; review clean; Minor deferred: ①报告行号引用失真 ②测试标题与断言强度不匹配——brief继承)
Task 17: complete (commits c5c6554 Dialog + 2eec171 计划同步; review clean——双fixed层Fragment结构契约成立; Minor deferred: ①不稳定onClose致focus steal——P1消费方stabilize ②监听清理/宽度/焦点/teardown无测试 ③p-0死类 ④EOF换行+报告行数)
Task 18: complete (commit 859c694 task-status; review clean; Minor deferred: ①报告串入无关打包内容需清理 ②EOF换行 ③P2边界status类型收窄提醒)
Task 19: complete (commits 09f3c85 Checkbox className修复[存量lint error暴露] + 82a879b eslint三规则 + c3af7b5 计划同步; review clean——审查者实测descendant Literal捕获; Minor deferred: TemplateLiteral检测缺口——规范既定,P4再议; 附注:Task15的className Minor①就此闭环)
Task 20: complete (commit eb02d0e design-system.md+AGENTS红线; review clean——文档全token/原子/ESLint声明经代码核实; Minor deferred: ①140ms实为150ms措辞 ②现状warn/error分档未写明 ③README勘正承诺需P1兑现[记入P1]; 流程注:实现者误报47预存失败——控制器复现774/774全绿,系其环境伪影)
Task 21: complete (无commit; 五门禁PASS——typecheck双clean/renderer774+electron1308/build exit0/xvfb冒烟Window ready零CSP违规/树净[仅.sdd遗留]; smoke处置:清僵尸进程+electron-rebuild ABI[已rebuild回Node侧]; 人工项:macOS主机三态换肤验收待办)

P0 全 21 任务完成——进入终审（whole-branch review）。Minor 遗留清单见上方各任务行，终审需 triage。
终审: With fixes → 修复 2d8fa8c（emoji字符串属性选择器+文档两处）→ 复核 Clear。P0 完结，31 commits（6a4a3a0..2d8fa8c）。待办移交: P1清单（layout/settings域迁移+Segmented键盘roving+Dialog焦点语义+README勘正+Button type锁+463警告背包+浅色默认走查+macOS三态人工验收）; P2（task-status与TaskStatus联合/类同源+Avatar对比度）; P4（white/black+hsl/TemplateLiteral规则扩展）。

## v2.1 UI P1 骨架+设置域（2026-09-02，计划 docs/plans/2026-09-02-v2.1-ui-refactor-p1-shell-settings.md，main）
P1 Task 1: complete (commits d9fe087 加固 + 218b4fe 计划noUncheckedIndexedAccess收窄; review clean; Minor deferred: ①焦点移动半边无回归锁——后续补toHaveFocus ②报告自审-1回退事实错误 ③单选项边界未测)
P1 Task 2: complete (commits 148365b PromptDialog→Dialog+焦点修正 + 842a906 WorkspaceTabs测试语义适配[预授权第四文件]; review clean——断言强度保持; Minor deferred: ①EOF换行预存 ②报告"第8项"引用失真 ③Dialog重聚焦语义变化记入终审审计——报告已披露)
P1 Task 3: complete (commit 5b3557e ActivityBar/Sidebar/ViewSidebar lucide化+token化[SquareKanban主名] + ViewSidebar.test语义适配; review clean; Minor deferred: ①querySelector断言基数弱化——理论性)
P1 Task 4: complete (commit f60caf2 TitleBar lucide化; review clean 零issue——测试本就语义查询零适配; 备注字形仅存变更注释行=brief原文)
P1 Task 5: complete (commit a3f819f WorkspaceTabs 9项替换+X/Plus lucide化; review clean 零issue——测试20/20零适配,iconEmoji用户数据未动)
P1 Task 6: complete (commit 3669201 MainLayout/MiddlePanel+EmptyState; review clean 零issue; 环境注:实现者47失败伪影再现——控制器778/778复现全绿; 范围外观察:EmptyState max-w-[280px]任意值留阶段末)
P1 Task 7: complete (commit 6e6acf1 SettingsNav/View 外壳; review clean; Minor deferred: ①选中态文本双方案[ActivityBar accent vs SettingsNav primary]——phase-end对照design-system确认 ②报告行号±1)
P1 Task 8: complete (commits 5a0ae7e ProviderDialog→Dialog + 9e3b596 计划??兜底同步; review clean; Minor deferred: ①EOF换行 ②??兜底分支无失败路径断言——后续补)
P1 Task 9: complete (commits 3b311b2 ProviderSettings 17项 + e7c5357 计划??同步; review clean——17/17 verbatim,⭐断言升级为title语义查询; Minor deferred: ①item13 hover无操作——spec层nit ②item7 span基线1-2px)
P1 Task 10: complete (commit e7fcf02 ProviderModelList 12项+Checkbox/Button原子件; review clean——测试零改动Checkbox语义契约保持; Minor deferred: ①头注释↻＋残留 ②拉取中文本无图标关联——观察)
P1 Task 11: complete (commit c3f976d DefaultModelSettings 四卡lucide+Select/Button/EmptyState; review clean——14/14,业务逻辑零改动; Minor deferred: ①EmptyState丢role=status——原子件层 ②Select无disabled变暗——原子件层小任务 ③import形式微偏)
P1 Task 12: complete (commits c905839 Conv/GitPolicy + 0ba41c8 计划测试命令修正 + 17ffae4 Select可见label修复[Important闭环]; review clean after fix; Minor deferred: ①Checkbox label 13px/primary与面板不一致——原子件层 ②Button md尺寸备忘; 教训:计划aria-label snippet误导)
P1 Task 13: complete (commit 670c64f AuditLog/About 配额条class化+双分支阈值锁新测试[779]; review clean——19/19 verbatim; Minor deferred: ①新测试mock隔离diff不可见——无害 ②arbitrary-value类残留——预存范围外)
P1 Task 14: complete (commit 7aa716f UpgradeNotice; review clean 7/7; Minor: EOF预存+Button md密度微变——brief既定)
P1 Task 15: complete (commit 5e56926 README勘正+Dialog指引——writing会话中断,控制器代执行计划逐字内容; 控制器直验:锚点/内容/其余行未动)
P1 Task 16: complete (无commit; 六门禁PASS——四域lint零/routes零/typecheck双clean/779+1308全绿/build0/冒烟Window ready[ABI往返处置]; P2预算:321警告=im125/agent88/res48/task22/files19/p2p14/editor3/ws2)

P1 全 16 任务完成——进入终审。Minor 遗留见各任务行。
P1 终审: Yes-with-fixes → 修复 d991ee5（Dialog Esc capture阻断+选中态统一accent+Checkbox/Select对齐+清扫15文件）→ 复核 Clear（审查者独立复跑781/781+tsc0+lint0/0）。P1 完结，24 commits（2d8fa8c..d991ee5）。移交P2: ①原子件加固任务吸收EmptyState role/Segmented toHaveFocus+单选项锁/??失败路径断言/Loader2 Spinner采用/Dialog onClose韧性 ②321警告预算=im125/agent88/res48/task22/files19/p2p14/editor3/ws2 ③机械完成证明=逐文件零警告+census复点 ④杂项: transition-width死类/Checkbox EOF/PML.test↻＋标题

## v2.1 UI P2 会话域（2026-09-02，计划 docs/plans/2026-09-02-v2.1-ui-refactor-p2-im-domain.md，main）
P2 Task 1: complete (commits 491926f 原子件吸收7文件 + df9595e 计划注记; review clean——三setTestResult路径全收口; 偏差:ProviderDialog状态色= P1内在分歧由实现者RED证据修正; Minor: 成功路径class未对称锁定)
P2 Task 2: complete (commit 53ee3bb task-status派生+dispatch五态; review clean verbatim; Minor: ①_typeLock弱于名义——真强制在Record完整性 ②无尾换行预存; 备忘:DispatchChip旧4态union是DispatchStatus子集,Task5接线无摩擦)
P2 Task 3: complete (commit e1bed9e TaskChip重写; review clean verbatim; 发现:TaskChip是孤儿组件零消费者; Minor: ①双重截断belt-suspenders ②padding/radius委派status.className——接线任务视觉确认)
P2 Task 4: complete (commit 093ee86 ToolCallChip三态tint+测试增强; review clean; 备忘: Loader2=lucide-loader-circle别名——查询点注释+tsc双保险; Minor: ①summarizeArgs三连调——brief原文如此 ②cursor-pointer缺失——brief继承)
P2 Task 5: complete (commit 25d10d5 DispatchChip重写3文件; review clean verbatim——三Chip家族收官; 偏差已裁定: 第4文件ASB.test重指向=必要适配, EMOJI_AVATAR提升=意图保持; Minor: ①not.toBeNull风格 ②(完成)分支无直接断言——预存平价)
P2 Task 6: complete (commit 12f3427 Thinking/Todo重写2文件; review clean verbatim——零测试适配需求实为预存断言未涉字形; 观察: completed项secondary化=设计三分法)
P2 Task 7: complete (commit 02213ea SubAgentSection/SegmentStack; review clean; Minor: ①父子markdown瞬态不一致——T8闭合 ②[&_pre]:max-w-full弃——md-body无对应,祖先链兜底 ③#60a5fa→accent-500有意色变)
P2 Task 8: complete (commit c6fb63e AgentStreamBubble 10项; review clean verbatim——judgment calls均正确[ml-auto恢复右对齐/纯布局inline保留]; Minor: 报告inline计数2实为3——账面瑕疵)
P2 Task 9: complete (commits cc1ee7a 消息四件5文件 + 490817c md-body强调底可读性修复[Important闭环: code/pre显式text-primary + accent底链接inherit下划线] + tokens回归锁; 复核Clear——审查者独立验证bg-accent-500作用域仅isSelf; 教训:处方引用不存在CSS变量——inherit偏差正确; 基线787)
P2 Task 10: complete (commit 573d01d Monaco双主题; review clean——8色值逐字/回退状态机/P3范围零触碰; Minor: ①hex与globals双源——Monaco结构性限制 ②themeFallback永久化——合理)
P2 Task 11: complete (commits 21a332b RoomList/SSH 3文件 + eed3477 计划三处校正; review clean; 偏差: ①选中态按design-system accent形态——brief笔误 ②hover:opacity-90——surface-active/70违反形式二禁令[计划bug] ③5处额外emoji随lint门禁lucide化; Minor: ①SSH头注释⚡👥陈旧 ②role=status未传 ③空态顶对齐 ④死transition-colors ⑤12/14px视觉QA)
P2 Task 12: complete (commit 7a74dd5 输入区三件; review clean——23替换点全逐字; 偏差: 4额外emoji[Pin/Users/Wrench/Bot]随门禁lucide化已披露; Minor: ①||→??空串边界 ②Lock align-[-1px]在flex内惰性——brief原文)
P2 Task 13: complete (commits 036f99e 成员/导出/列表 + 6754039 🤖→Bot兜底修复[Important闭环——lint规避helper删除,对齐T12先例]; 复核Clear; phase末批量项: RoomList 🤖/👑前缀同类+ExportChat/MessageList EOF; Minor: report自审失实)
P2 Task 14: complete (commit 81ef840 任务弹窗收敛4文件+2测试; review clean——payload逐字由diff语义证明; 47失败申报第三次伪影——控制器787/787复现; Minor: ①4文件EOF ②硬编码open ③footer位置=submit功能必然 ④previousElementSibling结构耦合——既有惯例)
P2 Task 15: complete (commit 2440233 会话弹窗收敛3文件; review clean——handlers逐字/Crown断言增强; Minor: ①Avatar兜底分支无测试——先例承袭 ②Crown外层dark类死代码——brief原文)
P2 Task 16: complete (无commit; 五门禁PASS——im lint 125→0精确/typecheck双clean/2095全绿/build0/冒烟Window ready零CSP; census 321-125=196精确命中P3预算; ABI陷阱按表处置并回退实测验证)

P2 全 16 任务完成——进入终审。Minor 遗留见各任务行。
P2 终审: Yes-with-fixes → sweep f6c4848（cursor×4+RoomList Bot/Crown化+空态居中×4+blockquote accent覆写+锁×2+§6修正,10文件——修复者中断由控制器完成测试适配与验证链788/788）→ 复核会话超时,控制器对五项逐一落盘验证通过。P2 完结,45 commits（2d8fa8c..f6c4848）。移交P3: ①196警告=agent88/res48/task22/files19/p2p14/editor3/ws2 ②TaskSidebarPanel.tsx:77也消费STATUS_COLOR——P3接线时连同TaskCard一起 ③EOF×7+杂项cosmetic批量清扫 ④macOS人工验收（浅色默认+三态换肤+图标尺寸走查）

## v2.1 UI P3 其余域（2026-09-02，计划 docs/plans/2026-09-02-v2.1-ui-refactor-p3-remaining-domains.md，main）
状态: 计划已提交, 执行待 MiniMax 配额重置（~2.5h）
P3 Task 1: complete (commit cb00da2 TaskCard/SidebarPanel接线+remoteStatusStyle+SidebarPanel 7处sweep顺带——触碰文件0/0纪律; 控制器内联执行[MiniMax限流], 全量788绿+tsc0; 状态文案统一task-status版[待启动→待分配等])
P3 Task 2: complete (commit 7a34f01 看板四件sweep 5文件; 控制器直审——diff新增行零旧token/零渲染emoji/lucide参数同TaskCard; task-board全域0/0; 788绿; 待办: TaskSidebarPanel L154全角＋归T13)
P3 Task 3: complete (commit c7b86c6 agent视图四件sweep+emoji[Bot/Users/Crown/Star/Play/Pause]+EmptyState×2; 控制器抽验——四文件0/0/全量788/新增行零旧token; cat.emoji=tool-catalog目录数据豁免)
P3 Task 4: complete (commit 25a8604 TeamDialog收敛+3新语义锁; 基线791; 控制器抽验零旧token)
P3 Task 5: complete (commit 512e9ac CreateAgentDialog收敛; 791绿; 控制器抽验)
P3 Task 6: complete (commit f7aad2d MemberEditDialog/DefinitionEditor收敛[裁定:居中表单弹窗→Dialog]; pendingRestart吞Esc语义保留; 791绿)
P3 Task 7: complete (commit e138af6 RegisterMcp/UploadSkill收敛——agent域弹窗四连收官[T4-7]; 上传锁Esc守卫保留; 791绿; 注: lsp-tools并行过载假失败已排除)
P3 Task 8: complete (commit 5c3a544 resource-library五件10文件sweep+emoji+SourceBadge tone; 48警告清零; 791绿)
P3 Task 9: complete (commit a9883ba files三件sweep+emoji[Folder/File/Chevron/RefreshCw等]; FileContextMenu按弹出层裁定不收敛; 19警告→0; 791绿)
P3 Task 10: complete (commit 782cefe CodeEditor tab栏/空态sweep; Monaco接线零改动; 791绿)
P3 Task 11: complete (commit 7d6c643 NodeDiscoveryPanel sweep+emoji[CircleAlert/Wifi/Globe]; 14警告→0; 791绿)
P3 Task 12: complete (commit 8edeb35 CreateWorkspaceDialog收敛; 计划iconEmoji豁免条件不成立——实际无emoji grid,已记录; 791绿)
P3 Task 13: complete (commit 9c4887f 清扫37文件——EOF×32批量+SSH注释+Crown死类+TaskChip双重截断+SidebarPanel全角＋; 791绿; 留档: MentionInput:244×/settings两处＋为域外文本字形——P4处置)
P3 Task 14: complete (无commit; 七门禁PASS——七域0/0/全域census 0[196→0双确认]/typecheck双clean/1308+791全绿/build0/冒烟Window ready零CSP; ABI按表处置还原复验)

P3 全 14 任务完成——进入终审。
P3 终审: With-fixes → 修复 e71b120（remoteStatusStyle回归锁+TaskFilters词表统一+死hover,792=791+1）→ 复核Clear。P3 完结,15 commits（f6c4848..e71b120）,renderer全域eslint 0/0。P4输入: ①App.tsx:68/MainShell.tsx:12 bg-bg-primary→bg-canvas必须在删token块之前 ②FileTreeView内联重命名modal收敛或豁免 ③ProviderSettings文案「＋」与实际Plus图标对齐 ④MentionInput:244×/ResourceLibraryView:173✓/CodeEditor tab-close span a11y ⑤P4主体: Tailwind theme.colors独占+ESLint全局error+e2e双主题基线+design-system终稿

## v2.1 UI P4 收官期（2026-09-03，计划 docs/plans/2026-09-03-v2.1-ui-refactor-p4-final.md，main）
P4 Task 1: complete (commit f3207ae 前置迁移9文件——token末两处+字形杂项+FileTreeView双PromptDialog+CodeEditor div[role=tab]结构化; 792绿/全域0/0; 顺序红线达成: bg-bg-primary src零命中)
P4 Task 2: complete (commit 1d1f065 token灭绝3文件——deprecated三块删/colors独占/独占锁; 陷阱发现: transparent/current是默认色阶成员已显式保留+存活锁; 产物CSS验证token在/默认色阶全谱零命中; globals theme()引用为过期信息无需迁移)
P4 Task 3: complete (commit b2ee41f lint全局error化——ui/冗余块删+stdin探针exit1验证)
P4 Task 4: complete (commits d55b32d e2e双主题基线[3passed:浅色765ms+深色2.0s] + c2ffb74 design-system终稿§7; 陷阱根治: --user-data-dir隔离localStorage泄漏; ABI往返×2确认; (c)运行时切换裁定单测锁)
P4 Task 5: complete (无commit; 五门禁PASS——①灭绝证明: eslint 210文件0/0[error级,L67确认]+grep代码零命中[仅2注释型备注] ②typecheck双clean+electron 1308/160files+renderer 792/90files ③build 0+e2e 3passed/2skipped[theme-a 824ms+theme-b 1.9s]+prebuild恢复+storage 96/96 ④dev冒烟Window ready零CSP[boot链完整,ABI二次往返复验] ⑤树净[仅.superpowers/]; P2 ledger计数笔误勘正: 实为21非45[区间起点复用P1]; 报告=.superpowers/sdd/p4-task-5-report.md[覆盖v2.0.0同名旧报告,原文在git历史])。**v2.1 UI 重构全链路交付完成——P0-P4共97 commits/56+任务,终态: token物理灭绝+lint全局error+210文件0/0+2100测试全绿+e2e双主题锁定**
P4 Task 5: complete (无commit; 五门禁PASS——灭绝证明[eslint 0/0 error级+grep零命中]/typecheck双clean/1308+792逐位一致/build0/e2e 3passed含双主题/smoke零CSP/树净; P2 ledger计数笔误勘正: 实为21 commits非45)

P4 全 5 任务完成——进入终审。
P4 终审: Yes——v2.1全链路完成。收尾 commit（tablist+注释清扫,灭绝grep严格零命中/全域0/0/tsc0/24测试绿）。v2.1 总计: P0 31+P1 24+P2 21+P3 15+P4 7=98 commits, 61任务。
遗留(显式记录): macOS人工验收/CodeEditor方向键roving/smoke.spec隔离对齐/P0移交的ESLint规则扩展(white/black+hsl+TemplateLiteral)无排期——建议accept为P2.1或waive

## v2.2 记忆 P1（2026-09-03，计划 docs/plans/2026-09-03-v2.2-agent-memory-p1-data-manual.md，main，BASE=99fa7ee）
P1 Task 1: complete (commit 150a6f1 jieba tokenize 模块; review Approved; Minors 待处置: ①merge分支测试不足→Task3 搜救补「用户，偏好」/「"quoted"」/「quoted"」三形态 ②tokenize.ts+测试EOF换行×2→终审triage ③emoji并入邻token信息性无需行动)
P1 Task 2: complete (commit eed568a migration 027; review Approved——SQL与测试零漂移; Minors均为plan-mandated中性: kind/source CHECK无负路径测试/repo层可补、用例间共享状态耦合024模式、.trim()文件约定)
P1 Task 3: complete (commits 67a599d+34e75b5+2e839c9 repo CRUD/FTS同事务双写; 评审实证: brief原UPDATE→DELETE顺序有tags路径CORRUPT_VTAB+content路径静默索引漂移双失败形态,实现者的DELETE→UPDATE→INSERT修复正确必要; 首轮Needs fixes→补missing-id错误路径+touchMemoryUsed用例→复核Approved; 22/22绿; 残留Minor: §5.3/§6.1 spec引用不一致plan-inherited[终审triage])
P1 Task 4: complete (commit 36c9b5a BM25检索+中文专项7用例; review Approved; Minors: limit测试无法证明截断[plan-mandated,后续多候选fixture可补强]/报告「CHECK禁空串」措辞过强[实际依赖FK+app生成ID]/默认limit=10无专项——均终审triage)
P1 Task 5: complete (commit 7779e9d provider扩展+injection+memoryEnabled; review Approved; Important(plan-mandated): 6个stub-provider测试文件缺新4方法→Task6必须补stub否则runChatLoop接线后TypeError[typecheck盲区]; Minors: slice(0,30)溢出不计入truncatedCount[Task8核对]/截断路径无专项测试/budget策略continue-vs-break不一致+近似[均plan-mandated])
P1 Task 6: complete (commits 97db659+0c9954a runChatLoop接线+6文件9处stub清偿; review Approved——接线逐字唯一插入点/真实messages流断言强于原稿/1341全绿; Minors: 报告行数笔误/stub search返回[]不对称[终审triage]; 遗留观察: provider抛错中断消息处理与getTaskContext语义一致,P2提取管线兜底)
P1 Task 7: complete (commit b144916 memory:* IPC+preload+双端类型; review Approved——5通道三方逐字对齐/4处窄化均安全向; Minor: list.filter缺source未在代码内声明[1行JSDoc,Task8或终审顺手补])
P1 Task 8: complete (commit 5d5d8ac MemorySettings+三接线+JSDoc polish+GlobalSettings镜像补齐[计划盲点,实现者发现]; review Approved——token/icon/原子组件全合规,测试强于brief; Minors均plan-mandated: IPC promise无catch×6/saveEdit空文本静默/tab切换竞态/toggleEnabled无回滚/a11y缺aria-pressed与tablist——P2或终审triage)
P1 Task 9: complete (无代码commit; controller 亲验: typecheck 双 clean / electron 166文件1341用例 + renderer 91文件799用例全绿 / lint 0 error; 冒烟四项留 macOS 主机; README 状态区 3709415)
P1 全 9 任务完成——进入终审（范围 150a6f1..3709415，含修复 12 commits）。
Minor 池（终审 triage）: T1 EOF换行2文件+emoji并入token信息性 / T3 §5.3/§6.1引用不一致 / T4 limit测试弱+报告措辞 / T5 slice(0,30)溢出不计truncatedCount[Task8 UI不受影响] / T6 报告行数笔误+stub search返回[] / T7 已由T8补JSDoc[已闭环] / T8 IPC promise无catch×6+saveEdit静默+tab竞态+toggle无回滚+a11y缺状态属性[均plan-mandated]
P1 终审: NEEDS FIXES(F1-F5)→单fixer三commits(08dc3d9+2f09ef7+f07afcd)→复核 P1 DONE WITH BACKLOG。全链 99fa7ee..f07afcd = 15 commits。验收态: typecheck双clean / electron 1341+5=1346 / renderer 799+2=801(focused亲验41/41+70/70) / lint 0。
P1 backlog(随P2计划继承,优先级序): ①session层pinned条目注入无归宿[P2会话层落地前必须先解决spec级缝隙] ②provider注入兜底try/catch[CORRUPT_VTAB事故证明FTS错误形态真实] ③content长度上限enforcement ④catalog SQL LIMIT+串行await优化 ⑤boot jieba冒烟fail-fast ⑥UI打磨四件(错误呈现/tab竞态守卫/toggle回滚/a11y状态属性) ⑦stub search统一抛错 ⑧测试补强(limit多候选/默认limit/kind与source CHECK负路径) ⑨kind标签规范/规则统一[WAIVE级]
未决待办: macOS主机四项冒烟(注入生效/即时生效/总开关/中文检索)——不阻塞P1闭账。

## v2.2 记忆 P2（2026-09-03，计划 docs/plans/2026-09-03-v2.2-agent-memory-p2-extraction.md，main，BASE=f07afcd）
P2 Task 1: complete (commit 29e059a 注入补强; review Approved 6/6; Minor×3 待终审triage[含实现者取舍:单路>30不计truncatedCount]; 47/47绿+typecheck双clean)
P2 Task 2: complete (commit 2f8291e MemoryTools三工具; review Approved; Minor×4: 已实现校验无测试锁[tags/limit/未知工具]/search先limit后scope过滤/子agent写session读不到/审计双记录无层级标识——P3收敛)
P2 Task 3: complete (commits 6b641fa+33235b7 提取管线+会话压缩; 首轮Needs fixes: 窗口ASC冻结→修复者实证评审方案B数学不可达改DESC+反转+冻结区回归锁→复核Approved; 57/57绿; Minor残留: commit措辞陈旧beforeTs/test缩进/messageToContext复刻措辞)
P2 Task 4+5: complete (commits 1eeb341+b026c15 合并派发一次评审; review Approved 8契约全过/聚焦检查证实destroy与crash路径不经gate; Minor×3: boot冒烟error非fatal措辞/test as never/乐观无回滚沿袭)
P2 T6: complete (controller亲验 typecheck双clean / electron 170文件1402 + renderer 91文件804=2206全绿; README 4d91564)
P2 终审: DONE WITH BACKLOG——四契约链零断点/spec§6.4逐条兑现/无Critical-Important阻塞。全链 6d04986..4d91564=8 commits。
P3 backlog(优先级序): ①I-1 提取去重污染use_count[P3开工首任务MUST-FIX:改repo直调无touch] ②M-1 首块空记录吞载荷 ③M-2 审计双记录收敛+层级标识 ④M-3 search先limit后scope+误touch ⑤M-5 去重top1→top3 ⑥M-7 messageToContext双实现抽shared ⑦P1遗留: UI打磨四件/测试补强三件/content长度enforcement/stub统一; WAIVE: M-4去抖Map/M-6/M-8杂件/M-9并发。
未决: macOS主机冒烟六项(P1四+P2两:20轮auto条目/长会话摘要接续)。

## v2.2 记忆 P3（2026-09-03，计划 docs/plans/2026-09-03-v2.2-agent-memory-p3-polish.md，main，BASE=4d91564）
P3 Task 1: complete (commit dbd9032 数据信号净化I-1/M-1/M-3/M-5; review Approved 6/6; Minor→T4: MemorySearchOpts近义命名/M-5窗口top3备注)
P3 Task 2: complete (commit 3f4ecee 导出/导入Markdown; review Approved 7/7; Important rider→T3: global层导入去重补1用例[行为已源码验证]; Minor: 报告用例数12实为10/##续行损失未注释/常量双持有已声明/doExport无catch属T4)
P3 Task 3: complete (commit f50073d 统计+黄标+长度上限+rider; review Approved 7/7; Minor×4: rider新段对照组/存量超限update边界/ui-Textarea上提/90天恰界——均加固级)
P3 Task 4: complete (commit 889d982 打磨批五子项; review Approved 7/7; Minor×4: a11y部分模式/catch覆盖不对称/extraction EOF/双审计保留——均增量级)
P3 T5: complete (controller亲验 typecheck双clean/electron 172文件1438+renderer 91文件822=2260全绿/lint 0; README 8e5de57)
P3 终审: v2.2 P3 DONE 可关账——P3 五commit销账全部backlog(I-1/M-1/M-2/M-3/M-5/M-7/UI四件/测试补强/长度enforcement/stub统一),无Critical-Important。v2.2全三期28 commits(99fa7ee计划后..8e5de57)。
v2.2 发布前 gate: macOS主机冒烟八项(P1四+P2两+P3两:导出清库导入复原/90天黄标)。v2.3遗留: 终审Minor1-5(<10行)/a11y roving/spec引用清整/Markdown段界转义。WAIVE池见终审记录。

## 会话消息渲染优化（2026-09-06，计划 docs/plans/2026-09-06-session-ui-message-rendering.md，spec docs/specs/2026-09-06-session-ui-message-rendering-design.md，main，BASE=497dfa8）
Task 1: complete (commit 417fbd1, review clean——Approved; 偏差裁定: shiki 4.4.3 替代 brief 3.x, langImports 适配 LanguageRegistration[] 经审查者三轴验证[运行时探针/官方 d.mts/MaybeModule 链]; Minor deferred ×3: ①单例 rejection 永久缓存,一行 catch 重置加固[Task2/3 顺手] ②报告空 fence 覆盖措辞过强 ③冒烟仅 typescript 单语言,yml 别名路径未跑)
Task 2: complete (commit 03a3844, review clean——Approved; Minor deferred ×3[均plan-mandated]: ①shell 列表与 SHELL_LANGS 重复维护 ②deferHighlight true→false 恢复高亮路径无测试 ③test2 断言略弱)
Task 3: complete (commit 3d082d3, review clean——Approved; Minor deferred ×3: ①hast 类型依赖声明待核[与T1安装声明矛盾,控制器复核中] ②pre 兜底死分支渲染外层 children ③md-table-wrap 中部放置偏离字面追加) 
  [控制器复核: @types/hast ^3.0.5 实际在 renderer/package.json:31 devDependencies——审查员 Minor① 事实错误作废; 有效 Minor 余 ②③]
Task 4: complete (commits cc3fee9 + fix b746430 + plan-sync da03c0a, review clean after fix round; Important×2[plan缺陷]: list_files 漏入 FILE_TOOLS + basename 尾分隔符全路径——已修复并加 3 判别性回归锁 13/13; Minor deferred: grep 仅 path 前导空格/bash CRLF 残留/usedKey 值相等重复/UTF-16 截断代理对/报告行数笔误)
Task 5: complete (commits 67c50e9 + lock 57493fa, review clean——Approved; 8/8; Minor deferred: dispatch 段透传无用例/报告行数互换; 评审点名语义锁已当场补齐: todowrite 透明不打断 + 全过滤空数组)
Task 6: complete (commits a3095ba + lock/计划同步 57fe897, review clean——Approved; 33/33 含消费方; brief 自相矛盾断言[bash 摘要=命令 与 参数不渲染互斥]实现者正确诊断并保意图适配 /"command"/; Minor deferred: 次级开关无 aria-expanded / result undefined 且非执行中显示等待文案措辞 / denied 双色调) 
Task 7: complete (commit 5676e5f, review clean——Approved 逐字保真; Minor deferred ×4: tone 矩阵负向分支无测试/countLabel 零省略未测/展开行 11px vs 全局 12px 计划内部不一致[记录]/报告行数口径) 
Task 8: complete (commits 0436ffa + fix da28148, review clean after fix round; 12/12; 3 处 brief 测试代码缺陷偏差均裁定正当[setCopied 时序/act 包裹/toBe(false)]; 修复轮: 回退路径 focus/select+try/finally+离屏; Minor deferred ×3: 计划文档残留 toBe(true)+act 未同步[Task 9 顺带]/回退用例未锁 select 可 spy 补/回退不恢复焦点)
Task 9: complete (commit 0e844eb, review clean——Approved; 集成 7+ 文件 + 4 新用例 + 3 行为适配[思考中标签/testid 元素断言更精准/双态断言] + 计划 Task8 勘误授权项; named risk dispatch-activity testid 判定属生产代码非后门; 880/880 全绿; Minor deferred ×3: SubAgentSection 分组无 memo/MessageBubble v2.0 头注释过时/复制用例 async 无 await) 
Task 10: complete (无 commit; 控制器亲验五门禁 PASS——typecheck 双 clean / electron 173文件1448 + renderer 99文件880 全绿 / 回归锁六文件 diff 空 / renderer+electron build exit 0 + shiki typescript 语言块 181kB 独立分包旁证; 手动 DoD 八项留 macOS 主机)

全部 10 Task 完成——进入终审（whole-branch, 497dfa8..HEAD, 12 commits）

终审: APPROVED-WITH-FIXES → 修复 b8e0c58（DispatchCard/TaskReplyCard 收敛 MarkdownBody 补齐 SafeAnchor[终审 Important I-1] + 计划 Task1/5 同步 + MessageBubble 注释）→ 复核 APPROVED（全 renderer 生产代码 react-markdown 仅剩 MarkdownBody 一处；N-1 多余 }); 控制器内联勘正）。终态 497dfa8..HEAD 16 commits 可合并。7 项 DEFER-OK 维持触发式归属（单例 rejection 加固/SHELL_LANGS 重复/describeToolCall 四边角/ToolCallChip aria/ContextGroupChip tone 测试/CopyButton select spy/SubAgentSection memo）。
SDD 执行完毕：10 任务 ×（实现+审查）双循环 + 终审双轮；Critical 0 / Important 4（全部修复闭环）/ Minor 延期 7 组归档。测试终态：electron 1448 + renderer 880 全绿、typecheck 双 clean、build exit 0 + shiki 分包旁证。手动 DoD 八项留 macOS 主机验收。

## Agent 模型选择与成员管理修复（2026-09-06，计划 docs/superpowers/plans/2026-09-06-agent-model-selection-fixes.md，spec docs/superpowers/specs/2026-09-06-agent-model-selection-fixes-design.md，main，BASE=23684fc，run-dir=.superpowers/sdd/agent-fixes/）
Task 1: complete (commits 269c882+1877b50, review clean after fix round——Important[plan-mandated 残留error不清除]已修+回归锁10/10; Minor deferred ×5: disabled未gated拉取按钮+无disabled用例/RefreshCw 12px vs 16px/handleFetch跨provider竞态/未匹配modelId占位显示/暂无模型+error文案并存)
Task 2: complete (commit 22fd874, review clean——Approved; Minor deferred ×3: 报告统计口径笔误/校验分支仅测provider空侧未测model清空侧/测试头注释重写超brief字面[良性])
Task 3: complete (commit 2952354, review clean——Approved; Minor deferred ×2: 新用例async无await[plan-mandated形态]/configure模式disabled下仍发listModels IPC[picker内部,Task1域]; 附: configure供应商下拉旧本可交互新统一上锁=收紧非放松)
Task 4: complete (commits 557175b+fix bd34782, review clean after fix round——Important[plan-mandated 空输入拦截零用例]已修+三重失败信号行为锁18/18; Minor deferred ×4: 误导注释[已顺手修]/非运行成员直接关窗无测试/[def]身份变化静默重置未保存编辑[plan-mandated模式]/agent.store字段名updateMemberApiKey遗留[后端域])
Task 5: complete (commits 9a747c3+fix a403316, review clean after fix round——Important[plan-mandated agent.list未处理rejection]已修+运行级回归锁25/25; Minor deferred ×4: def-not-found warn分支无测试/console.error无UI反馈[同warn模式]/waitFor负断言弱锁定[真锁=vitest运行级检测]/报告统计笔误)
Task 6: complete (commit e71fd92, review clean——Approved; Minor deferred ×2: window.api死桩[plan-mandated模板]/入口按钮接线无用例[3文件边界裁定])
Task 7: complete (无 commit; 控制器亲验三门禁 PASS——typecheck 双 clean / renderer 101文件909测试全绿 / electron 174文件1464测试全绿)
全部 7 Task 完成——进入终审（whole-branch, 23684fc..HEAD, 12 commits）
终审: APPROVED-WITH-FIXES → 修复 9542306（definitions 刷新，终审 Critical）+ 29a9795（拉取竞态守卫，终审 Important）+ plan-sync 4b8fb3a → 复核 APPROVED（Ready to merge: Yes）。终态 23684fc..HEAD 15 commits。SDD 执行完毕：7 任务×（实现+审查）双循环 + 3 轮任务内修复 + 终审双轮；Critical 1 / Important 5 全部修复闭环；Minor 延期 16 组归档（终审裁定全部 ship-as-is，next-touch 清单见终审记录）。测试终态：renderer 912 + electron 1464 全绿、typecheck 双 clean。
主机验收修复: 资源库 agent 编辑无反应——custom agent ResourceItem.slug=def.id（custom.ts:86 口径）而 handleEditAgent 按 def.slug 匹配（Task5 fixture 未仿真真实契约,测试全绿生产 miss）。修复 commit 见 git log（d.id 匹配+fixture UUID 口径对齐+红绿回归锁 912/912）。

## 2026-09-06 侧边栏宽度调整与完全收起（docs/plans/2026-09-06-sidebar-resize-collapse.md，BASE c22e162）
Task 1: complete (c22e162..df6bcb3, review clean——Approved; Minor ×5 归档: 报告行数95vs102 / GREEN输出疑似截断Node警告 / clampWidth NaN透传[brief原文,拖拽调用方有限值,NaN经JSON变null重启自愈] / 测试3命名「合法项保留」无合法seed / 加载时小数取整无直测)
Task 2: complete (df6bcb3..f693d28 含 7e67c93 PointerEvent polyfill 前置 commit, review clean——Approved; Minor ×6 归档: 拖拽中卸载 window 监听保留[brief原文,手势有界+React18 noop]/二次pointerdown覆盖手势未测/测试标题350vs310[brief笔误,verbatim保留]/polyfill as unknown as 双窄化[测试基建]/报告jsdom≥22移除条件笔误/全套件运行留Task 6终验[全局setup变更])
Task 3: complete (f693d28..cb3857b, review clean——Approved; 偏差批准: RTL15 双render需显式cleanup[brief笔误,断言原样]; Minor ×3 归档: ViewSidebar.tsx:19 注释引用已删 VIEW_META[plan原文]/写路径接线(onCollapse+viewKey commit)无 ViewSidebar 级测试[plan遗漏,补两用例成本极低]/Partial<Record<string,string>> key 放宽[plan原文])
Task 4: complete (cb3857b..fa1607b, review clean——Approved; Minor ×3 归档: 两新文件缺 EOF 换行[无 eol lint 规则,纯格式]/空态顶行 h-[30px] vs 实际 tab 行 ~32px[plan-mandated 值]/tablist overflow-x-auto 下按钮可被横向滚走[brief 指定插入位,设计固有])
Task 5: complete (fa1607b..da5238f, review clean——Approved; Minor ×1 归档: ActivityBar guard 负分支[当前视图∉SIDEBAR_VIEWS+收起]无直测[plan覆盖缺口])
Task 6: complete (无 commit; 控制器亲验三门禁 PASS——renderer 104文件937测试全绿 / electron+renderer typecheck 双 clean / 无遗留未提交文件; spec §8 七条: 1-5由Task1-5测试锁定, 6-7由门禁证实)
全部 6 Task 完成——进入终审（whole-branch, c22e162..da5238f, 7 commits）
终审: APPROVED（Ready to merge: Yes; 0 Critical / 0 Important / 新增 Minor ×7 + 遗留 ×14 全部 ship-as-is 裁定归档）。spec §6 第 3 行已按裁定同步（拖拽中收起→释放仍提交，commit 见 git log）。SDD 执行完毕：5 任务×（实现+审查）双循环 + Task 6 控制器三门禁 + 终审单轮；测试终态 renderer 937 全绿、typecheck 双 clean。后续可选 chore 清单（终审建议 #2）: clampWidth 单点导出 / VIEW_LABELS 收窄移居 ui.store / ViewSidebar.tsx:19 注释 VIEW_META→VIEW_LABELS / 两新文件 EOF 换行 / Sidebar 测试标题 350→310。

反馈修订（2026-09-07）: 收起状态按视图独立（toggleSidebar(view) 签名 + 旧 boolean 同值迁移 + MainLayout Ctrl+B guard）+ 移除拖拽角标。TDD：RED 7 fail → GREEN 6文件59用例 → 全套 104文件942全绿 + typecheck clean。3 commits（feat/refactor/docs）。顺手闭环两项终审遗留：测试标题 350→310 笔误、ActivityBar guard 负分支直测。
=== 新计划启动: docs/plans/2026-09-07-task-execution-runtime.md（分支 feat/task-execution-runtime, base 2a8fd62）===
Task 1: complete (commits 2a8fd62..e15032e, review clean; Minor×4 归档: 报告SET计数笔误/insertTask hunk截断/swap-clear路径未测/admission索引未行使[后续任务消费])
Task 2: complete (commits e15032e..41ceece, review clean; Minor×4 归档: weekly分支DST毫秒运算[brief继承]/every:N无上界/cancelled与spawn级非法规则未直测/测试未用import)
Task 3: complete (commits 41ceece..883562b 含审查修复, review clean after re-review; brief seed 按DDL修正[def1+def2 拆分为 v25 唯一索引强制]/listSessionMembers 替换已验证; Minor×3 归档: 报告断言强于实况/EOF换行/targetTeamId! 断言)
Task 4: complete (commits 883562b..9b3b9fa 含审查修复, review clean after re-review; 裁定记录: spec §4.4「状态机零改动」与 §5.1/§9「转 failed」内部冲突——按算法节裁定新增 assigned→failed 边[f1405a2 独立提交+RED→GREEN 锁], T11 需同步 spec §4.4 措辞; Minor×3 归档: kickoff失败留孤儿会话[brief继承]/notify合并窗口/兜底timer未unref)
Task 5: complete (commits 9b3b9fa..e7a33a6, review clean; require 环逐跳验证 call-time 安全; brief 方法名漂移 finalizeActiveTask→transitionTaskTerminal 已按结构描述落位; Minor×4 归档: spawn/notify 共 try 块/生产 kickoff wrapper 未被测试调[留主机冒烟]/scanPickup 恒 true/notify 吸收窗口)
Task 6: complete (commits e7a33a6..8415328, review clean; kickoff 自引用回路验证 inert; Minor×4 归档: session-service.test:392 fixture 突变[建议加注释或双锁]/冲突弹窗vs放行竞态[spec 属地,建议 conflict-resolver 容忍度测试]/activation 绕过即时 p2p 广播[45s 兜底有界]/无 workspace 域校验[spec owner 裁定])
Task 7: complete (commits 8415328..1f6d93f, review clean; 超范围两处均正当[execute()解析第四触点+3 fixture 纯 null 补齐]; Minor×3 归档: CreateTaskInput 风格不一[|null]/互斥 trigger 未被 IPC 测试锁[T1 已锁]/测试传 creatorUserId 冗余)
Task 8: complete (commits 1f6d93f..835be2c 含审查修复, review clean after re-review; 裁定: 计划 verbatim 的 ASC+LIMIT 截断方向缺陷按意图修复[新增 created_at_desc, 旧语义回归锁]; Minor×1 归档: TaskBoardView 头注释 assigned 计数表述过度)
Task 9: complete (commits 835be2c..7f0e085, review clean; 双端 recurrence 契约逐字节验证对齐; Minor×2 归档: 排队徽标无负向用例/humanize 不校验时间范围[展示透传])
Task 10: complete (commits 7f0e085..a81ee2f, review clean; Minor×4 归档: 新 promise 无 catch×3 处/teams·sessions 重开不清空/间隔 Input 缺 min=1[负数可过,序列化 every:-5m→electron 侧拒→链静默停]/mock shape 子集无编译期约束)
Task 11: complete (控制器亲验: typecheck 双 clean + electron 179文件/1496 + renderer 106文件/954 全绿; spec §12 七条验收对照通过; spec D3 修订已提交 docs commit)
全部 11 Task 完成——进入终审（whole-branch, 2a8fd62..HEAD）
终审: APPROVED（Ready to merge: Yes）。终审发现 C1 定时管线断链/I1 kickoff 副作用链/I2 mention 错路由已由单修复批收口（37eb698..24bf003, 4 commits）并复审全部 RESOLVED；spec §4.4/§5.3/§5.4 修订已回写。最终验证: typecheck 双 clean + electron 180文件/1507 + renderer 106文件/956 全绿。归档 Minor 32 条全部 SHIP-AS-IS 裁定（1 条升格并入 I1 已修）。macOS 主机冒烟清单: plan Task 11 三条 + 「定时循环任务到点自动 kickoff」为 C1 端到端验收。SDD 执行完毕: 11 任务×（实现+审查）双循环 + T4/T8 终审修复批 + 终审单轮。
bugfix（2026-09-07 主机报告）: #T 激活双驱动——用户正文路由 + executor kickoff 各驱动一轮 agent（导出证据：两轮执行竞速 complete_task，一轮报 completed→completed）。RED 复现（activation-duplicate.test 用例1: kickoff 被调1次）→ 修复：并发有余就地 startTask 无 kickoff / 满槽入队照旧 → 全绿 electron 181文件1509 + renderer 956 + typecheck 双 clean。顺修 C1 批引入的 Date.now flaky 断言。spec §6 已回写。遗留问询：「两个会话」中第二个的确切名称待用户确认（activation 路径已由回归锁保证零新建会话）。

bugfix (2026-09-07 主机报告): 双 bug 一并修复（commit f33a252）。
Bug 1: create_task FK 违约——LLM 把环境上下文 workspaceId/creatorUserId 当作工具必填参数自由填（实际填 "ws_default"/"user_pm"），而 task-tools 的 execute 丢弃了 ctx 字段。修复：ToolContext + RuntimeContext 加 creatorUserId（buildRuntimeContext 从 workspaces.owner_id 注入）；create_task/list_tasks schema 移除 workspaceId/creatorUserId required，execute 强制用 ctx 忽略 args 同名键。RED 测试 task-tools-context.test.ts（5 用例：FK 错复现 + schema not required + LLM 胡填被忽略 + 跨 ws 信息泄漏防护）→ GREEN。
Bug 2: TaskSidebarPanel 「全部状态」只显示 5 活跃态（v2.3 「防历史淹没」设计意图，与用户期望冲突）——改为全 8 态不过滤，历史由 task.store.load 的 orderBy created_at_desc + limit 500 截断保障。修改测试锁定新语义。
全绿：typecheck 双 clean · electron 182 文件 1514（净增 5 个回归锁）+ renderer 106 文件 956。

bugfix (2026-09-07 主机报告严重 bug, commit e9d456f): 快速会话中主 agent dispatch 非会话成员子 agent。
根因：buildDispatchSnapshot 实例级快照（该实例所有 leader 会话并集，spawn 定型）→ agent 曾是任何多成员会话 leader 即带着 dispatch 工具；executeDispatch 无当前会话校验。
修复：executeDispatch 入口三条件校验（当前会话有效成员>1 / 自己 leader / 目标在当前会话成员中），违者 throw → LLM 工具错误，不发事件。5 个既有 dispatch 测试文件补真实 DB seed（agent_definitions→workspace_agent_members→session_members FK 链）。回归锁 dispatch-session-boundary.test.ts 5 用例 RED→GREEN。spec §8 测试策略回写执行时边界语义。
全绿：typecheck 双 clean · electron 183 文件 1519 · renderer 106 文件 956。

bugfix 二段 (2026-09-07 主机报告, commit 284a6d9): dispatch 暴露面——执行时拒绝已生效但快速会话工具/教学 prompt 仍暴露（agent 先 brag 再被拒）。
修复：runChatLoop 每轮按 roomId 调 getSessionDispatchScope（dispatch-wait 抽出，assertSessionDispatchAllowed 复用同源）：不满足会话边界 → dispatch:* 工具与「任务拆分指南」不注入；满足 → 只暴露会话内成员。查询失败保守 null。回归锁 dispatch-visibility.test.ts 3 用例 RED→GREEN。runtime-stream/runtime-task-driven 补文件级 DB 兜底 hook。
全绿：typecheck 双 clean · electron 184 文件 1522 · renderer 956。spec §8 已回写二段语义。

task-delegation-info-loop (2026-09-08, plan docs/plans/2026-09-08-task-delegation-info-loop.md):
Task 1: complete (commits 29581ca..c452c22, review clean — Spec ✅ / Approved, 4 Minor: 断言1→2未申报有removeMember替代/def-z-aux字典序防御/文件头repo枚举过时/getDefs序cosmetic)
Task 2: complete (commits c452c22..4a2e2bf, review clean — Spec ✅ / Approved, 2 Minor: createTask外层JSDoc陈旧未同步K1三分支 / hasTarget两处判定语义分叉——空串''时assigned+warning自相矛盾，spec自身瑕疵)
Final review: NEEDS FIXES → fix cfddcca（hasDelegationTarget 四处收敛+空串归一+JSDoc 同步+repo 枚举+空串回归锁；第 5 文件 task-broadcast.test.ts 为 vi.mock 枚举契约变更的必要下游）。复验 34/34 + 全量 1554/987 + typecheck 双 clean。READY。
Follow-up（终审 N2，非阻塞）：task-tools 写家族（create/complete/fail）缺 broadcastLocalTaskSnapshot 调用——既有缺口非本分支引入，45s 周期重播兜底 staleness 有界；建议下批在 notifyExecutor() 旁各补一行。

=== 侧边栏搜索（2026-09-08，计划 docs/plans/2026-09-08-sidebar-search.md，spec docs/specs/2026-09-08-sidebar-search-design.md，main，BASE=b1409d7[docs commit]）===
Task 1: complete (commits b1409d7..11ef529, review clean——Approved; Minor deferred ×3: ①单目录EACCES整体reject[brief继承,候选加固] ②test:98/100 await非promise TS80007[brief原文] ③symlink目录命中标isDirectory:false[lstat语义,spec一致])
Task 2: complete (commits 11ef529..0bca3f1, review clean——Approved, 契约三端[通道名/参数序/SearchHit形状]逐字对齐实证; Minor deferred ×2: ①handler注释「空串短路」易误读为handler层[brief原文] ②ipc.handlers.test头注释handler枚举陈旧[预存]; 环境注: 全量electron套件容器SIGSEGV经基线worktree复现=预存native binding问题,全量回归留T6/macOS主机)
Task 3: complete (commits 0bca3f1..5f5cada, review clean——Approved, 防抖/竞态/视图切换/设计系统逐项过; Minor deferred ×3: ①stale响应落在下一个防抖窗内短暂渲染[brief设计固有,≤200ms自愈] ②恰好200条时截断提示误报[limit启发式固有] ③目录行不可点仅负向断言[brief原文,div结构保证]; 报告sidecar路径=task-3-report-sidebar-search.md)
Task 4: complete (commits 5f5cada..9cefff7 + fix 35be612, review clean after fix round——审查者Minor①升格为spec§6真实缺口[filter跨workspace切换持久],修复含T3同款问题[RoomList+FileTree切ws复位+2回归锁],复审Approved 36/36独立复跑; Minor deferred ×1: 纯空白输入时清除按钮仍显示[brief原文,无害]; 附注: brief既有用例计数8实为7[笔误])
Task 5: complete (commits 35be612..61cdc05, review clean——Approved, 纯函数等价迁移逐行比对+独立复跑63/63+typecheck+lint; 控制器追加spec§6复位effect已落[组件级测试按裁定豁免,RoomList/FileTree同款已锁]; Minor deferred ×4: ①title/desc非空契约直toLowerCase[类型保证] ②mount首跑冗余setFilter[模式一致] ③input text-xs重复[brief原文] ④复位effect无组件级测试[裁定豁免]; 合理偏差: TaskList.test删brief模板未用TaskRow import[ESLint error,等价])
Task 6: complete (无commit; 控制器亲验三门禁 PASS——typecheck 双 clean / electron 187文件1572 + renderer 107文件1003 全绿[SIGSEGV未复现=负载偶发] / 树净[仅.sdd报告]; 手动冒烟三项留 macOS 主机)
全部 6 Task 完成——进入终审（whole-branch, f3028b3..HEAD, 7 commits 含 docs）
终审（whole-branch, oracle）: APPROVED——Ready to merge Yes。7 commits（f3028b3..61cdc05: 1 docs + 5 feat + 1 fix）。跨任务接缝全闭环（SearchHit 三端逐字/limit 200 双端对齐/reset 三组件语义统一）；spec §3-§8 逐节覆盖；13 条 Minor 全部 DEFER-OK（含 5 条终审新发现：FileTree effect deps workspace 对象身份冗余重触发[EACCES/symlink-dir/头注释等]）。门禁终态: typecheck 双 clean + electron 187文件1572 + renderer 107文件1003 全绿。macOS 主机冒烟三项待办（三视图过滤/恢复/200 截断）。
SDD 执行完毕：6 任务×（实现+审查）双循环 + T4 修复轮（spec§6 workspace 复位，T3/T4 双组件+2 回归锁）+ T5 控制器追加要求 + 终审单轮。Critical 0 / Important 0 / Minor 延期 13 条归档。
Task 1: complete (commit 4fd891b, review clean——Spec ✅ 8/8 + Approved; 29/29+14/14 独立复跑+typecheck 双 clean; Minor deferred ×5: ①旧「八状态」用例名陈旧 ②brief红灯形态措辞 ③MENU_STATUSES不含session_queued[#T菜单看不到排队任务,steer如需引用需上游裁量] ④双端TaskStatus人工镜像无机械锁 ⑤排队/排队中文案近似; 偏差4项全裁定合理[import路径笔误修正/makeTask必填id/注释8→9/新describe块])
Task 2: complete (commit 721d6b4, review clean——Spec ✅ 模块逐字节一致+测试逐字[仅授权路径替换3处] + Approved; 26/26 独立复跑+stream-relay回归19/19; 零依赖环实证; mock保真合格[abort签名全保真/listTasks契约锁2/3字段]; Minor ×5: M1 limit:1未断言 M2 vi.fn零参TS噪音3处[仓库既有quirk] M3报告行数+处数误差 M4 spec§4.1字面位置偏差[plan层已吸收] M5 abortTaskStreamByLane false语义=无记录∪resolver未注入[T5注释需沿用])
Task 3: complete (commit a413436, review clean——Spec ✅ 六文件逐项 + Approved; 45/45 独立复跑; v29偏差裁定保真[trigger实证:831-847/leader接待路由实证/断言零弱化]; 专项A透传链五层无断链 专项B四收尾路径+无递归; Minor ×5: ①starter注释排版 ②finalizeActiveTask插入位置偏离未申报[语义更优] ③registerLane微任务竞态[理论级] ④validateTarget不验会话leader成员[既有边界,v29后更常走,建议后续补] ⑤executor↔router全链集成锁缺[T6可补])
Task 4: complete (commits e423e6e + 0a289f3 回归修复[T3遗漏面,控制器worktree坐实721d6b4全绿→a413436五失败], review clean——Spec ✅ + Approved; 91/91 独立复跑8文件+typecheck clean; 三偏差裁定: a)steer守卫根因实证[router-service.test.ts lane泄漏+mock无steer]生产零漂移[类方法+typecheck强制]但根修留T6 b)result===断言锁v1.5.6 reset+abort裸返回真实语义[优于brief注释] c)5断言严格全等保真; Minor ×6: ①brief import路径笔误静默修正 ②mockClient死夹具 ③LegacyMatrixClient未定义类型[pre-existing] ④0a289f3消息vs实际churn[report整写] ⑤steer×compact交互[固有语义] ⑥router-service.test.ts lane隔离债[T6根修+steer桩同commit])
Task 5: complete (commit 109ef46, review clean——Spec ✅ + Approved; 17文件/113用例独立复跑+typecheck双clean; T2 M-5 false语义沿用正确[注释+兜底广播精准对接]; Minor ×4: ①brief"4处调用方"含未来K7-5表述偏差[实际只2处调用,resume本就不应调] ②K7-4+v2.3双标注释清晰 ③dispatch子流兜底副作用[已知trade-off,本任务MUST NOT] ④测试mock复用beforeEach默认值)
Task 6: complete (无commit; 控制器亲验三门禁 PASS——typecheck 双 clean / electron 192文件1596 + renderer 107文件1005 全绿[SIGSEPV首跑偶发=负载预存flake,重跑全绿] / spec §9 五验收项逐项锁闭见上4任务测试覆盖; macOS主机冒烟三项留待真机)

全特性 6 任务完成——进入 whole-branch 终审（MERGE_BASE 3bba4b8..HEAD, 6 commits: 5 feat + 1 fix回归对齐）
SDD 执行完毕：6 任务×（实现+独立审查）双循环 + T3 回归修复轮（0a289f3 控制器worktree实证T3遗漏回归面，5处严格断言对齐）+ T4 子流程根因（typeof guard生产零影响，T6根修延后DEFER-OK[spec已含处置路径]）。
终审（whole-branch, oracle级）: APPROVED——Ready to merge Yes。7 commits（3bba4b8..109ef46: 1 docs + 5 feat + 1 fix回归对齐）跨26文件 +2285/−212。跨任务接缝六维全闭环（StateStatus双端/session-lane六签名消费/RouteUserChatInput五层透传/registerLane+clearLaneIfMatch配套/notifyExecutor无环/T4-guard生产零影响）。spec §9 五项验收逐项锁闭有代码级证据。25 条 Minor 全部 DEFER-OK，0 Critical/Important。macOS 主机冒烟三项留待真机。
roll-T1: complete (commit 5411031, review clean——Spec ✅ 4处逐字 + Approved; 24/24 独立复跑+typecheck 双 clean; 专项: end done路径镜像一致/字段继承同segment_boundary模式/getMessage!断言有仓内先例[repo.ts:109]; Minor ×3: M1 oldMsg用!而同handler用if守卫不一致 M2新行status_change未配flush[与start模式一致] M3测试4同streamSessionId双行[防御性合同测试,注释自洽])
roll-T2: complete (commit c153749, 控制器亲审通过[配额耗尽双会话阵亡后接管]——Spec ✅ 三处逐字+3用例断言一致 + Approved; 27/27 独立复跑+typecheck双clean; 专项: describe重组零断言变化[已申报] 切点时序结构确认无悬空事件对; Minor ×2: describe3无独立hooks[it4自包含] roll filter三处重复; 实现者会话撞Token Plan限额于收尾阶段[commit+报告均完整落地])
roll-T3: complete (无commit; 控制器亲验——typecheck 双 clean[T2时点] / electron 193文件1604全量全绿[并行SIGSEGV×3=环境内存压力,--singleThread串行全绿] / renderer 107文件1005全绿; spec §6 代码级验收全部由 8 新用例+上游特性套件锁闭; GUI冒烟[ls任务中途改pwd→双气泡+导出4条顺序]留macOS主机)
全部 3 Task 完成——待额度重置后派 whole-branch 终审（MERGE_BASE ba596a5..c153749, 4 commits: 2 docs + 2 feat）
终审（whole-branch, oracle）: APPROVED——Ready to merge Yes。四环闭合（类型/白名单/handler/emit）无断点; rollCounts 三清理路径无泄漏; 上游§5契约零侵入（分流/wire format/回退/沉淀全部未动）; spec§6四项代码级证据齐备。Minor ×8 全部 SHIP-AS-IS/DEFER-OK（T1×3+T2×2+终审新3: N1 roll×segment交互无用例 N2 多steer单drain单roll无直接断言 N3 合并范围应含spec commit ba596a5^..c153749）。macOS主机双气泡冒烟留真机。门禁终态: typecheck双clean + electron 193/1604串行全绿 + renderer 107/1005。
SDD 执行完毕：3任务（T1独立审查 + T2配额耗尽控制器亲审 + T3控制器亲验）+ 终审单轮。
export-rich T1: complete (commit 08f5213, 审查 Spec ✅ + Approved; Minor ×3: 报告文件残留旧特性内容[非阻塞] status_change/final合并case[行为等价] subAgentAvatar有意省略; ⚠️项均属T2/T3预期交接)
export-rich T2: complete (commit f174858, 审查 Spec ✅ 11/11 + Approved; legacy-export 兼容三方验证[未触+类型+body分支]; Minor: TOOL_RESULT_MAX_CHARS 常量行 JSDoc 未加[truncateResult JSDoc 等价覆盖]; ⚠️4项均T3/主机预期)
export-rich T3: complete (commit d9bd455, 审查 Spec ✅ + Approved; 提取保真逐行确认零语义漂移; 2处偏离独立验证通过[?1→匿名? SQLite每次出现独立计数故传双参 / 删未用type import避ESLint error]; 控制器亲验 5文件58/58 + typecheck双clean; 全量195文件1620由实现者报告; ⚠️: 深度≥3与空子流未集成测试[守卫在,渲染标记T2已锁])
终审（whole-branch, oracle）: APPROVED——Ready to merge Yes。三环闭合（类型/渲染/组装）; depth语义=最多嵌套3层第4层截断与spec §5一致; §7六项代码级证据齐; 非对称专项无矛盾残留（对齐表述均限定筛选/顺序层面, thinking排除+args全量为§1用户裁定+§8范围外）。Minor ×8 全 DEFER-OK[0必修]: M1-M4 账面项 / M5 深度≥3生产者路径测试列next-touch首位(渲染标记T2已锁,cap=0变异有集成兜底) / M6 穷尽守卫+EOF换行+凑用断言化妆级 / spec §4草图resultTruncated勘正建议随下批docs。门禁: 控制器亲验58/58+typecheck双clean; 全量195/1620(T3报告)。GUI导出冒烟留macOS主机。
export-rich SDD 执行完毕：3任务全独立审查通过 + 终审单轮。
