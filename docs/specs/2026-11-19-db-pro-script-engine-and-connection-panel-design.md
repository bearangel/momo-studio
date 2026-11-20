# db-pro 通用脚本执行引擎与连接管理面板设计（v1）

| 项目 | 内容 |
|---|---|
| 状态 | 待评审 |
| 日期 | 2026-11-19 |
| 上游需求 | 桌面文档《db工具脚本执行能力问题说明与优化需求.md》（DAP-E 研发，2026-11-19）+ 产品侧连接面板诉求 |
| 涉及仓库 | `momo-plugin`（db-pro 插件本体）、`momo-studio`（仅回归验证，零代码改动） |
| 分期 | A 期：通用脚本执行引擎 → B 期：连接面板 + 权限矩阵 |

---

## 1. 背景与问题

### 1.1 脚本执行能力缺口（DAP-E 文档）

db-pro 当前是「交互式单语句数据库浏览器」：query 通道只读白名单 + 拒分号多语句；write 通道仅单条 DML/DDL。DAP-E 全部种子脚本采用统一模板（`DELIMITER //` + 存储过程 + 会话变量 `@__script_no` + 事务 + 幂等跳过 + 执行留痕），逐项撞墙，S00971511.sql 无法执行，业务被迫回退人工命令行。

### 1.2 配置体验问题（产品侧）

连接配置以 15 个 manifest 配置键挤在插件设置页（conn1–6 × url/name + default_connection + 两个行为参数），6 槽位硬编码、无描述、无权限控制、无测试连接。产品原则：

> Studio 插件设置页只放**插件级、业务无关**的配置；业务数据（数据库连接）由**插件自带面板**管理。

### 1.3 现状基建盘点（本轮探索结论）

- **宿主面板基建已存在且在产**：`PanelHost`（沙箱 iframe，`momo-plugin://` 协议锚定，`sandbox="allow-scripts"`）+ `PanelChannel`（ready / getContext / subscribe / callService / pickDirectory 五消息协议，origin 校验 + 限流三振）+ `panel.json` 声明（`sidebar` / `page` 两种挂载位）。email（636 行单文件 vanilla JS，侧栏+表单+RPC）与 codegraph 插件均有面板在跑——**B 期照此先例补面板即可，零宿主改动**。
- **插件 human-gate 已注入**：`PluginHumanGate.create({sessionId, taskId, title, prompt, payloadJson})` 落 `kind=tool_gate` 行、`timeoutPolicy` 缺省 `keep_waiting`；db 写门载荷 `{db:{connection,sql,opClass}}` 已被宿主审批卡渲染；service 以轮询 `status(id)` 消费答复（write-state 模式）。
- **db-pro 现状模块**：`service/index.js`(249) / `service/write-state.js`(100) / `engine/engine.js`(100) / `engine/sql-validator.js`(131) / `tools/index.js`(218)——小而清晰，适合增量扩展。

---

## 2. 需求映射与验收锚点

| 文档条目 | 本设计落点 | 验收 |
|---|---|---|
| P0-1 多语句脚本逐条执行 + 失败策略 | §5.3 执行器 | S00971511.sql 完整执行 |
| P0-2 DELIMITER 解析 | §5.2 MySQL profile | 过程体不被分号截断 |
| P0-3 存储过程 CREATE/DROP/CALL | §5.2 + §5.3 | 过程创建并调用成功 |
| P0-4 会话变量保持 | §5.3 专用连接 | `@__*` 变量过程体内可用 |
| P0-5 逐条结果与错误定位 | §5.3 结果形状 | 失败可定位到条/行 |
| P1-6 幂等跳过 | **归脚本自带**（D3） | 真实脚本二次执行整体 SKIP |
| P1-7 执行留痕 | 归脚本自带 + §5.5 工具审计 | 脚本 log 表有记录 + 工具历史可查 |
| P1-8 可追溯（谁/何时/哪库/哪脚本/结果） | §5.5 执行历史 | `script_history` 可查 |
| P2-9 脚本级人工批准 + 摘要 | §5.4 | 批准卡展示分类计数/表/风险 |
| P2-10 dry-run 预检 | §5.4 `dryrun:true` | 静态分析输出正确 |
| P2-11 文件上传 | agent 读文件传内容即等效；人肉上传入口归 B 期面板可选页签 | — |
| 产品侧连接面板 | §6 全篇 | 面板建连 → 工具全链路 |

**最终验收标准（A 期）**：S00971511.sql 在 dev 库（MySQL 8.0.16）经 `script_execute` 完整执行成功；原样二次执行由脚本自身幂等逻辑整体 SKIP；四库集成脚本（每库一个端到端样例）全部通过。

---

## 3. 设计原则

1. **通用引擎，不与任何业务系统绑定**——幂等/留痕语义单源在脚本自己；工具只提供引擎中立的静态分析与执行历史（不硬编码任何业务表名）。
2. **设置页只放插件级参数；业务数据走插件面板 + service 自有存储**（本 spec 同时作为插件开发 convention）。
3. **复用既有骨架**：db-engine 子进程 / human-gate / PanelHost+PanelChannel / write-state 轮询模式，不另起炉灶。
4. **零外部依赖**：纯 JS 驱动 + 内建切分器，拒绝外部 CLI（mysql/psql/sqlplus/disql）包装。
5. **A 期与 B 期均零宿主代码改动**（仅回归验证）。

---

## 4. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 引擎内建解释执行器：客户端预处理器 + 逐条顺序执行 | DELIMITER 非 SQL，驱动 multiStatements 无法承载；逐条反馈与定位可控；零外部依赖 |
| D2 | 四库一次到位（MySQL / PostgreSQL / Oracle / DM8 各一 profile） | 用户裁定一步到位做通用引擎 |
| D3 | 幂等/留痕归脚本自带；工具只做通用审计 | 避免硬编码业务表、避免与脚本逻辑双判打架（YAGNI） |
| D4 | 脚本级单门审批（整脚本一扇门），含 dry-run 摘要；审批摘要与 dry-run 同源 | P2-9/P2-10；避免逐条审批不可用 |
| D5 | 不强制外层事务 | MySQL DDL 隐式提交导致外包裹语义错误；事务边界由脚本自管 |
| D6 | 专用连接独占整脚本 | 会话变量/SET/USE/临时表跨语句保持的唯一可靠方式 |
| D7 | 失败策略 `abort` 缺省、`continue` 可选 | 缺省最安全；continue 采集全部错误 |
| D8 | 脚本通道无语句白名单 | 安全性由整门审批 + 权限位承载；白名单只管交互式 query 通道 |
| D9 | 连接 = service 自有动态列表（全局作用域），URL 明文只进 keytar | 连接是机器级环境资产，跨工作空间复用；面板只见非敏感投影 |
| D10 | 迁移保等效：旧 conn1–6 导入为全权限位 | 旧模型语义即「全放行 + 人工门」，静默降权会破坏既有工作流 |
| D11 | 8 权限位 + 预设档 + 双闸语义（配置态权限闸 + 运行态审批闸） | 权限简洁可懂，层层独立 |
| D12 | manifest 设置页只保留 `readonly_max_rows` / `query_timeout_ms` / `script_timeout_ms` | 产品原则落地 |
| D13 | 脚本执行走**后台作业 + `script_status` 轮询**（单次调用不阻塞） | 60s 桥上限与 10 分钟脚本时长冲突；与 write/write_status 同款两工具模式 |
| D14 | **无缺省连接概念**：所有库操作工具 `connection` 必填；连接名 + 描述即用途标识（供 agent 判断操作对象） | 用户裁定：agent 必须明确它操作的是哪个库；隐式回落易误操作 |

---

## 5. A 期：通用脚本执行引擎

### 5.1 架构与数据流

新增 1 个引擎模块 + 1 个 service 编排模块 + 2 个工具；其余全部复用。

```
agent 调 tool: script_execute({connection, script, on_error:'abort'|'continue', dryrun?})
  → service.scriptSubmit：
      ① engine.script_analyze(script, dialect)          ← 切分器静态分析（不连库）
      ② dryrun=true → 直接返回分析结果（不审批不执行）
      ③ humanGate.create（脚本级单门）：
           title  =「脚本执行：<scriptNo|未识别> · <connection> · <N> 语句」
           prompt = 分类计数 + 目标表清单(推断) + 风险标记 + 头部预览
           payloadJson = {db:{kind:'script', connection, sql, opClass:'script',
                              script, on_error, summary}}   ← 两段式取回执行参数（同 write 门惯例）
              · sql    = 头部预览（≤20 行，供宿主审批卡渲染）
              · script = 脚本全文（两段式取回执行用，卡片不展示）
      ④ 工具立即返回 {requestId, status:'pending'}；agent 用 script_status 轮询
         （write/write_status 同款两工具模式，避开 60s 桥上限——D13）
      ⑤ script_status 见 approve → 启动**后台作业** engine.scriptRun（不阻塞本次轮询返回）
         deny → denied；expired → expired；作业进行中 → running
      ⑥ 作业完成：结果缓存 + 执行历史落账（§5.5）
      ⑦ script_status 返回聚合结果（§5.3 结果形状）
```

- 切分器运行于 **db-engine 子进程**（SQL 语言知识与校验器同域；service 保持薄编排）
- query / write / script 三通道并存，互不改既有语义

### 5.2 通用切分器（`engine/script-splitter.js`）

两层结构：**引擎中立 tokenizer** + **每库 profile**。

**tokenizer 状态机**（中立层）：默认态 / 单引号（`''` 转义）/ 双引号 / 反引号（MySQL）/ 行注释（`--`；MySQL 另支持 `#`）/ 块注释（`/* */`）/ PG 美元引用（`$tag$…$tag$`，标签大小写敏感）。
产物：语句段 `{idx, startLine, text, keyword}` 序列 + 解析错误（不闭合引号/注释/$$ → 带行号报错，不连库）。

**每库 profile**：

| 库 | 终结符规则 | 客户端指令处置 |
|---|---|---|
| MySQL | 缺省 `;`；`DELIMITER <tok>` 行切换终结符直至下个 `DELIMITER`（行首、大小写不敏感、本身不执行） | `DELIMITER` 消费；`USE db` 作为语句透传 |
| PostgreSQL | 缺省 `;`；`$$` 块内不切分（tokenizer 层已解决） | 反斜杠元命令（行首 `\`）**拒绝**并提示内联 |
| Oracle | `;` 仅在 **PL/SQL 深度=0** 时终结（深度跟踪 `BEGIN/IF/LOOP/CASE` 开、`END/END IF/END LOOP/END CASE` 闭）；独立成行 `/` 亦终结 | **过滤+warning**：`SET`/`PROMPT`/`SHOW`/`CLEAR`/`DEFINE`/`UNDEFINE`/`SPOOL`；**拒绝**（控制流语义不模拟）：`EXIT`/`QUIT`/`WHENEVER`/`HOST`/`!`/`@file`/`@@`/`START`；`EXEC <expr>` → 自动包装为 `BEGIN <expr>; END;` |
| DM8 | 同 Oracle profile（Oracle 兼容） | 同上 |

**语句分类器**（复用切分产物，供审批摘要 / dry-run / 权限比对）：

| 分类 | 覆盖关键字 |
|---|---|
| read | SELECT / SHOW / DESC / EXPLAIN / WITH |
| insert / update / delete | INSERT / UPDATE / DELETE（MERGE 记三合一标记） |
| ddl_table | CREATE / DROP / ALTER / TRUNCATE **TABLE** |
| ddl_other | VIEW / INDEX / SEQUENCE / TRIGGER 的 CREATE / DROP / ALTER |
| procedure | PROCEDURE / FUNCTION / PACKAGE 的 CREATE / DROP / ALTER；CALL |
| session | SET / USE |
| txn | START TRANSACTION / BEGIN TRANSACTION / COMMIT / ROLLBACK / SAVEPOINT |
| block | 匿名 `BEGIN … END` 块 / `DECLARE` 块 |
| priv | GRANT / REVOKE（**恒拒绝**，DBA 域） |

**目标表推断**（正则级启发式，审批卡标注「推断」）：`INSERT INTO t` / `UPDATE t` / `DELETE FROM t` / `MERGE INTO t` / `CREATE|DROP|ALTER|TRUNCATE TABLE t` / `CREATE INDEX … ON t` 等。

**脚本号解析**（通用审计用）：从头部 `SET @__script_no = '<值>'` 或注释行启发式提取；**仅作展示与历史索引，不参与执行语义**（D3）。

### 5.3 执行器语义

- **专用连接**：从该 connection 池取一条连接**独占至脚本结束**；期间普通 query 走池内其余连接
- **不强制外层事务**（D5）：脚本内 `START TRANSACTION`/`COMMIT`/`ROLLBACK` 原样执行
- **失败策略**：`abort`（缺省）失败即停，返回已完成部分 + 失败定位；`continue` 采集全部错误跑完（自管事务脚本不建议）
- **超时**：每语句沿用 `query_timeout_ms`（缺省 30s）；整脚本上限 `script_timeout_ms`（缺省 600000ms），超时中止并尽力返回已完成部分
- **结果形状**：
  - 成功：`{ok:true, scriptNo, connection, total, executed, results:[{idx, line, status:'ok', affectedRows}], durationMs}`
  - 部分失败：`{ok:false, failedAtIndex, error:{code, message, line}, results:[…已执行…], durationMs}`
  - 被拒：`{ok:false, denied:true | expired:true, reason}`
  - dry-run：`{ok:true, dryrun:true, statements:[{idx, line, keyword, class, tables}], summary, warnings}`
- 脚本内 SELECT 只回**行数**不回数据（读数据走 query 通道）
- **规模护栏**：脚本 ≤ 2MB、语句 ≤ 10000 条，超限拒绝并提示拆分
- **工具层超时衔接**：宿主工具调用自身的超时上限为计划期验证项（§8-V1）

### 5.4 审批与 dry-run

- **脚本级单门**（D4）：整脚本一道 `humanGate.create`；approve = 全脚本授权；payload 兼容宿主现有 `parseDbGate` 形状（`sql` 字段承载头部预览获得既有渲染，`opClass:'script'`，全文在 `script` 字段）——**A 期零宿主改动**
- **审批卡内容**（title + prompt 文本承载）：脚本号 / 语句总数 / 分类计数（如 `DDL×3 · DML×18 · SET×3 · proc×2`）/ 目标表清单（推断）/ 风险标记（DROP/TRUNCATE 醒目）/ 脚本头部预览（前 20 行，超出以「…」截断）
- **dry-run**：`dryrun:true` → 只跑 `script_analyze`，不连库不审批；与审批摘要同源（一个分析器）
- **deny / expired**：人话工具结果返回，不 throw（同 write 门惯例）

### 5.5 执行历史审计（通用）

- 存储：插件数据目录 `data/script-history.jsonl`，追加式；条目：
  `{id, ts, sessionId, taskId, connection, scriptNo?, statementCount, on_error, result:'ok'|'failed'|'denied'|'expired', failedAtIndex?, errorSummary?, durationMs, tables[]}`
- 轮转：90 天 / 5MB 双阈值，先到先截断（保留最近）
- 查询面：工具 `script_history({connection?, limit?})`
- **历史是参考不是门**：不阻塞重复执行（幂等语义单源在脚本自己，D3）

### 5.6 工具面

| 工具 | 参数 | 说明 |
|---|---|---|
| `plugin:db-pro/script_execute` | `{connection, script, on_error?, dryrun?}` | connection 必填；dryrun 走纯分析 |
| `plugin:db-pro/script_status` | `{requestId}` | 轮询审批/执行状态：`pending` / `denied` / `running` / `executed` / `exec_unknown` / `not_found` |
| `plugin:db-pro/script_history` | `{connection?, limit?}` | 最近执行记录 |

工具描述文案须明确：通用脚本执行通道；幂等由脚本自己保证；执行前请用 dryrun 自检。

### 5.7 错误处理

| 阶段 | 场景 | 行为 |
|---|---|---|
| 切分 | 引号/`$$`/块注释/`;;` 未闭合 | 带行号解析错误，不连库 |
| 切分 | 拒绝类指令（`@file`/`EXIT`/`WHENEVER`/PG `\`） | 明确文案说明原因与替代（内联全文） |
| 切分 | 空脚本 / 纯注释 / 纯过滤指令 | 「0 条语句」明确结果 |
| 执行 | 单条语句失败 | abort 即停定位；continue 采集 |
| 执行 | 连接失败 | 整体 fail，历史记 failed |
| 执行 | 整脚本超时 | 中止 + 已完成部分 + 历史记 failed |
| 审批 | deny / expired / 超时策略 | 人话返回 |
| 引擎 | 子进程崩溃 | 走既有 spawn-diag 复活链路，返回引擎错误 |

### 5.8 A 期测试矩阵

| 层 | 内容 |
|---|---|
| 切分器单测 | 四库金样本；真实 S00971511 形态模板（DELIMITER+过程+事务+@变量）；Oracle 嵌套 IF/LOOP 深度边界；`EXEC` 包装；指令过滤/拒绝；不闭合错误 |
| 分类器单测 | 8 分类判定 + 表推断 |
| engine 集成（`DBPRO_INTEGRATION=1` 四库 docker） | 每库端到端：建过程 → 会话变量 → 事务 → **二次执行幂等 SKIP** |
| service 单测 | 审批轮询 / deny / expired / dryrun / 历史落账（仿 write-state 模式） |
| 宿主回归 | 审批卡对 script 载荷的兼容渲染（A 期不改宿主） |

---

## 6. B 期：连接面板与权限矩阵

### 6.1 连接模型与存储

- 元数据：插件数据目录 `data/connections.json` → `[{id, name, description, permissions[], created_at, updated_at}]`（**无缺省字段**，D14）
- 密钥：URL 明文（含密码）只进 **keytar**（`db-pro.conn.<id>`）；面板与工具只见非敏感投影（scheme/host/port/database 结构化回显，user 半掩码，password 恒不回显）
- id 服务端生成（`conn_` 前缀）；无人为数量上限
- **作用域**：连接是机器级环境资产，**全局层存储**，不随工作空间分层（§8-V3 验证数据目录 API）

### 6.2 迁移（一次性、幂等、保等效）

- 触发：service 启动时 `connections.json` 不存在 **且** 旧 `conn1–6_url` 有值
- 动作：导入为面板连接（name 沿用 `connN_name` 或缺省）；`permissions` = 全量 8 位（D10）；`default_connection` **不迁移**（D14 取消缺省概念）；keytar 写新键删旧键（杜绝双源）
- 迁移完成后 manifest 删除 13 个连接键（§8-V2 决定过渡是否需要一版隐藏只读键）

### 6.3 面板（`panel/` 单文件 vanilla JS）

- `panel.json`：`{id:'connections', title:'数据库', icon:'lucide:database', location:'page', entry:'./index.html'}`
- 布局：
  - **左栏**：连接列表（名称 / 引擎图标 / 权限徽标「只读·读写·全权」，hover 显示「名称 — 描述」）+「新增连接」；项操作：编辑 / 删除（模态确认）/ 测试连接
  - **右栏**：编辑表单——名称（必填唯一）/ 描述 / 连接 URL（sensitive 占位「已配置·点击更换」，不回显）/ 引擎按 scheme 自动识别（mysql/postgres/oracle/dm）/ 权限区（预设档 radio + 细粒度 checkbox 组，手动改动自动跳「自定义」）/ 测试连接（返回版本+延迟）/ 保存·取消
- 输入态 URL 明文仅存在于用户输入中的插件 iframe 内；保存后不回显
- 主题跟随宿主（PanelChannel ready 回包 tokens）
- **RPC 面**：service 新增 `connections.list / create / update / delete / setDefault / test`；list 只回非敏感投影

### 6.4 权限矩阵与 enforcement

| 权限位 | 覆盖 |
|---|---|
| `query` | SELECT/SHOW/DESC/EXPLAIN/WITH（含结构读） |
| `insert` / `update` / `delete` | DML 三项（MERGE 需三项齐） |
| `ddl_table` | CREATE/DROP/ALTER/TRUNCATE **TABLE** |
| `ddl_other` | VIEW / INDEX / SEQUENCE / TRIGGER |
| `procedure` | CREATE/DROP/ALTER PROCEDURE/FUNCTION/PACKAGE + CALL；匿名块 |
| `script` | 脚本执行通道（script_execute 本体） |

- 不做：GRANT/REVOKE/CREATE USER（DBA 域，遇到即拒并说明）
- 预设档：只读 `{query}` / 读写 `{query,insert,update,delete}` / 全权 = 全部 8 位 / 自定义
- **双闸**：权限位 = 配置态闸（不符直接拒，人话说明）；人工批准 = 运行态闸（权限过了照样两段式）
- **script 通道逐条核权**：`script_analyze` 分类清单与权限位比对，缺位在审批前即拒（「语句 5 需要 ddl_table 权限」）；审批卡展示权限符合性
- enforcement 落点：权限 profile 随连接下发 engine；`sql-validator` 从「硬编码只读白名单」升级为「按位判定」（query 通道按 query 位；write 通道按分类映射位）

### 6.5 配置面清理

- manifest 只保留：`readonly_max_rows`（行数上限，缺省 200）/ `query_timeout_ms`（缺省 30000）/ `script_timeout_ms`（缺省 600000）
- 删除：conn1–6_url、conn1–6_name、default_connection（13 键）
- convention 写入 spec：插件设置页 = 插件级业务无关参数；业务数据 = 插件面板 + service 自有存储

### 6.6 B 期测试

- 迁移单测：保等效 / 幂等二跑 / 空态 / 坏值容错
- 权限 enforcement 单测：3 通道 × 8 位矩阵；script 逐条缺位拒
- service 单测：connections CRUD / 测试连接 / 密钥不外泄（投影断言）
- E2E：面板建连 → agent query / write / script 全链路
- 面板 UI 按仓库预览门禁（`momo-ui-preview-rules`：P1 新页面，实现前静态预览确认，事后截图验收）

---

## 7. 分期与交付

### Phase A（先行）
引擎模块 + service 编排 + 两工具 + 历史审计 + 测试；验收 = §2 锚点。
A 期尚无逐连接权限位（B 期落地）——script_execute 对任一已配置连接可用，安全由脚本级人工批准门承载；query/write 通道语义不变。

### Phase B（随后）
连接存储与迁移 + 面板 + 权限矩阵 + 配置面清理；验收 = §6.6。

依赖关系：B 不阻塞 A（A 在现有人工批准门下运行）；A 的 `script` 权限位在 B 落地时并入矩阵，无返工。

---

## 8. 风险与待验证项（计划期第一批任务）

| # | 验证项 | 影响 | 预案 |
|---|---|---|---|
| V1 | 宿主工具调用超时上限（60s 桥） | 长脚本可能被截断 | 已由 D13 后台作业消解（script_status 恒为短轮询）；仍需验证 engine 侧 rpc 长超时生效 |
| V2 | ~~宿主 config-store 对已删 schema 键的旧值可读性~~ **已核实（2026-11-19）：`ctx.getConfig()` 返回原始 JSON + 敏感 overlay，不按 schema 过滤——删键后旧值仍可读** | 迁移可安全进行 | 无需预案 |
| V3 | ~~service ctx 数据目录是否提供全局层~~ **已核实：`resolvePluginDataDir` 为全局 `pluginsDir/data/<id>`** | 连接可全局存储 | — |
| V4 | Oracle/DM PL/SQL 深度识别边缘（嵌套 `CASE` 表达式 vs `END CASE` 语句、字符串内关键字） | 误切分 | 关键字深度仅在本语句已进入块上下文后计数 + tokenizer 保护字符串/注释；真实脚本样例回归 |
| V5 | 审批卡对大脚本 prompt 的渲染与截断 | 卡片过长 | 摘要 + 头部 20 行预览，全文仅在 payloadJson |
| V6 | 大脚本（2MB 级）时 human-gate payloadJson 体积 | SQLite 行体积 | 护栏 2MB；必要时 payload 存文件引用 + 摘要 |

---

## 9. 预计改动面

**momo-plugin / plugins/db-pro**（主体）：

| 文件 | 变更 |
|---|---|
| `momo-plugin.json` | config 面瘦身（B 期）+ script_timeout_ms（A 期） |
| `tools/index.js` | 新增 `script_execute` / `script_history` 工具声明与转发 |
| `service/index.js` | 新增 `scriptSubmit` 编排；B 期 `connections.*` RPC |
| `service/script-state.js`（新） | 审批轮询 + 历史落账（仿 `write-state.js`） |
| `service/connections-store.js`（新，B 期） | 连接 CRUD + keytar + 迁移 |
| `engine/script-splitter.js`（新） | tokenizer + 四库 profile + 分类器 + 表推断 |
| `engine/engine.js` | 新增 `script_analyze` / `script_execute` op |
| `engine/sql-validator.js` | B 期升级为按位判定 |
| `engine/protocol.js` | 新 op 入参/回包 |
| `panel/panel.json` + `panel/index.html`（新，B 期） | 连接管理面板 |
| `tests/db-pro/*`（新） | §5.8 / §6.6 矩阵 |

**momo-studio**：零代码改动（宿主回归验证：审批卡渲染、面板加载、callService 路由）。

---

## 10. 明确不做（YAGNI）

- 工具级幂等预检 / 业务日志表硬编码（D3）
- 驱动 multiStatements 一把执行 / 外部 CLI 包装（D1）
- GRANT/REVOKE/CREATE USER 等 DBA 域操作
- 逐条语句审批
- 脚本执行进度流式推送（结果在调用返回时聚合；长脚本走超时边界说明）
- 面板内脚本编辑器/人肉执行入口（agent 通道为主；如后续需要另立需求）
