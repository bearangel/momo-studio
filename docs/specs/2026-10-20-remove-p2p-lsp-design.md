# 移除 P2P 联网与 LSP 子系统设计

- **日期**：2026-10-20
- **状态**：设计已批准（会话裁定）；实施待 spec 过目
- **背景**：产品方向调整——后续联网统一走 momo-hub（未来单独立项）；LSP 若有需要以插件形式回归。P2P 子系统（v2.0.0 P4 落地）整体下线，LSP 子系统（2026-10-08 已下架 agent 工具面、处于休眠态）彻底移除。与 Node 24 + Electron 44 升级（同日 spec `2026-10-20-node24-electron44-upgrade-design.md`）同分支连续作业，终验阶梯共用。

## 1. 目标与范围

**删除**：
- P2P 全部：Ed25519 身份 / mDNS 发现 / TCP 传输 / hub-transport 死码 / 资源分享与导入 / 任务只读镜像 / marketplace `source='p2p'` / 对应 IPC、UI、测试、依赖
- LSP 全部：语言检测 / LspManager / 面板 IPC / 休眠工具链（lsp-tools、lsp-ipc-bridge、lspLanguages 注入链）/ 依赖

**保留**：
- `session:message` 推送通道本体（p2p 仅是发送方之一，本地链路不依赖）
- `messages.source` 列本体（值域收窄为 `'local'`）
- userData 残留文件（`p2p-identity.json` / `p2p-trusted-nodes.json` / `lsp-bin/`）——无代码再读取，不清理，CHANGELOG 记录

**明确不做**：momo-hub 本次不留任何桩或接口预留；LSP 不留恢复钩子（未来插件形式重建）。

## 2. 盘点结论（驱动删除的实证清单摘要）

| 面 | P2P | LSP |
|---|---|---|
| 主进程源码 | `electron/src/main/p2p/` 16 文件 / 2520 行 | `electron/src/main/lsp/` 6 文件 / 1349 行 |
| 外部导入边 | 12 文件：`main/index.ts:23,232-237,259`、`ipc/index.ts:32,87`、`im/session-service.ts:24,193,341`、`task/ipc.handlers.ts`（8 调用）、`task/lifecycle.ts`、`task/groups.ipc.handlers.ts`、`task/recurrence.ts`、`agent/runtime-registry.ts:31,286`、`agent/ipc.handlers.ts:56`、`resource/ipc.handlers.ts:91-92,175-195`、`resource/mcp-config.ts:35,261`、`resource/library.ts:12,30,95-112,138` | 6 文件：`ipc/index.ts:24,76`、`agent/agent-runner.ts:42,310-313`、`agent/runtime-entry.ts:115,387-389,497-498`、`agent/tools/index.ts:34,61-62`、`agent/tools/lsp-tools.ts:10` |
| IPC 面 | `p2p:getIdentity/getDiscoveredNodes/addTrustedNode/removeTrustedNode/listTrustedNodes/getRemoteTasks`（`p2p/index.ts:278-326`）+ preload 538-547 + types.d.ts 2334-2366 | `lsp:status/redetect/install/start`（`lsp/ipc.ts:278-297`）+ 子进程 `lsp:op`/`lsp:op-result` 协议 + preload 346-352 |
| Renderer | `components/p2p/NodeDiscoveryPanel`、设置分类 `'p2p'`（store:16 + SettingsNav:22 + SettingsView:22,81）、`TaskSidebarPanel` remote 段、`lib/task-status.ts remoteStatusStyle`、IM `remote:` 前缀面（sender/avatars/MessageBubble）、资源库 `p2p` 源（TypePageShell/SourceBadge/ResourceRow/ResourceDetail/resource-helpers/resource.store） | 孤儿面板 `LanguageServicesPanel`（已无挂载）、types.d.ts `LanguageStatus`/lsp 桥块、`describe-tool-call.ts:37` 残留 |
| 测试 | `tests/p2p/` 16 文件 4558 行 + **15 个外部文件 `vi.mock` 必须同步摘除**（task×4、im×4、single-instance、memory、agent×3、resource×3） | `tests/lsp/` 6 文件 1190 行 + agent 目录耦合（lsp-tools/runtime-config-lsp/integration/catalog-selfdescribe/tools-catalog/permission/migrations-016/preset-consistency） |
| 依赖 | `bonjour-service` / `tweetnacl` / `ws` + `@types/ws`（均独家消费） | `typescript-language-server`（devDep，仅 lsp 测试消费） |
| DB | 无专用表；共享面：`tasks.source_node_id`（migration 19）、`messages.source` 枚举 `'lan'/'hub'`、资源表 `source='p2p'` 行 | 无表；migration 16 `BUILTIN_TOOL_REFS` 种子含 lsp 休眠引用 |

高危耦合点：`session:message` 共享通道（仅摘 p2p 发送方）；`ResourceSource` 联合横跨双 workspace 约 10 文件；LSP 休眠契约四位一体（spawn-helpers:404-407 注释 ↔ LSP spec 横幅 ↔ coder/code-reviewer.yaml 休眠引用 ↔ preset-consistency 豁免）；SettingsView.test 十二分类锁改十一。

## 3. 实施序列

### 系列 A：`refactor: 删除 LSP 子系统`（先行，小切口）
1. 工具链层：`agent/tools/lsp-tools.ts`、`agent/tools/lsp-ipc-bridge.ts`、`tools/index.ts` 注册行、`tools/types.ts` `lspLanguages`、`runtime-config.ts` 三处（124/225/522-524）、`runtime-entry.ts` 三处（113-115/387-389/497-498）、`agent-runner.ts` 路由（40-42/310-313）、`output-truncate.ts` `OUTPUT_LIMITS` lsp 两键
2. 主进程：`src/main/lsp/` 整目录 + `ipc/index.ts:24,76` 注册
3. 休眠契约四位一体同步：spawn-helpers 注释更新、YAML 休眠引用摘除、preset-consistency 豁免逻辑收窄、LSP spec 头部状态改「已移除（2026-10-20）」
4. Renderer：孤儿面板 + 测试、types.d.ts LSP 块（437-456/2175-2185）、preload 346-352、`describe-tool-call.ts:37`
5. 测试：`tests/lsp/` 整目录；agent 目录 8 处耦合用例段摘除（保留各文件其余用例）
6. `typescript-language-server` devDep 卸载

### 系列 B：`refactor: 删除 P2P 子系统`
1. Renderer：节点面板目录、设置分类三件套（union/nav/View 渲染分支 + 测试锁）、任务侧栏 remote 段 + `remoteStatusStyle`、IM `remote:` 前缀分支三件（sender/avatars/MessageBubble）+ 各自测试、资源库 `p2p` 源六件（TypePageShell/SourceBadge/ResourceRow/ResourceDetail/resource-helpers/resource.store）+ 测试
2. 主进程外部边 12 文件：`broadcastLocal*` 调用行与导入、`library.ts` p2p 合并分支（`needP2p`/`p2pItems`）、`resource:install` p2p 分支（175-195，保 marketplace/hub 路径）、`mcp-config.ts` 广播
3. 接线：`ipc/index.ts` 注册、`main/index.ts` initP2p/stopP2p（232-237/259）、preload 538-547、types.d.ts p2p 块（186/194/873-977 的 p2p 部分/1400/2334-2366，含 `RemoteNodeTasks`/`TaskSnapshotItem`/`transport:'hub'` 广告）
4. `src/main/p2p/` 整目录删除
5. 测试：`tests/p2p/` 整目录 + 15 个外部文件 `vi.mock` 摘除与相关断言段
6. 依赖卸载四项

### 系列 C：DB 迁移 v63（P2P 数据/schema 彻底清，用户裁定 A）
1. 核查 `tasks.source_node_id` 上索引，有则先 `DROP INDEX`
2. `ALTER TABLE tasks DROP COLUMN source_node_id`
3. `DELETE FROM messages WHERE source IN ('lan','hub')`
4. 资源表 `source='p2p'` 行清理（表/列名实现时按 migrations 实况钉死）
5. `agent_definitions.default_tools` lsp 引用清理（json_remove；**不改 migration 16 本体**——已应用迁移不可变，新迁移对 fresh/存量库同等生效）
6. repo/类型同步：`MessageSource` 收窄、`tasks/repo.ts` `sourceNodeId` 映射 8 处、`ResourceSource` 联合去 `'p2p'`（双 workspace）
7. v63 专属迁移测试（含 fresh 库与升级库两态）

## 4. 验证阶梯（与升级任务终验合并，一次跑完）

typecheck → lint → electron 全量单测 → renderer 全量单测 → build → `pack --dir` → e2e（无 p2p/lsp 用例，已核）→ 真机验收（momo-acceptance，重点回归删除面消费侧：设置 11 分类、资源库四源过滤、任务侧栏、IM 消息、agent spawn）→ 孤儿 worker/AMFI 自查 → `.omo/qa-reports/` 报告。

## 5. 版本与文档

- 三处 `package.json` → `2.1.0-alpha.22`（合入大特性 +1 纪律）
- CHANGELOG 移除条目（行为影响明示：LAN 节点发现/任务镜像/资源分享/语言检测功能消失；userData 残留文件说明）
- AGENTS.md：P4 局域网段落、架构关键点「LAN p2p」与 `source='p2p'` 提及、关键文档表 p4 计划行——改写为历史记述
- README：连接性/资源库/roadmap 相关行
- docs/specs：LSP spec 状态横幅改「已移除」；v2.0.0 设计文档 P2P 节加移除注记（历史文档不改写正文）

## 6. commit 划分

1. `docs:` 本 spec
2. `refactor:` 系列 A（LSP）
3. `refactor:` 系列 B（P2P）
4. `refactor:` 系列 C（迁移 v63 + 类型收窄）+ CHANGELOG/版本号/文档同步
5. 验收产出（qa-reports 不入库）
