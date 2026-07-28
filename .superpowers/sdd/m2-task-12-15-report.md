# M2 Task 12+13+15 报告

合并提交 `7339063`，分支 `feat/m2-dispatch-mcp-skill`。

## T13 pm-agent demo YAML

- 新建 `electron/resources/agents/pm-agent.yaml`（type: main，调度 requirement-analyst / coder）。
- `requirement-analyst.yaml` / `coder.yaml` 改 `type: sub` + `parentAgentId: pm-agent`。
- **manifest-parser 升级**：解析 `spec.parentAgentId`（slug 字符串）/ `defaultMcps` / `defaultSkills`；新增 type 白名单校验 + "非 sub 不得声明 parentAgentId" 语义校验。
- **builtin.ts 升级为两阶段注册**：Phase1 解析全部 YAML；Phase2a 注册无 parent 的 def 并建立 slug→id 映射；Phase2b 注册 sub，把 parentAgentId slug 解析为父 agent 实际 UUID。父 slug 缺失时回退 undefined + 警告（不阻塞）。

## T12 能力配置 UI

- `renderer/src/stores/capability.store.ts`（Zustand）：load/add/remove 调 `allocation:*` IPC。
- `renderer/src/components/agent/CapabilityConfig.tsx`：三层展示——Layer1 agent 默认（只读灰 chip）+ Layer2 workspace 共享（可删蓝 chip + 添加输入框），分 tool/mcp/skill 三组。
- `AgentList.tsx` 加选中态，选中后底部展开能力详情面板嵌入 CapabilityConfig。
- `renderer/src/ipc/types.d.ts` 补 defaultMcps/defaultSkills 字段。

## T15 端到端集成（已确认接线）

1. ✅ builtin 两阶段注册：sub 的 parentAgentId 正确解析为父 id（单测验证）
2. ✅ `assignMain` 过滤 `parentAgentId === mainDef.id`
3. ✅ runtime-entry 仅 main agent 注入 `getDispatchToolDefs(config.subAgents)`
4. ✅ sync-manager `SYNCED_EVENT_TYPES` 含 dispatch/task_reply
5. ✅ IM store 按任意 eventType 存储
6. ✅ MessageBubble 分发到 DispatchCard/TaskReplyCard

## 验证

- typecheck：两 workspace 全绿
- test：agent 65/65 通过；renderer store 测试全绿
- build：两 workspace 全绿
- 预存失败（base `ac62f79` 已存在）：`MainLayout.test.tsx`（4，jsdom instanceof 环境）+ `conduit/manager.test.ts`（3，容器内 fake binary）。均与本次改动无关。

## 注意

requirement-analyst/coder 改为 `type: sub` 后仍可单独 `addToWorkspace`（该路径不校验 type），不破坏 M1 功能。
