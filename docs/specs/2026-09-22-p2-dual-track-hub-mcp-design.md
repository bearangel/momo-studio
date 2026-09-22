# P2 双轨 Hub MCP 接入设计（Smithery + 魔搭）

- 日期：2026-09-22
- 状态：已批准（brainstorm 定稿）
- 上游：`docs/specs/2026-09-22-resource-library-ui-redesign-design.md`（RegistryProvider 可插拔预留位的兑现）
- 调研底座：2026-09-22 MCP/Skill 分发生态调研 + Cherry Studio 源码分析（结论记入本文附录）

## 1. 背景与动机

资源库 v1 的「网络获取」实际是单源：GitHub Raw 上的 catalog.json（失败回退内置同款文件）。两个已证实的问题：

1. **CN 网络不可达**：`raw.githubusercontent.com` 长期不可靠，已引发「面板切换卡顿」（2026-09-22 修复：失败 60s 退避负缓存，commit 6a6c311）。单源设计对国内用户形同虚设。
2. **零真安装**：catalog 全部条目 `downloadUrl=""`（内联），真远程下载链路（tar+sha256）零条目使用；MCP「安装」业界语义是写 stdio 配置而非下载包。

调研结论（2026-09，关键事实）：

| Hub | 规模（自报） | API | 主流安装形态 |
|---|---|---|---|
| Smithery | 6,000+ servers | ✅ 全套 REST + OpenAPI spec + skills API 同域 | stdio（npx / MCPB bundle）+ hosted |
| 魔搭 ModelScope | CN 官方 | ✅ OpenAPI 官宣覆盖 MCP（阿里云 2026-02） | **hosted 远程端点**（streamableHttp + token） |
| 百炼 | CN 官方 | ⚠️ Cherry 已集成（bailian.ts），公开 API 未核实 | hosted |

内部约束：`registerMcpDefinition`（`electron/src/main/mcp/host-manager.ts:172`）当前 transport 固定 `'stdio'`，`McpClient` 仅支持子进程 spawn——魔搭 hosted 形态不可装。

## 2. 目标 / 非目标

**目标**：MCP 页「从网络获取」支持双轨 provider，手动选择、不可达置灰、记忆偏好：

1. Provider 多实例框架 + 顶栏选择器 UI
2. Smithery 接入（stdio 安装：registry → install profile 解析 → npx 配置写入）
3. 魔搭接入（remote 安装：streamableHttp + token）
4. `McpClient` streamableHttp 传输扩展（runtime 域）
5. 魔搭 token 入 keychain + 设置页字段

**非目标（P3 候补）**：百炼 / Glama / PulseMCP 接入；MCPB bundle 下载；UV/Bun 依赖自动安装管家；**Skill 网络获取**（国内无成熟 skill hub，双轨承诺不成立；Smithery skills API 与 skills.sh / clawhub.ai 留 P3 一起评估）；Agent 网络获取（维持内置）。

## 3. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 地区体验 = 手动 provider 选择 + 不可达置灰（不自动探测、不双列） | 实现最简零误判；置灰复用退避信号，零成本获得自动探测的大部分收益 |
| D2 | P2 含 remote transport 扩展（完整双轨） | 魔搭主流形态即 hosted remote；remote MCP 是业界标配（Cherry/Claude 均支持），投入不只服务魔搭，也服务未来手填远程 URL |
| D3 | Skill 网络获取留 P3 | 国内 skill hub 空缺，双轨不成立；P2 聚焦 MCP 一次做透 |
| D4 | hub API 调用一律主进程代理，renderer 只发 IPC | 退避负缓存模式已在主进程成型（fetchCatalog）；统一超时/代理/日志；魔搭 token 不进 renderer |
| D5 | `ResourceSource` 枚举扩展 `'smithery' | 'modelscope'`（非 marketplace 子标记） | 对齐「三类 × 多来源」心智；UI 徽标 / 过滤 / 卸载语义按 source 路由清晰 |
| D6 | streamableHttp 客户端手写（JSON-RPC over HTTP POST），不引 @modelcontextprotocol/sdk | 与现有手写 stdio McpClient 风格一致、零新依赖；魔搭 hosted 简单 POST 即可；SSE 流式响应留 P3 |
| D7 | Smithery stdio 安装走 install profile → npx 命令，不做 MCPB bundle 下载 | npx 覆盖 80% 场景；MCPB 解包/落地复杂度高，P3 |
| D8 | S1 注入防线全链路复用 | hub 条目的 slug/version/command 同样过白名单校验（`marketplace/types.ts` 现有 pattern），remote url 强制 https |

## 4. 架构

### 4.1 Provider 框架

```
renderer                          electron 主进程
RegistryBrowse ──IPC──► resource:registryList(providerKey, type, query)
    │ 顶栏选择器                        │
    │ 置灰=退避信号               Provider 注册表（静态）
    ▼                              ├─ builtinCatalogProvider（现内置市场，离线兜底）
resource.store                     ├─ smitheryProvider  ──► api.smithery.ai（退避 60s）
  providerKey 持久化               └─ modelscopeProvider ──► 魔搭 OpenAPI（退避 60s）
```

- Provider 接口对齐现有 `RegistryProvider`（`renderer/src/services/registry/types.ts`），主进程侧镜像定义；返回统一 `RegistryEntry[]`（现结构 + provider 标记）
- 每个 provider 自带退避负缓存实例（复用 `fetchCatalog` 的 60s 模式抽公共小工具）
- 可达性信号：主进程返回 `{ entries, degraded?: boolean }`，degraded 命中时 UI 置灰该 provider（不隐藏）

### 4.2 Remote transport 扩展（runtime 域）

- migration：`mcp_definitions` 加 `url TEXT`、`headers_json TEXT` 列；`transport` 写入二态 `'stdio' | 'streamable_http'`
- `McpClient`：构造参数二态化——stdio 走现有 spawn；streamable_http 走 HTTP POST JSON-RPC（initialize / tools/list / tools/call，超时对齐现有 `REQUEST_TIMEOUT_MS`）
- `registerMcpDefinition` / `getMcpConfig` / `listRegistered` 二态透传；进程池 key（workspaceId:name）与生命周期语义不变（remote 无进程，「断连」= 请求失败重试）

### 4.3 安装与卸载链路

- Smithery stdio：list → 选中 → 拉取 server 详情 install profile（command/args/env）→ S1 校验 → `registerMcpDefinition(stdio)` + `installed_packages` 记账（itemId = `smithery@{namespace}/{server}`）
- 魔搭 remote：list → 选中 → 写 `transport='streamable_http'` + url + headers（token 从 keychain 取）→ 同表注册
- 卸载复用 marketplace 卸载语义，按 source 分流清理
- installed 状态翻转：沿用 registry 行 ↔ store items 的 id 映射派生（现有机制不动）

### 4.4 UI 变更

- `RegistryBrowse` 顶栏「来源：内置市场」静态文字 → provider 下拉（按当前 type 过滤可用项；smithery/modelscope 仅 MCP 页出现）
- 选择记忆持久化（`resource.store.providerKey`）；置灰态样式走语义 token
- `ResourceDetail` marketplace 元数据段直接复用（author/readme/verificationStatus 已通用渲染）
- 设置页新增「魔搭 Access Token」字段（写 keychain，现有 `setSecret` 基建）

## 5. 数据与契约

- `ResourceSource = 'builtin' | 'marketplace' | 'custom' | 'p2p' | 'smithery' | 'modelscope'`
- 同步点（momo-boundary-rules 全量）：`electron/src/main/resource/types.ts`（`parseResourceId` 正则 / `SOURCE_LABELS`）、`renderer/src/ipc/types.d.ts`、preload 桥、`buildResourceId` 消费方
- 新 IPC：`resource:registryList(providerKey, type, query?)`（渲染侧只读）；安装/卸载复用现有通道（source 扩展）
- `mcp_definitions` migration 一列不冗余：url/headers 仅 remote 行使用

## 6. 错误处理

- hub API 失败：per-provider 60s 退避 → UI 置灰 + 现有重试按钮；退避窗口内零网络请求（面板切换不卡，教训 6a6c311 的制度化推广）
- remote MCP 连接失败：对齐 stdio 池语义（下次调用重建）；token 缺失 → 安装时抛可操作错误引导跳设置
- hub 返回畸形条目：S1 校验拒（单条拒绝不污染整页，与 catalog 整体拒绝策略不同——hub 是第三方，单条损坏不应拖垮列表）

## 7. 安全

- 魔搭 token 只存 keychain，主进程取用，renderer 仅见「已配置/未配置」布尔
- Smithery install profile 的 command/args/env 过 S1 白名单（slug/version/npm 包名 pattern 现成）
- remote url 强制 https；headers 不打日志

## 8. 测试策略

- 主进程：两 provider 单测（mock fetch：搜索/分页/退避/畸形条目拒）；transport 二态 round-trip（注册→读取→连接 mock）；migration 测试
- renderer：provider 选择器交互（切换/置灰/记忆）；ResourceDetail 渲染 hub 条目
- 契约锁：ResourceSource 两端枚举对齐（红测先行，momo-boundary-rules）

## 9. 前置核实（plan Task 0，≤半天）

1. Smithery `List all servers` 无 key 冒烟（分页字段 / 搜索参数 / profile 获取路径）
2. 魔搭 OpenAPI MCP 列表接口文档定位 + token 流程核实（若接口不达预期，魔搭轨降级为「P3 + 内置市场顶住」，不阻塞 Smithery 轨）

## 10. P3 候补清单

MCPB bundle 下载；百炼 / Glama / PulseMCP；UV/Bun 依赖管家；Skill 网络获取（Smithery skills API / skills.sh / clawhub.ai）；remote SSE 流式响应；用户手填远程 MCP URL；私有 marketplace（远期 roadmap 既有项）。

## 11. 信源附录（2026-09-22 调研）

- MCP registry 对比（2026-07）：thinkneo.ai/blog/mcp-registries-compared-20260714
- Smithery 官方文档树 / OpenAPI spec：smithery.ai/docs（llms.txt）
- 魔搭 OpenAPI 覆盖 MCP 官宣（2026-02）：developer.aliyun.com
- Cherry Studio MCP/Skill 实现源码分析：github.com/CherryHQ/cherry-studio（`McpPackageService` / `providers/{bailian,modelscope}.ts` / `src/main/ai/mcp/servers/skills.ts` skills.sh + clawhub.ai）
- 面板切换卡顿根因与退避修复：commit 6a6c311、`electron/src/main/marketplace/client.ts`
