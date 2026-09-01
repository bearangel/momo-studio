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
