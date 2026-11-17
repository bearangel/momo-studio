# db-pro 数据库插件设计（MySQL / PostgreSQL / Oracle / 达梦）

- 日期：2026-11-17
- 状态：设计已批准（用户 2026-11-17 逐节确认 §1-§8），spec 待审阅
- 类型：新插件（momo-plugin 独立仓）+ 宿主侧一处 ctx 扩展
- 关联：`docs/specs/2026-10-15-plugin-system-design.md`（插件系统宿主设计）、`docs/specs/2026-11-03-momo-plugin-repo-design.md`（插件仓布局）、`docs/specs/2026-11-13-task-human-loop-lifecycle-design.md`（human_requests 底座）

## 1. 背景与目标

### 1.1 意图

为 momo-studio 提供 agent 可用的数据库查询能力，覆盖 MySQL、PostgreSQL、Oracle（12c+ thin 模式）、达梦 DM8 四种数据库。形态为 momo-studio 原生插件（非标准 MCP server）：**只读查询直接执行，写操作必须经人工批准**；按连接名管理多连接池。

### 1.2 需求裁定记录（用户逐项确认，2026-11-17）

| 裁定项 | 结论 |
|---|---|
| 产品形态 | momo-studio 原生插件（不要求兼容 Claude Code 等外部 MCP 宿主） |
| 读写边界 | 只读直接放行 + 写操作走人工批准（human_requests） |
| 连接模型 | 多连接池：按连接名配置，工具可指定 `connection` 参数 |
| 交付节奏 | v1 四库全上（不分期） |
| 技术路线 | 方案 B：统一插件工具 + 常驻 service + 自管引擎子进程（否决 A「MCP 子进程+插件工具双机制」与 C「扩展 preToolUse 挂起态」） |
| 测试环境 | 本机 OrbStack docker 起真库集成测试 |

### 1.3 调研结论（设计依据，2026-11-17 三线调研核实）

1. **无现成工具四库开箱即用**：dbhub（MIT，3.9k★，已支持 Oracle）缺达梦；db-tanxii-mcp（四库+达梦）为个人 npm 包、无源码仓库，供应链风险不可内置；SmartDB_MCP 达梦方言未随包分发；dbx 达梦走 JDBC agent 需 Java。
2. **Node 驱动四库全通且全纯 JS**（无 native binding / ABI 问题）：`mysql2`、`pg`、`oracledb`（thin 模式默认，12c+ 免 Instant Client）、`dmdb`（达梦官方 npm 包，已解包验证零 `.node` 文件，唯一依赖 iconv-lite）。
3. **dmdb 已知坑**：Node 18+ / OpenSSL 3 环境需 `--openssl-legacy-provider` 启动参数（达梦握手依赖 legacy cipher；lianekai/mcp-dm8-server 与 Mzaxd/dm8-mcp 两个独立项目均记录）；达梦 `EXPLAIN` 不返回结果集，计划文本在驱动 `lastExecInfo.explain` 字段。

## 2. 关键现状事实（宿主侧，已逐项核实）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 插件工具组件跑在 agent 子进程，`PluginToolCtx.callService(method, params, {timeoutMs})` 可回调主进程 service，桥超时默认 10s、钳制 [1s, 60s] | `electron/src/main/agent/tools/plugin-tools.ts:13-22` |
| 2 | 插件 service 组件主进程常驻，ctx = `{getConfig, getDataDir, workspace?, secrets(keytar), oauth, logger}`——**无 human-request 通道**（本设计的宿主扩展点） | `electron/src/main/plugin/service-manager.ts:133-152` |
| 3 | human_requests 底座通用：`kind ∈ {tool_gate, question, manual_action, acceptance}`，`timeoutPolicy` 五策略（含 keep_waiting），面板 UI + 超时 sweeper 现成；现有 tool_gate payload 是沙箱文件写专用形态（command + dirs + grantWriteDirs） | `electron/src/main/storage/tasks/human-requests-repo.ts`、`renderer/src/components/im/HumanRequestPanel.tsx` |
| 4 | 主进程能力经 ctx 注入而非插件直接 import 是既定模式（office-pro execSandboxed 先例） | `electron/src/main/agent/tools/types.ts:62-66` 注释 |
| 5 | 插件本体住独立仓 `../momo-plugin/plugins/<name>/`，dev 目录安装（`installPluginDevDir` 记绝对路径不拷贝）零宿主改动 | `docs/specs/2026-11-03-momo-plugin-repo-design.md` |
| 6 | 仓库内无任何用户侧数据库连接代码（绿地，无冲突面） | 全仓 grep 核实 |

## 3. 总体架构

```
../momo-plugin/plugins/db-pro/
├── momo-plugin.json                    # id: db-pro · components: tools + service + skills
│                                       # config schema（见 §4.3）
├── tools/index.js                      # 11 个 agent 工具（薄壳，全走 callService）
├── service/index.js                    # 主进程常驻 service（见 §4.2）
├── engine/
│   ├── engine.js                       # 引擎子进程入口：JSON-RPC stdio 主循环 + 连接池 + 只读校验
│   └── drivers/{mysql,pg,oracle,dm}.js # 四库驱动适配层（方言特化收敛于此）
├── skills/db-usage/SKILL.md            # agent 使用指引（探索→预览→查询 姿势）
├── package.json                        # deps: mysql2 / pg / oracledb / dmdb
└── node_modules/                       # gitignored 本机产物；分发 zip 时打入
```

### 3.1 进程拓扑

```
agent 子进程                    Electron 主进程                 引擎子进程
─────────────                  ───────────────                ─────────────
plugin:db-pro/* 工具  ──callService(≤60s)──▶  service/index.js  ──JSON-RPC stdio──▶  engine.js
                                        │   （常驻，连接池代理、
                                        │    写两段式状态机）
                                        │
                                        └──humanGate.create──▶ human_requests 表
                                                                   ↑ 人工请求面板（用户批准/拒绝）
```

- **工具命名空间**：`plugin:db-pro/<short>`，由宿主 loader 自动加前缀（插件只声明短名）。
- **service 是引擎进程的唯一父**：启动、健康监控（exit 自动重启，退避 1s/5s/30s 封顶）、优雅退出（app before-quit → stopPluginService → 引擎 SIGTERM）。
- **引擎与 MCP 基建无关**：不注册 mcp_definitions、不进 host-manager 池——插件自管。

### 3.2 引擎进程 Runtime 三级阶梯

`--openssl-legacy-provider` 必须在进程启动参数中（dmdb 握手需要）。Runtime 选择按阶梯逐级回退，**Spike #0（实施计划首任务）验证**：

1. **首选**：`spawn(process.execPath, ['--openssl-legacy-provider', engine.js], { env: { ELECTRON_RUN_AS_NODE: '1' } })`——零额外体积；风险点：Electron 内嵌 Node 的 OpenSSL 构建是否携带 legacy provider，须实测 dmdb 真连接。
2. **回退 A**：系统 node（探测 PATH，fileIo 模块探测先例）加同一 flag。
3. **回退 B**：vendor 自带 node 二进制（codegraph 插件 engine tarball 先例，压缩 ~25MB，manifest vendor 声明 + sha256）。

**连接串经 stdin 首次下发**（`engine.configure`），不进 argv（argv 可被 `ps` 观察）、不落盘。

## 4. 组件与职责

### 4.1 工具面（11 个，全在 tools/index.js 声明）

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_connections` | — | 已配置连接清单（名称/类型/可达性缓存，不露凭据） |
| `list_schemas` | `connection?` | schema 清单 |
| `list_tables` | `connection?, schema?` | 表清单 |
| `list_views` | `connection?, schema?` | 视图清单 |
| `describe_table` | `connection?, schema?, table` | 表概要（列/索引/行数估算） |
| `list_columns` | `connection?, schema?, table` | 全列明细 |
| `get_ddl` | `connection?, schema?, table` | 建表 DDL（MySQL `SHOW CREATE TABLE` / Oracle·达梦 `DBMS_METADATA` / PG catalog 拼装） |
| `query` | `connection?, sql, max_rows?` | **只读** SQL（引擎层白名单校验，见 §6.1） |
| `explain_query` | `connection?, sql, format?` | 执行计划（达梦走 `lastExecInfo.explain` 特化解析） |
| `write` | `connection, sql` | 创建写批准请求 → `{requestId, status:'pending'}`，**不执行** |
| `write_status` | `requestId` | 查批准状态；approved → 此刻执行并返回影响行数；denied → 返回拒绝（含用户附言）；pending → 如实告知 |

省略 `connection` 时用 `default_connection` 配置；工具描述中显式写明行为边界（防 LLM 误用）。

### 4.2 service/index.js（主进程）

`createService(ctx)` 返回 `{start, stop, handle}`：

- `start`：解析 config（keytar 取 sensitive 连接串）→ 按阶梯 spawn 引擎 → `engine.configure` 下发连接定义 → 健康监控启动。
- `stop`：SIGTERM 引擎、清理 in-flight。
- `handle(method, params)` RPC 面：`query / meta.* / explain / write / write_status / listConnections / reconfigure`。
  - 读路径：透传引擎（受 callService 60s 上限约束，引擎层自有 30s 查询超时，正常查询不触顶）。
  - `write`：`ctx.humanGate.create({kind:'tool_gate', title, payloadJson:{db:{connection, sql, opClass}}})` 落 human_requests → 返回 requestId。**service 不在调用内等待批准**（60s 上限与「人不在就等」语义冲突，两段式天然规避）。
  - `write_status`：`ctx.humanGate.status(requestId)` → pending 如实返回；approved → 引擎 `exec` 执行 → 返回结果（**幂等保护**：同一 requestId 至多执行一次，service 内存记录已执行集合 + 引擎执行前置校验）；denied/expired/cancelled → 对应人话结果。
  - `reconfigure`：config 热更新 → 对比连接定义 diff → 新增/变更的连接重建池，in-flight 请求用旧池跑完再关。
- 引擎崩溃：exit 检测 → 退避重启 → 重启后 `configure` 重放 → 已 pending 的写请求不受影响（批准状态在 human_requests 表，不在引擎内存）；`已执行集合` 随重启丢失的兜底：write_status 对 approved 且结果未知的 requestId 返回「引擎重启，批准仍在，请重查」而非重复执行（宁可让 agent 重发 write_status，不可重复执行写）。

### 4.3 config schema（设置页自动生成表单）

> **计划期修正（2026-11-17）**：宿主 config schema 为 manifest 静态声明（`ConfigPropertyDecl`，多收拒绝），不支持动态键。原设计 `connection__<NAME>` 动态键不可行，改为**固定槽位**：`conn1`–`conn6` 六槽，每槽 `url`（sensitive）+ 可选 `name`。槽位名即缺省连接名（如 `conn1`），`name` 覆盖显示名与工具参数引用名。v1.1 panel UI 可替换为自由增删的连接管理。

| 键 | 类型 | sensitive | 默认 | 说明 |
|---|---|---|---|---|
| `conn<n>_url`（n=1..6） | string | **是**（keytar） | 空 | 连接串：`mysql://` `postgres://` `oracle://` `dm://`，如 `dm://SYSDBA:***@host:5236/SYSDBA`；空槽跳过 |
| `conn<n>_name`（n=1..6） | string | 否 | `conn<n>` | 连接显示名 / 工具 `connection` 参数引用名（唯一性由 service 校验） |
| `default_connection` | string | 否 | 第一个非空槽 | 工具省略 connection 时使用 |
| `readonly_max_rows` | number | 否 | 200 | query 返回行数上限（超限截断 + 总数提示） |
| `query_timeout_ms` | number | 否 | 30000 | 引擎层单查询超时 |

连接串解析容错：非法 scheme / 缺口令等在 `list_connections` 与工具错误中人话报出。

### 4.4 engine/engine.js + drivers

- 协议：NDJSON JSON-RPC（`{id, method, params}` / `{id, result|error}`），method 面：`ping / configure / connTest / query / meta.listSchemas / meta.listTables / meta.listViews / meta.describe / meta.columns / meta.ddl / explain / exec`。
- 连接池：`Map<connectionName, DriverPool>`，各驱动自带池策略（mysql2/pg 用自带 pool；oracledb/dm 自实现简单池，上限可后续配置化）。
- **drivers/<dialect>.js** 统一接口：`connect(url) / close / query(sql, {timeoutMs, maxRows}) / 元数据方法 / explain(sql) / exec(sql)`。方言差异全部收敛于此：
  - `dm.js`：explain 读 `lastExecInfo.explain` 并解析为 `{text, operators[], summary}`；元数据走 Oracle 兼容目录（`ALL_TABLES` 系）。
  - `oracle.js`：thin 模式（`oracledb` 默认）；DDL 走 `DBMS_METADATA.GET_DDL`。**v1 不支持 11g**（thick 需分发 Instant Client，列 v1.1）。
  - `pg.js`：DDL 由 `pg_catalog` 拼装。
  - `mysql.js`：`SHOW CREATE TABLE`；`information_schema` 元数据。

## 5. 数据流

### 5.1 读链路

agent 调 `plugin:db-pro/query` → tools 薄壳 `callService('query', {...}, {timeoutMs: 60000})` → service 校验连接名 → 引擎 `query` → 只读校验器 → driver → 结果表格化（列宽自适应文本表 + 截断行提示 + 总行数）→ 逐层返回。

### 5.2 写两段式

```
① agent: write(connection, sql)
   service: opClass 判定（INSERT/UPDATE/DELETE/MERGE→DML；CREATE/DROP/ALTER/TRUNCATE→DDL；
            其他首词→拒绝「不支持的操作类型」）
   service: humanGate.create(kind='tool_gate',
             payloadJson={db:{connection, sql, opClass}})
   → {requestId, status:'pending'}   ← agent 不阻塞，可继续对话提醒用户

② 用户：人工请求面板看到 db 卡片（连接名 chip + SQL 块 + DML/DDL 标签）
   操作：允许本次 / 拒绝（无「允许本会话」——数据写不可逆，v1 宁繁勿漏）

③ agent: write_status(requestId)
   status=approved  → 引擎 exec → {affectedRows}（幂等：同 requestId 至多执行一次）
   status=denied    → 拒绝结果 + 用户附言（进入 agent 上下文）
   status=pending   → 如实告知等待中
```

### 5.3 配置链路

设置页 PluginSettings 表单（config schema 自动生成）→ config-store 落盘 + sensitive 进 keytar → service `reconfigure`（config 变更事件驱动 + 下次调用兜底比对）→ 连接池 diff 重建。

## 6. 安全模型

### 6.1 只读校验器（引擎层，纵深防御——不信任 LLM 遵守工具描述）

- 首词白名单：`SELECT / SHOW / DESCRIBE / DESC / EXPLAIN / WITH`（`WITH` 仅当主语句为 SELECT——CTE 后跟 SELECT 校验）
- 禁多语句：拒绝包含未转义分号的多语句（字符串/注释内分号按各自方言转义规则排除；v1 简化实现：strip 字符串与注释后检测分号）
- 拒锁子句：`FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE`
- 行数上限（默认 200）+ 查询超时（默认 30s，driver 层 kill）
- 校验失败错误信息包含违规原因与改正指引（引导走 write 工具）

### 6.2 写操作

- 全量 human-gate（每次写都批准，无会话级豁免）
- `exec` 仅接受 service 在批准后下发的调用——引擎协议不暴露给 agent（agent 的唯一入口是 write/write_status，exec 的触发权在 service 状态机）
- 审计：tool_calls 审计链自动覆盖（plugin source 标记 + 输入摘要脱敏——密码与超长 SQL 截断）

### 6.3 凭据

- 连接串整体 sensitive → keytar 存储；引擎内存持有；`list_connections` 只回名称/类型
- 日志全链路脱敏：URL 密码段替换 `***`

## 7. 宿主侧改动（momo-studio，唯一触碰面）

| # | 改动 | 文件 | 量级 |
|---|---|---|---|
| 1 | `PluginServiceCtx` 增加可选 `humanGate?: { create(input): Promise<string>; status(id): Promise<HumanRequestRow \| null> }`——service-manager 构造 ctx 时注入（走 human-requests-repo），按 execSandboxed 注入先例 | `electron/src/main/plugin/service-manager.ts`、`electron/src/main/plugin/types.ts` | ~60 行 + 注入测试 |
| 2 | `ToolGateBody` 增加 db payload 渲染分支：连接名 chip + SQL 块 + DML/DDL 标签；**不渲染**「允许本会话」按钮 | `renderer/src/components/im/HumanRequestPanel.tsx` | ~40 行 + 渲染测试 |
| 3 | tool_gate answer 路由：payload 为 db 形态时旁路 `grantWriteDirs`（沙箱文件语义不适用） | `electron/src/main/task/human-answer-shared.ts` 一带（具体接线以实施计划为准） | ~20 行 + 测试 |

**不改清单**：MCP 基建（client/host-manager/mcp_definitions）、spawn 链、hook-bus、资源库、WarmPool。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 引擎启动失败 | 工具返回「引擎未就绪 + 原因」；service 退避重启（1s/5s/30s 封顶） |
| 引擎崩溃（运行中） | exit 检测 → 重启 + configure 重放；进行中请求收到结构化错误（agent 可重试）；pending 写请求不受影响 |
| 连接失败 | 逐连接分类报错（网络不通 / 认证失败 / 库不存在），不回显密码 |
| 达梦握手加密失败 | 专用人话错误（提示 Runtime 阶梯命中级别，引导查 Spike 结论） |
| 三层超时 | callService 60s（桥上限）/ 引擎查询 30s（可配）/ human-gate 永不超时（keep_waiting + sweeper 兜底） |
| write 重复执行防护 | requestId 幂等执行 + 引擎重启后「批准仍在、结果未知」宁可重查不重执行 |

## 9. 测试策略

| 层 | 位置 | 内容 |
|---|---|---|
| 只读校验器单测 | momo-plugin 仓 | 白名单穷举：正例（SELECT/WITH-SELECT/SHOW/DESCRIBE/EXPLAIN）+ 负例（多语句、FOR UPDATE、注释藏分号、字符串藏分号、UPDATE 伪装、CTE 后跟 INSERT） |
| 引擎协议单测 | momo-plugin 仓 | JSON-RPC roundtrip、configure 幂等、connTest 超时分类 |
| driver 单测 | momo-plugin 仓 | 四 driver 以 mock 驱动接口测适配逻辑；达梦 explain 解析器用真实计划文本样本 |
| 写状态机单测 | momo-plugin 仓 | 两段式全转移：pending→approved（执行一次）/ denied / 引擎重启恢复 / write_status 幂等 |
| 宿主单测 | momo-studio 仓 | humanGate ctx 注入（mock repo）、ToolGateBody db 分支渲染、answer 路由旁路 grantWriteDirs |
| 真库集成 | 本机 OrbStack docker | `mysql:8` + `postgres:16` + 达梦官方 dm8 镜像 + `gvenzl/oracle-free`（23ai）；每库跑冒烟：建连接→元数据→query→write 批准全链 |

真库集成以 docker-compose 固化于 momo-plugin 仓 `tests/docker/`（口令仅测试值，镜像拉取与端口约定写入 README）；无 ARM 镜像的库以平台可用镜像等价替代并记录。

## 10. v1 范围与非目标

**做**：四库只读全工具面 + 写两段式人工批准 + 多连接池 + 配置表单 + skill 指引 + OrbStack 真库集成测试。

**非目标（v1.1+ 演进清单，按序）**：
- Oracle 11g thick 模式（需 Instant Client 分发方案）
- 结构比对（search_similar_tables / compare_schema / compare_table）
- SQL 方言翻译（MySQL → Oracle/达梦）
- 存储过程/函数调用
- panel 连接管理专属 UI（现 config 表单够用）
- 拆独立 MCP server 复用（引擎层已按协议无关设计，届时加壳即可）
- 会话级写批准豁免（等真实使用反馈再议）

## 11. 验证（完成的定义）

1. **momo-plugin 仓**：插件单测全绿；OrbStack 四库 docker 集成脚本全绿（连接→元数据→query→write 批准→write_status 执行）。
2. **momo-studio 仓**：`npx pnpm@9.0.0 typecheck` 通过；宿主改动面测试（humanGate 注入 / ToolGateBody db 分支 / answer 路由）全绿；全量 `vitest run` 无新增失败。
3. **dev 链手验**：dev 目录安装 `../momo-plugin/plugins/db-pro` → 设置页配置一条 mysql 连接 → 会话内 agent 完成「列表→查结构→只读查询」→ write 一条 UPDATE → 面板批准 → agent 拿到影响行数；再 write 一条 → 拒绝 → agent 收到拒绝理由。
4. **达梦真机**：OrbStack dm8 容器跑通同一套手验流程（验证 Runtime 阶梯 + openssl flag + explain 特化）。

## 12. 决策记录

- D1 形态 = momo-studio 原生插件（用户裁定）——MCP 标准面非资产，方案 B 单机制最统一
- D2 写批准 = 两段式（write → pending / write_status → 结果），不做 callService 内长等待（60s 桥上限与人工审批时长语义冲突）
- D3 引擎进程 = service 自管子进程（非 MCP、非 agent 子进程内嵌）——dmdb 的 openssl flag 只能经独立进程启动参数注入
- D4 Runtime 阶梯 = ELECTRON_RUN_AS_NODE → 系统 node → vendor node，Spike #0 首日定案
- D5 human-gate 复用 human_requests 底座（kind=tool_gate + db payload 新形态），宿主改动收敛为 ctx 注入 + 面板渲染分支 + answer 路由旁路
- D6 连接串整体作 sensitive 进 keytar（不做用户名/密码拆分——URL 形态与业界 MCP 惯例一致）
- D7 写幂等原则 = 宁可重查不可重执行（requestId 至多执行一次；引擎重启后结果未知时返回可重查状态）
- D8 v1 不支持 Oracle 11g（thin 模式 12c+ 为 v1 边界，thick 列非目标）
- D9 连接配置 = 固定槽位 conn1–conn6（计划期发现宿主 config schema 仅支持 manifest 静态声明键，动态键 `connection__<NAME>` 不可行；详见 §4.3 修正注）
- D10 只读校验终审收紧（全分支评审 C1/C2，2026-11-17）：select/with 的写关键词检测改 **stripped 全文**（非括号骨架——PG 数据修改 CTE `WITH del AS (DELETE…) SELECT` 可绕过骨架检测，实测实证）；DENY_CLAUSES 追加普通 **INTO** 全禁（PG `SELECT INTO` 建表通道；MySQL `INTO @var` 误杀可接受，R4）；**explain 路径前置 assertReadOnly**（PG `EXPLAIN ANALYZE` 会真实执行所附语句）；执行中断幂等补全（write-log 先落 `attempting`，中断后重查返回 `exec_unknown` 不重执行——D7 全量落地）

## 13. 风险与备注

- **R1 ELECTRON_RUN_AS_NODE 的 openssl legacy provider**：Electron 内嵌 Node 的 OpenSSL 构建可能不带 legacy provider——Spike #0 用 OrbStack dm8 容器首日实测；失败走阶梯回退，最坏 vendor node +25MB（codegraph 先例可接受）。
- **R2 dmdb 驱动维护**：官方 npm 包（dameng_database 账号，2026-07 仍在发版），闭源许可（npm 元数据标 Proprietary）——插件 zip 分发时随 node_modules 打入，许可面写入插件 README 备注。
- **R3 达梦 explain 样本依赖**：`lastExecInfo.explain` 解析器依赖真实计划文本格式——集成测试以 dm8 容器真实输出锁定样本。
- **R4 只读校验器的方言逃逸面**：注释/字符串内分号剥离的简化实现可能误杀极少合法 SQL（如字符串含分号的常量查询）——v1 接受误杀（错误信息引导改写），漏杀面由「首词白名单 + 禁多语句」双层兜底；发现逃逸样本即补穷举用例。
- **R5 60s 桥上限 vs 慢查询**：超大表 COUNT 等可能超 30s 引擎超时——行为是明确超时错误 + 引导加条件/分页，不是静默挂起；确有慢分析需求列 v1.1（异步查询 + 轮询，复用两段式模式）。
