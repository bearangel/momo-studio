# Task 11 Report: renderer 类型 + stores（agent/session store 层切换）

**Status: COMPLETE** | Branch: `feat/agent-team-session-redesign` | Date: 2026-09-01
（v1.6 旧同名报告已归档为 `task-11-report-v1.6-archived.md`）

## 交付内容（spec §5-6）

### agent.store.ts — assignments→members 彻底化 + 团队 action

- 状态：`assignments` → `members: WorkspaceAgentMember[]`；新增 `teams: Team[]` + `teamsWorkspaceId`（team 变更 action 成功后按它自动 reload——单一真相源 = DB，不做本地 patch）
- action 更名：`loadAssignments`→`loadMembers`、`addAgent`→`addMember`、`updateAssignmentApiKey`→`updateMemberApiKey`、`getAssignmentDeltas`/`setAssignmentDeltas`→`getMemberDeltas`/`setMemberDeltas`、`stopAgent`/`startAgent`→`stopMember`/`startMember`
- 新增：`removeMember`（透传 `{ ok: false, blockedTeams }` 结构化结果，leader 守卫不误报成功、不刷新）、`loadTeams`/`createTeam`/`renameTeam`/`deleteTeam`/`setLeader`/`addTeamMember`/`removeTeamMember`
- `reset()` 扩展清空 teams/teamsWorkspaceId

### session.store.ts — 双会话动作 + NO_DEFAULT_AGENT 错误态

- `createQuickSession(workspaceId)`：成功 → 新会话置顶 + `selectSession` 激活（拉空历史 + 成员），返回 true；`NO_DEFAULT_AGENT`（error message 子串识别——Electron IPC 桥只保 message，types.d.ts 契约注释）→ `needsDefaultAgent=true` 返回 false；其他错误 → `error` 写入
- `createCollabSession(workspaceId, title, target)`：title=undefined 透传（动态命名占位起步）；同激活语义
- `needsDefaultAgent` 复位时机 = 下次 createQuickSession 尝试开始（引导弹窗选择后重试场景有专项用例）；`reset()` 清空
- sendMessage `mentionedInstanceIds` 语义核对 ✓（透传正确；stale 测试名 mentionedAssignmentIds 已更正）

### 类型/消费面裁定

- **setDefaultAgent 不在 agent.store 重复暴露**：workspace.store.setDefaultAgent 已由 T6 实现（含 5 个测试用例）。双入口 = 契约漂移风险（8 个 P0 中 4 个源于漂移），Task 12 UI 沿用 workspace.store 单一入口
- preload 悬空绑定核对：`assignMain`/`updateAssignmentRole` renderer 侧零调用残留（仅注释提及）✓
- 消费方机械更名 15 文件：useBotNames / RoomList / TaskSidebarPanel / TaskFilters（注释）/ AssignmentApiKeyEditor / AssignmentCapabilitiesDialog(+test) / AddToWorkspaceDialog(+test) / WorkspaceAgentsPanel(+test) / AgentsView.test / DefinitionEditor(+test) / MainLayout(+test)
- RoomList.tsx 为首轮 grep 漏网消费方（`.assignments` 解构），全量测试捕获（16 红）→ 修复——回归网有效性的旁证

### workspaceId 消费清理（T10B 移交）

- types.d.ts `AgentDefinition.workspaceId` 注释改为「v25 恒 null（migration v25 已 DROP 列），显示逻辑不得依赖」；字段保留与 electron 端结构对齐（electron rowToDef 同样恒 null 保留）
- AgentLibrary：分组改 source-only（内置/自定义；「本工作空间私有」组删除——恒空组）；ScopeBadge 去 workspaceId 参数
- DefinitionEditor：scope radio 删除（v25 定义全局化，选项已无实义）、edit 回填 `def.workspaceId === null` 判断删除、createCustom 恒传 `scope: 'global'`、updateDefinition 不再传 scope/workspaceId（undefined=不改）

## TDD 记录

- 红：agent.store 20 失败 + session.store 8 失败（全部「缺 action/字段」非 typo）→ 绿：23 + 47
- 3 个中途测试自伤已修（mock 调用计数未清 ×2 / createTeam mock 返回值 ×1）——均为测试侧问题，实现未回改

## 错误路径覆盖（momo-test-rules 铁律 3）

- loadMembers / loadTeams IPC 失败 → error 写入
- addMember 重复加入（UNIQUE 约束文案）→ 抛错 + members 不追加
- removeMember blockedTeams 透传 + 不刷新；IPC 抛错上抛
- createTeam leader 不在成员集 / setLeader 非团队成员 → 抛错 + error
- createQuickSession：NO_DEFAULT_AGENT / 其他 IPC 错误 / 重试成功复位 三路径
- createCollabSession：IPC 失败不激活 + title=undefined 透传

## 验证

- renderer 全量 **643/643 全绿**（69 文件；T6 后基线 621 → +22 用例，零新增红）
- 双 workspace typecheck **clean**（electron + renderer）
- electron 侧未改动（148 红为已知中间态，属 Task 12+ 收敛范围）

## Concerns / 移交

1. **WorkspaceAgentsPanel/AddToWorkspaceDialog/AssignmentCapabilitiesDialog 已是待删代码**（Task 12 以 MembersPanel/TeamsPanel/新弹窗取代）——本任务仅机械更名保持编译，未做 UI 改造
2. `agent.assign` / `workspace.getCoordinator` 旧通道仍在 types.d.ts + preload（Task 15 退役清理）
3. `AgentAssignment` 类型别名仍在（Task 15 删除）；组件内 `assignment` 局部变量/props 名未强改（别名有效，避免无谓 churn）
4. session.store `send()` 返回的 `readOnly`（T9 加）本任务未入 state——会话只读 UI 属 Task 14 范围

## Commit

- `feat(renderer): agent/session stores——成员/团队/双会话动作（spec §5-6）`
