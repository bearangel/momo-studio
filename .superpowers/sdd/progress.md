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
