# db-pro 业务成功判定与执行预检设计（C 期）

| 项目 | 内容 |
|---|---|
| 状态 | 已评审（2026-11-20，五节设计逐节确认） |
| 上游输入 | 《db工具使用实录与问题描述-完整版.md》（DAP-E 研发，2026-11-20）+ 样本数据包 db-tool-sample（01–05） |
| 前置设计 | `2026-11-19-db-pro-script-engine-and-connection-panel-design.md`（A/B 期） |
| 范围 | R1–R7 全量（C 方案）：业务成功判定、collation 对齐、dryrun 连库预检、逐条明细、一键核验、报错友好化 |
| 实施仓库 | momo-plugin（分支 `feat/db-pro-business-result`，自 main 切出） |

> **变更记录（2026-11-20 执行期裁定）**
> - **C10 · 层 2 scriptJudge 权威判定与面板「脚本判定」高级区取消**：层 1 通用输出捕获（[FAIL] 标记）已覆盖 P0 需求；后续问题按 agent 运行时记录反馈再评估。§4.2/§8.2/§8.3 相应内容未实施；判定链收敛为「语句失败 > 层 1 > ok」。
> - C11 · 检查 2 收窄为「未知列」；UK 预演支持多行 VALUES 逐元组（§6 已更新）。
> - C12 · inferTables 改逐模式 matchAll 全量收集（多表语句不漏表）。

---

## 1. 背景：一次生产种子脚本排障暴露的缺陷

2026-11-20 DAP-E 团队在 dev 库执行种子脚本 S00971511（注册 5 个 MCP 工具元数据），经历 4 轮「工具报成功 → 实际失败回滚」排障。核心事实：

- 脚本模板：`SET 会话变量 ×3` → `DROP PROCEDURE` → `CREATE PROCEDURE`（幂等检查 → 事务 → INSERT → 执行日志；`EXIT HANDLER` 回滚写日志）→ `CALL` → `DROP PROCEDURE`
- v1/v2/v3 三轮工具均回执「N/N 条语句成功」，但 `DAP_E_SCRIPT_EXECUTION_LOG` 里 `STATUS=0`（业务失败回滚）
- 三轮真实根因依次：唯一键冲突（90045）→ 被模板吞错缺陷掩盖（`[?] Unknown error`）→ collation 冲突（会话 `utf8mb4_unicode_ci` vs 表 `utf8mb4_0900_ai_ci`）
- v4（脚本手动加 `SET NAMES` + 修 handler 顺序）成功

### 1.1 代码级根因（已实证）

| 现象 | 根因 |
|---|---|
| 报成功实际失败 | `engine/drivers/mysql.js` session.exec 仅取 affectedRows，CALL 的结果集被丢弃（`Array.isArray(res) ? res.length` 甚至把结果集个数当影响行数）；EXIT HANDLER 吞异常后 CALL 正常返回 → 引擎只见「语句成功」 |
| 错误不可见 | handler 内 `SELECT '[FAIL] …'` 输出与执行日志 ERROR_MESSAGE 均未捕获 |
| collation 冲突 | `createPool` 未设 charset，mysql2 默认申报 `UTF8MB4_UNICODE_CI`（`mysql2/lib/connection_config.js:176`）；openSession 不做对齐。用户变量/过程变量挂会话 collation，与表列比较时 MySQL 拒绝混用 → `Illegal mix of collations` |
| dryrun 无感 | dryrun 纯静态（不连库），表存在性/列匹配/UK 冲突/collation 均不检查 |

## 2. 目标与非目标

**目标**（对应上游文档 R1–R7）：

| 编号 | 需求 | 严重度 |
|---|---|---|
| R1 | 回执区分「语句执行成功」与「业务执行成功」 | P0 |
| R2 | CALL 输出呈现 + 失败错误信息透传 | P0 |
| R3 | 会话自动对齐目标库 collation | P1 |
| R4 | dryrun 连库预检：表存在性/列匹配/UK 冲突预演/collation 一致性 | P1 |
| R5 | 逐条语句结果明细（状态/影响行数/输出/错误定位） | P2 |
| R6 | 执行后核验（涉及表增删行数摘要） | P2 |
| R7 | 连接不存在报错附可用连接列表 | P2 |

**非目标**：
- 不改脚本模板本身（handler 顺序缺陷归脚本维护方；工具只做 dryrun 警告）
- 不做「选择表人工圈定核验范围」的交互（核验自动取推断表，见 §7）
- R3 仅 MySQL（PG collation 建库即定，Oracle/DM 无此机制）
- 预检检查实现仅 MySQL 先行，其余方言显式提示「暂不支持预检」，不静默装作查过
- 不新增工具入口；全部能力并入 script_execute / script_status 既有回执

## 3. 现状：scriptRun 数据流（改动基线）

```
agent → script_execute(dryrun?) → service.submit
  ├─ dryrun=true → engine.scriptAnalyze（纯静态切分/分类/表推断）→ 直接回执
  └─ dryrun=false → humanGate 审批 → service.status 轮询
       → engine.scriptRun（专用连接 session 逐条 exec）
       → results[{idx,line,status,affectedRows,error}] + ok/total/executed
       → script-history.jsonl 落账
```

改动面：engine 结果协议加字段、mysql 驱动 session 语义、新增 scriptPrecheck 方法、service 落账与回执、tools 文案、面板高级区、connections.json 可选配置。

## 4. 设计 1（R1+R2）：业务成功判定——双层

### 4.1 层 1 · 通用输出捕获（必做，所有连接生效）

- session.exec 捕获每条语句结果集（有界：每语句前 50 行，单元格截断 200 字）
- `results[]` 每条携带 `outputs`（规范化为字符串矩阵 + columns）
- 扫描全部 outputs：任一单元格匹配失败标记（默认正则 `^\[FAIL\]`，连接级可覆盖，见 §8）→ `businessStatus: 'failed'`，命中行全文进入回执；否则 `'ok'`
- 语句全部成功且层 1 未命中 → `businessStatus: 'ok'`

### 4.2 层 2 · 权威执行日志判定（可选，连接级配置 scriptJudge）

- 连接配置可选对象 `scriptJudge`：`{ logTable, scriptNoColumn, statusColumn, errorColumn, okValue, failPattern, sortColumn }`（全字段语义见 §8；仅 `failPattern` 可独立出现，其余按 §8.2 校验规则生效）
- 脚本执行完成后（scriptRun 末尾，同会话）：`SELECT <statusColumn>, <errorColumn> FROM <logTable> WHERE <scriptNoColumn> = ? ORDER BY <sortColumn> DESC LIMIT 1`（脚本号取 splitter 提取的 scriptNo；未识别脚本号则跳过层 2）。排序依据：优先用 scriptJudge.sortColumn（§8.2 第七字段）；未配置则探测日志表自增主键（information_schema）；两者皆无 → 层 2 不可用并告警（不猜）
- 表内状态为**权威**业务结果：`status == okValue` → `businessStatus: 'ok'`；否则 `'failed'` 且 ERROR_MESSAGE 透传回执；层 1 降为参考（冲突时以层 2 为准并在回执注明）
- 查询失败（表不存在/权限）→ 层 2 降级为不可用告警，不阻断结果返回

### 4.3 判定优先级

```
语句失败（任一语句 failed / 脚本超时）
  > 层 1 失败标记（默认 ^\[FAIL\]）
  > ok
```

回执首行摘要统一形态：

```
语句 8/8 成功 · 业务结果：失败 —— [FAIL] S00971511 -- [23000] Duplicate entry '91022' ...
语句 8/8 成功 · 业务结果：成功（日志表 DAP_E_SCRIPT_EXECUTION_LOG 判定 STATUS=1）
```

`script_status`（done 态）与 `script_history` 条目均携带 `businessStatus` 与 `businessError`。

## 5. 设计 2（R3）：会话自动对齐 collation（仅 MySQL）

- `openSession()` 取得连接后：读 `@@collation_database` 与 `@@collation_connection`；不相等则 `SET NAMES <@@character_set_database> COLLATE <@@collation_database>`，再进入语句循环
- 对齐发生在首条语句前；脚本自带 `SET NAMES` 时后执行、自然覆盖（无冲突）
- 多轮往返成本：1 次额外查询（可合并为单条 `SELECT @@character_set_database, @@collation_database, @@collation_connection`），仅在不等时多发 1 条 SET NAMES

## 6. 设计 3（R4）：dryrun 连库预检

新增引擎方法 `scriptPrecheck(connection, script)`：走连接池、只读查询；dryrun 回执新增 `precheck` 块。**默认开启**；连接不可达 → 降级纯静态 + 顶层提示「预检跳过：连接不可达」（dryrun 仍可用）。

四项检查（基于 splitter 的语句分类与表推断）：

| # | 检查 | 实现 | 级别 |
|---|---|---|---|
| 1 | 表存在性 | 推断目标表查 information_schema；**顺序感知**（脚本内先前语句 CREATE 的表不算缺失） | warn |
| 2 | INSERT 列匹配 | INSERT 列清单 vs information_schema.COLUMNS：**未知列**（表中不存在/拼写错）逐条列出；表列未列入 INSERT 清单属默认值语义，不告警（修订 2026-11-20：原「缺列/多列」中「缺列」方向不成立，集成实证收窄） | warn |
| 3 | UK/PK 冲突预演 | 尽力而为：对每张 INSERT 目标表取其 PK/UK 列（information_schema），能从 INSERT VALUES（含存储过程体内、**多行 VALUES 逐元组**）提取出**全部** UK 列字面量者 → `SELECT COUNT(*) WHERE <各列字面量等值 AND>` 探测；任一 UK 列提取不出（变量/动态 SQL）该表静默跳过不误报 | high |
| 4 | collation 一致性 | 目标表 TABLE_COLLATION vs 库默认 collation，不一致告警并建议脚本显式 SET NAMES | warn |

- 全部产出为分级 warnings（info/warn/high），**dryrun 不阻断**（咨询性质；人工审批仍是硬门）
- 方言：MySQL 实现完整四项；PG/Oracle/DM 返回 `precheck: { supported: false, note: '该方言暂不支持预检' }`

**附带（上游问题 8 的工具侧提示）**：splitter 静态检测存储过程 handler 内 `ROLLBACK` 先于 `GET DIAGNOSTICS` → 静态 warnings 增加「模板缺陷：ROLLBACK 先于 GET DIAGNOSTICS 会清空诊断区吞错」（MySQL 语法启发式）。

## 7. 设计 4（R5+R6）：逐条明细 + 一键核验

### 7.1 R5 逐条明细

- `results[]` 升级：`{ idx, line, kind（set/drop/create/call/insert…）, status: 'ok'|'failed', affectedRows, outputs, error, durationMs }`
- **CALL 语义修正**：mysql2 对 CALL 返回多结果集数组——结果集捕获进 outputs；affectedRows 取尾部 OK 包（无则 0）；DML 取真实 affectedRows。废除「结果集个数当影响行数」
- `script_status` 回执 = 首行摘要 + 业务状态 + 逐条明细（失败定位「第 N 条 / 第 L 行」）+ verification；`script_history` 落账同步

### 7.2 R6 一键核验（自动并入 scriptRun，不新增工具）

- 执行**前**快照：对推断目标表（上限 20 张，逐表 5s 超时保护）`SELECT COUNT(*)`
- 执行**后**复测：同表再 COUNT
- 回执新增 `verification: [{ table, before, after, delta }]`，标注「参考值（并发写存在误差）」
- DDL 兼容：CREATE 的表 `before: null`；DROP/TRUNCATE 的表 `after: null`
- 层 2 已配置 → 权威日志行随 verification 一并呈现

## 8. 设计 5（R7 + 配套面）：报错、面板、数据、文案

### 8.1 R7 报错友好化

- 「未配置的连接 "dev_db"」→「未配置的连接 "dev_db"（当前可用：dev_mysql_db、pg_test）」；零连接 → 「当前无已配置连接——请到插件面板添加」
- `mustPool` 与 scriptRun 内两份手写重复报错收敛为一个 helper；query/write/script_execute 全部受益

### 8.2 面板：脚本判定高级区（**未实施——C10 取消**）

 数据：connections.json

- 连接对象新增可选 `scriptJudge`（上述六字段）；**非敏感明文**（连接串仍在 keytar）
- 旧数据无此字段 = 未配置 → 层 2 关闭、层 1 用默认正则；JSON 容缺省，**无需迁移脚本**

### 8.4 文案

- 工具描述（tools/index.js）：`script_execute` 补业务状态判定（输出标记 + 可选日志表权威判定）与 dryrun 预检说明；`script_status` 说明回执结构（摘要/业务状态/逐条明细/核验）
- README 新增「业务成功判定」与「执行预检」两节

## 9. 测试与验收

### 9.1 现场

docker MySQL 8（127.0.0.1:13306）建 `db_tool_sample` 库，执行样本包 `01_schema_ddl.sql` + `02_sample_data.sql`（MySQL 8 默认 collation 恰为 `utf8mb4_0900_ai_ci`）；连接 URL 不带 charset → 会话 `unicode_ci`，collation 冲突天然可复现。

### 9.2 单测（vitest，tests/db-pro/）

- splitter：handler「ROLLBACK 先于 GET DIAGNOSTICS」警告检测（正序通过/反序告警/无 handler 不误报）
- mysql session：CALL 多结果集捕获 / affectedRows 语义修正（mock conn.query 返回 `[rows, okPacket]` 形态）
- 失败标记扫描 businessStatus 判定（层 1 命中/未命中/自定义正则）
- 层 2 scriptJudge 权威判定（mock：成功值/失败值/查询异常降级/字段不完整视为未配置）
- 判定优先级（语句失败 > 层 2 > 层 1）
- R7 helper 文案（含可用列表/零连接分支）
- collation 对齐决策（相等不动/不等 SET NAMES）

### 9.3 集成（DBPRO_INTEGRATION=1，样本包真脚本）

| 用例 | 脚本 | 验收 |
|---|---|---|
| 基线 | 03_S00971511_v4_success | `businessStatus: ok`、verification 三表 delta 3/5/5、日志表 STATUS=1 |
| P0 复现 | 04_reproduce_uk_conflict | `businessStatus: failed`、`[FAIL]…[23000]` 透传回执、delta 全 0 |
| 吞错 | 05_reproduce_error_swallowed | `businessStatus: failed`、`[?] Unknown error` 透传、dryrun 报 handler 顺序警告 |
| R3 实证 | 05（无 SET NAMES） | collation 自动对齐，varchar 比较不再报 Illegal mix of collations |
| R4 预演 | 04 dryrun | 报 UK 冲突 high warning（91022 与已存在记录冲突） |
| R4 列匹配 | 改列名脚本（测试内构造） | 报缺列/多列 warning |
| R7 | 旧连接名调用 | 报错附可用连接列表 |

### 9.4 回归与真机

- 现有 190 单测 + 30 集成保持全绿（affectedRows 语义修正处如实同步旧断言）
- 真机验收（momo-acceptance 流程）：面板「脚本判定」高级区配置截图 + 04 场景失败回执截图 → `.omo/qa-reports/` 报告
- **验收基准 = 上游文档 R1–R7 验收标准逐条对勾**：

| 编号 | 验收标准（原文） | 对应用例 |
|---|---|---|
| R1 | 脚本内回滚失败时，回执出现失败状态与错误信息，而非「N/N 成功」 | 集成 04 |
| R2 | 排障不再需要人工查执行日志表才能看到错误 | 集成 04/05 |
| R3 | dev 库执行含 varchar 比较的存储过程不报 Illegal mix of collations | 集成 05 |
| R4 | 对本次 v2 脚本 dryrun 即可报「91022 与已存在记录冲突」 | 集成 04 dryrun |
| R5 | 回执含逐条明细 | 全部 |
| R6 | 执行完成后回执附「表名×写入行数」 | 集成 03 |
| R7 | 误用旧连接名时提示当前可用连接 | 集成 R7 |

## 10. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| C1 | 业务判定走「层 1 通用输出捕获 + 层 2 可配置日志表」双层，不做 DAP-E 表名硬编码 | 通用性；上游文档建议 a/b 并采 |
| C2 | 判定优先级：语句失败 > 层 2 > 层 1 | 权威来源分层 |
| C3 | R3 仅 MySQL，对齐目标为 `@@collation_database` | 问题为 MySQL 特有；上游 v4 手动方案即对齐库默认 |
| C4 | dryrun 预检默认开启、不可达降级纯静态、产出分级 warnings 不阻断 | 咨询性质定位；审批仍是硬门 |
| C5 | UK 冲突预演仅对可提取字面量者生效，提取不出静默跳过 | 不误报优先 |
| C6 | R6 用执行前后 COUNT 快照（非主键范围圈定），自动取推断表 | 免交互、覆盖 DROP/TRUNCATE |
| C7 | R5/R6 并入既有回执，不新增工具入口 | 消费面最小 |
| C8 | scriptJudge 非敏感明文存 connections.json，无需迁移 | JSON 容缺省 |
| C9 | affectedRows 语义修正可能改变旧断言——如实同步，不保留失真语义兼容 | 正确性优先 |
| C10 | 层 2 scriptJudge + 面板高级区取消（执行期用户裁定） | 层 1 已覆盖 P0；减少配置面 |
| C11 | 预检列匹配只报未知列（表列缺省属默认值语义）；UK 预演逐元组 | 集成实证修正 |
| C12 | inferTables matchAll 全量收集 | 多表语句核验/预检依赖 |

## 11. 风险与边界

- **层 1 误报**：非 DAP-E 脚本输出恰含 `[FAIL]` 前缀 → 可经连接级 failPattern 覆盖为不匹配的正则（如 `(?!)`）
- **层 2 排序**：日志表无自增主键/时间列时「最新一条」依赖等价物；表结构不含可排序列 → 层 2 视为不可用并告警（不猜）
- **核验计数语义**：UPDATE 不改行数、并发写有误差 → 回执明示「参考值」
- **预检超时**：逐检查设查询超时，预检总时长上限 30s，超时项标记 `skipped`
- **脚本号未识别**：层 2 跳过（无 WHERE 锚点），仅层 1 生效
