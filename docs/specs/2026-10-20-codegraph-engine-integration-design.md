# codegraph 插件引擎整合设计（v2.0.0）

- 日期：2026-10-20
- 状态：已批准（设计 8 节经用户逐节确认）
- 上游：docs/specs/2026-10-17-plugin-workspace-dimension-design.md（插件工作空间维度）
- 范围分支：待建 `feat/codegraph-engine-integration`

## 1. 背景与动机

### 1.1 三病灶（2026-10-20 排查结论）

| # | 症状 | 根因 | 层 |
|---|---|---|---|
| 1 | dape 工作空间搜不到 Java 代码（`InitGuideApplicationServiceImpl` 等 6446 个 .java 全部未索引，仅 11 个 js 入图） | 自研 indexer `CODE_EXTS` 只认 JS/TS 系 | 插件 |
| 2 | 工作空间隔离体感失效 | 全局 `config.json` 残留 `workspaceRoot=dap-e_server`，且 `getPluginConfigView`/`resolvePluginConfig` 合并视图无 scope 过滤——残留值 fallback 泄漏给所有未配 per-ws 值的工作空间 | 插件系统 |
| 3 | `indexCommand` 配置死置 | manifest 声明了「自定义索引命令」但代码从未读取 | 插件 |

### 1.2 产品哲学裁定（用户）

插件系统 = **安装即全功能，零外部依赖**。codegraph 插件必须完整内置引擎——用户装插件即得全部能力（30+ 语言索引/查询/auto-sync），不要求安装任何全局 CLI。

## 2. 目标 / 非目标

### 目标

- codegraph 插件内置 colbymchenry/codegraph 引擎（vendor 分发），Java/Python/Go 等 30+ 语言开箱可用
- 插件形态转为声明式：manifest + mcp.json + panel；自研 indexer/tools/service/hooks 全退役
- per-ws 引擎多实例：每工作空间一个引擎进程，各索引各自 `workspaceRoot`
- 修掉病灶 2（config 合并面 scope 过滤）与病灶 3（死配置清理）
- 存量用户无感迁移（migration 064 + 残留清理）

### 非目标

- 不做引擎自愈下载（`CODEGRAPH_NO_DOWNLOAD=1`，离线哲学）
- 不做 in-process 嵌入（主进程 Node 24.22 虽已满足 Library API 的 22.5+ 门槛，但 SQLite/watcher/worker threads 进主进程的冻结风险 + MCP 链现成，子进程隔离是更优架构）
- 不做引擎版本与插件版本解耦（插件版本 = 引擎版本，升级引擎 = 发新插件版）
- 不改 MCP 工具的 per-tool 门控（server 级门控已够，见 §5.1）

## 3. 关键事实依据（引擎形态调查，2026-10-20）

| 事实 | 值 | 影响 |
|---|---|---|
| npm 包结构 | main 1.2MB shim + 6 个平台 optionalDependencies（各 ~280MB 未压缩，含 vendored Node 24 + 完整 app + 依赖） | vendor 必须带平台包；main 单包不可用 |
| 压缩产物 | GitHub Releases per-target `codegraph-<target>.tar.gz` ≈ 50MB（自足：解压后 `bin/codegraph` 直接跑） | zip 内嵌压缩 tarball，磁盘 ~280MB |
| 平台矩阵 | darwin-arm64/x64、linux-arm64/x64、win32-arm64/x64 | marketplace 6 变体 |
| 引擎即 MCP server | `codegraph serve --mcp --path <root>` stdio JSON-RPC；默认暴露 `codegraph_explore` 一个工具，其余 unlisted（`CODEGRAPH_MCP_TOOLS` 开启） | 直接接 momo 现成 MCP 链 |
| 数据目录 | 固定在被索引项目根下，`CODEGRAPH_DIR` 只能改名（单 path segment）不能外置 | 用 `.momo-codegraph` 与 OpenCode 的 `.codegraph` 隔离 |
| auto-sync | 引擎自带 watcher（FSEvents/inotify/RDCW，默认 2s 防抖），`codegraph init` 后自动开启 | momo 侧增量 hook 机制可整体退役 |
| 许可 | MIT | 可 vendor 分发 |

## 4. 总体架构

### 4.1 插件包结构与平台分发

```
codegraph.zip（按平台变体，~55MB）
├── momo-plugin.json      # components: { mcp, panel }；vendor 声明（§4.2）
├── mcp/mcp.json          # 模板声明（占位符不预展开）
├── panel/                # 面板沿用；stats 数据源改走 MCP status 工具
└── vendor/codegraph-<target>.tar.gz   # 压缩引擎（SHA256 随 manifest 声明）
```

- marketplace catalog：同一插件 id 挂 6 个 target 条目（新增 `platforms` 字段），安装器按 `process.platform + process.arch` 自动选变体，用户无感知
- 本仓库 dev 形态：`plugins/codegraph/` 下 `mcp/` + `panel/` + `engine/`（已解压目录直用，开发流程不强制 tarball）

### 4.2 安装链新能力：vendor 解压

- zip 解压后扫 `vendor/*.tar.gz` → 校验 SHA256（manifest `vendor.sha256`）→ 解压到 `installed/<id>/<version>/engine/`
- 独立守卫：manifest `vendor.maxUnpackedMB`（默认 512）+ tarball 条目数上限（20000）；超限拒装回滚
- zip 既有守卫（200MB/5000 条目）不动——tarball 是 zip 内单条目，天然合规
- 卸载/禁用链清 engine 目录（§8.6 禁用即消失语义不变）；升级 = 新版本目录整体替换

### 4.3 MCP 集成与 per-ws 多实例

`mcp.json` 存**模板**（注册到 mcp_definitions 不展开）：

```json
{ "servers": { "codegraph": {
    "command": "${engineBin}",
    "args": ["serve", "--mcp", "--path", "${config.workspaceRoot}"],
    "env": { "CODEGRAPH_NO_DOWNLOAD": "1", "CODEGRAPH_DIR": ".momo-codegraph" }
}}}
```

- **host-manager 改造（本设计唯一系统级核心改动）**：`getOrStartMcp` spawn 前检测定义含占位符 → 展开：
  - `${config.<KEY>}`：`resolvePluginConfig(pluginId, schema, workspaceId)` 按 ws 展开；`workspaceRoot` 无值时展开为该 ws 的 `directoryPath`（消灭「索引挂错」类配置错误的根）
  - `${engineBin}`：插件宿主解析到 `engine/` 内平台启动器绝对路径（非 config 值，插件 loader 的内置占位符）
- 进程池 `poolKey(workspaceId, mcpName)` 已 per-ws：每 ws 一个引擎进程，各自展开各自 root；`stopAllMcpForWorkspace` 回收链现成
- `mcp-sync.ts` 注册路径不再调用 `substituteConfigTemplate` 预展开（模板态入库）；展开逻辑迁移至 host-manager spawn 时点

## 5. 工具面与 agent 装配迁移

### 5.1 门控粒度 trade-off（已裁定接受）

- 自研工具的 per-tool 门控（`plugin:codegraph/explore` 精确名）退场；MCP 面为 **server 级门控**（capability_type='mcp'，ref='codegraph'）
- codegraph MCP 默认仅暴露 `explore` 一个工具，server 级 = 无实际损失

### 5.2 migration 064

- `agent_assignment_capabilities` 中 `plugin_tool | remove | plugin:codegraph/*` 行改写为 `mcp | remove | codegraph`（`INSERT OR IGNORE` 防主键冲突，原行删除）
- 成员编辑弹窗：codegraph 退出「插件工具」分组（无 createTools），改经 MCP 能力面（addedMcps/removedMcps 现成链）管理

## 6. 配置与数据

- config schema v2：保留 `workspaceRoot`（scope=workspace，留空=跟随 ws 目录）；删除 `indexCommand`、`maxFiles`
- 索引数据：被索引项目根下 `.momo-codegraph/`（SQLite WAL + 引擎自管 .gitignore）
- auto-sync：引擎 watcher 负责；`hooks/reindex.js` + reindex-queue 机制整体退役

## 7. 错误处理

| 面 | 行为 |
|---|---|
| 安装 | SHA256 校验失败拒装；解压守卫超限拒装回滚；平台变体不匹配拒装 |
| 引擎缺失/损坏 | spawn 失败走现有 MCP 失败链（工具调用错误可见）；不自愈下载 |
| 大仓首启索引 | 引擎后台建图；查询响应带 staleness banner（引擎自带语义，agent 可感知） |
| workspaceRoot 无效 | 引擎 spawn/运行时报错，工具调用面可见 |

## 8. 测试与验收

- 单测：installer vendor 解压与守卫；mcp 模板 per-ws 展开（含 workspaceRoot 留空 fallback）；marketplace 平台变体选择；config scope 过滤（回归锁）
- **L2 harness 锚点**：双 ws（各放 TS/Java 样例工程）→ 安装插件 → 断言两个引擎实例各自命中**各自语言**符号——**Java 命中是 dap-e_server 惨案的回归锁**
- L3 真机（momo-acceptance）：真 LLM 会话问「`InitGuideApplicationServiceImpl.getOverview` 被哪些方法调用」→ agent 一次 `codegraph_explore` 命中（不再 grep 自救）

## 9. 存量迁移与兼容（含插件系统 side-fix）

### 9.1 config 合并面 scope 过滤（病灶 2 修复）

- `getPluginConfigView` / `resolvePluginConfig`：`scope=workspace` 键**只从 per-ws 层取值**，不再从全局层 fallback；`scope=global` 键行为不变。无 `workspaceId` 调用（全局视角）：workspace 键取值为 `undefined`（表单呈现为空 = 跟随工作空间目录默认语义）
- boot 检测：全局层存在 workspace-scope 键残留 → warn 日志（不自动删，保守）
- 用户真库处置：升级落地时清 `~/.momo-studio/plugins/data/codegraph/config.json` 残留（备份先行）

### 9.2 退役清单

- `plugins/codegraph/lib/`（自研 indexer）、`tools/`（explore/status 自研工具）、`service/`（自研 RPC）、`hooks/`（reindex 队列）删除
- `panel/` 保留，stats 数据源接 MCP status
- 插件版本 **2.0.0**（工具面破坏性变更）
- marketplace catalog：codegraph 条目挂 6 平台变体

## 10. 实施切分建议（供实施计划参考）

1. 系统侧：config scope 过滤 + boot warn（独立可先行，带回归锁）
2. 系统侧：installer vendor 解压 + 守卫 + 平台变体
3. 系统侧：host-manager 模板展开（${config.*} per-ws + ${engineBin}）
4. 插件侧：plugins/codegraph 重构（manifest v2 / mcp.json / panel 改造 / engine 归置）
5. migration 064 + 存量清理
6. L2 harness（双 ws 双语言锚点）+ L3 真机验收

## 11. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 引擎 tarball 体积（磁盘 ~280MB/平台） | manifest 声明守卫上限；安装 UI 明示磁盘占用 |
| 大仓首次索引期间查询空/buffer | staleness banner 引擎自带；L3 验收覆盖 |
| host-manager 展开改动影响存量非插件 MCP | 展开仅在定义含占位符时触发，存量静态定义零影响 |
| 引擎升级数据兼容 | 插件升级 = engine 目录整体替换；`.momo-codegraph` 由引擎 migrate 自管，异常时 `recreate` 语义兜底 |
