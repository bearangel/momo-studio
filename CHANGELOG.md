# Changelog

本文件记录 Momo Studio 的版本变更与研发账本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **版本号说明（2026-09-13 起）**：产品版本号与研发账本**解耦**——「未发布」小节的 v2.x 条目是
> 特性分组账本，不是发布史；研发期产品版本停在 `2.1.0-alpha.N`，发正式版才定终号。策略全文见
> `docs/dev/release.md`「研发期版本号策略」。上一正式版：**v2.0.0**。

## [未发布] — 节点互联 M3.0：收官清理与协议前置

无新功能面的清理批 + M3.1/M3.2 的兼容性前置。设计见 momo-hub 仓 `docs/specs/2026-10-28-momo-hub-m3.0-closeout.md`（三路探查回填定稿，Momus OKAY）。

- **协议能力协商前置（T1，hub `v0.1.6` + studio pin 升级）**：hub 侧新增方法级 minor 门槛——`METHOD_REQUIRED_MINOR` 全量登记（1.2 基线全表=2，分发守卫对 1.2 节点**零行为变化**，形状锚点锁死）、`unsupported_method` 结构化降级（载荷带 `method`/`requiredMinor`，message 含双方版本；未入表仍 `unknown_method`，一义一名）、`minorOf`/`protocolSupports` 语义分层（minor=向后兼容新增）。studio 消费管道：`hubProtoVer` 版本管道（hello 读 `HelloRes.protoVer` → `HubStatus`/`hub:stateChanged`/设置面板「hub 协议版本」行）；错误 code 传播修复两丢点（`RpcRemoteError` 带 `readonly code`；hello 拒绝透出 `lastErrorCode`，mismatch 专属文案）；`m2-integration` 模拟 hub 由严格相等对齐真实 major-only
- **hub 监听地址硬化（T4，hub 仓）**：`MOMO_HUB_HOST` 可配，默认收紧 `127.0.0.1`（原 `*` 绑定防疏忽暴露）；显式 `0.0.0.0` WARN 提示；非法值回退默认+WARN；Dockerfile 显式 `0.0.0.0` 维持容器端口映射语义
- **非 2xx 下载人话化（T2）**：`describeHttpDownloadFailure` 映射（404→资源包不存在或已下架 / 403→无权访问 / ≥500→hub 服务异常 / 兜底），接入 `marketplace/installer.ts` downloadFile 汇聚点（resource+plugin 两条 hub 安装链同源覆盖）；`HTTP <status> <脱敏url>` 原文只进主进程日志；`DOWNLOAD_HTTP_FAILURE_PREFIX` 按「一义一名」退役（无生产者），兜底前缀更名 `DOWNLOAD_HTTP_FALLBACK_PREFIX`。Smithery 详情接口（非 hub 端点）不套 hub 文案
- **renderer 测试超时固化（T3）**：`hookTimeout: 60000` 进 `renderer/vitest.config.ts`（monaco 全量并行加载背景注释）——全量测试零 CLI 参数跑绿
- **keychain 门面作用域化（T5）**：作用域上提到 `keychain.ts` 门面、加在**服务名**——默认 profile `'Momo Studio'` 字节不变（既有用户 key 零影响）；隔离 profile `'Momo Studio-<hash8>'`（sha256 完整路径前 8 hex，防 basename 碰撞）；`creds.ts` 自有作用域退役回归裸 `hub.deviceToken` 键（门面分域接管，D2 无迁移裁决沿用——隔离实例重新 enroll）；boot 接线 `wireKeychainScope`（Electron `userData` 路径 vs 默认值）
- **CI e2e 解禁（T6）**：根因实锤 = GitHub macos-latest 显示器 1024×768（workarea ≈1024×677）——看板失败为已关闭列中心在视口外（指针可达性死区，dnd-kit over=null），browser 失败为 resize 增高腿被 AppKit 钳制；**两条 spec 真实适配**（非 skip 守卫）：kanban 拖拽手势内程序化滚动泳道（dnd-kit 6.3.1 droppable rect 拖拽开始一次性测量——滚动前置到激活位移前，源码+artifacts 双证据）、browser resize 改偏移无关稳定性收敛（视图高位移 ≥40 且 600ms 不变）；新增钉几何 harness `E2E_PIN_GEOMETRY=1024x677`（本机复现 CI 几何零往返）；**删除 `testIgnore`**，PR #2 CI 首次零隔离全量 e2e 全绿
- **M2.5 条目归因更正**：「拖拽时序/多窗口」→「runner 显示几何」（M3.0 T6 按 run 40676120418 artifacts 复核，追加注记保留原文）

版本 `2.1.0-alpha.36`。hub 侧 `v0.1.6`（tag `v0.1.6` = `489c067`）。

## [未发布] — 节点互联 M2.5：尾巴清偿与 M2 系列冻结

**M2 系列最后一期**。只清「有用户可见影响」的尾巴，并把能力缺口一次性显式关闭。设计见 momo-hub 仓 `docs/specs/2026-10-28-momo-hub-m2.5-tail-closeout.md`。

- **角标播种（A1）**：资源库目录**成功**加载后按类型一次性播种「可更新」基线（`seedHubUpdates`），重启/离线/带外目录变更后不再丢失更新入口；门控 = `hubStatusKnown && degraded===false && notEnrolled===false`（状态未知/未接入均不播种）；卡片三态——未拉取时不显示角标、**也不再说「已是最新」**（消除无依据断言）；事件增量路径保留
- **下载失败人话 + 单前缀（A2/A3）**：`describeNetworkError()` 五类映射（域名/拒绝/超时/证书/重置）+ 兜底「网络请求失败」，只包 fetch 抛错，原文进日志；错误前缀集合单点（导入/启停/停用/卸载/重载/**下载资源包/下载失败**）双侧契约测试锁死，`TypePageShell` 与 store 均不再叠前缀。**非 2xx 仍为 `下载失败: HTTP n`（按 plan 硬约束保留，人话化归 M3）**
- **节点清单补拉（A6，M0 起跨 6 期）**：新 IPC `hub:getNodes` 读主进程 `presenceSeed`（hello 快照 + presence 增量），冷启动/面板打开立即可见全部在线节点；拉取**只增不删**（删除仍归 offline 事件）；**零 hub RPC、零协议变更**
- **历史 concern 核实出栈（4 条）**：device token keychain 残留=FIXED（三条失效路径均清）；`*:18787`=NOT-A-DEFECT（验收期端口，产品默认 8787）；B 窗口重载=FIXED（底层 D1 已修）；凭证截断=NOT-A-DEFECT（token 不出主进程、不进日志，启动横幅为全值）
- **CI e2e 首次真实跑通**：PR #1 三轮实测（pnpm 版本冲突 → 2 条环境性红 → 隔离后全绿）；`browser.spec.ts` / `kanban-drag.spec.ts` 在 GitHub macOS runner 上确定性失败（拖拽时序/多窗口），已 `testIgnore` 隔离并留解禁条件（本地仍跑）。**更正（2026-10-28，M3.0 T6 按 run 40676120418 artifacts 复核）**：真实根因为 runner 显示几何——macos-latest 显示器 1024×768、最大化 workarea ≈1024×677；看板失败 = 已关闭列中心在 1024 视口外（指针可达性死区，dnd-kit over=null），browser 失败 = resize 增高腿被 AppKit visible-frame 钳制（677 上限；导航/popup 收编/下载拦截/overlay 在 CI 全通过），「拖拽时序/多窗口」归因失实；两条 spec 已按几何适配（拖拽手势内程序化滚动泳道 / resize 断言腿改收缩）并删除 `testIgnore` 解禁
- **B 组能力缺口一次性关闭/迁 M3**（逐条理由以 spec §5 为决议正文；B13 的 M3 前置条件 = manifest `resources[]` 增可选 `version`，缺省语义不变）：B1 HITL L2 远程代答 · B2 远端空间清单 RPC · B3 多组 UI · B4 文件树远程浏览 · B5 无候选自动轮询 · B6 任务源接入 · B7 委派编排 · B8 远端代发/远程写 · B9 子节点反向配置推送 · B10 镜像增量合并 · B11 本地 stdio MCP 分发 · B12 hub 资源删除/下架 · **B13 镜像按快照版本对齐**（A4 撤回：快照 `SnapshotResourceRef` 无版本字段，需协议扩展）
- **已知限制**：A5 readonly 即时拒标记进程内易失=**设计边界**（重启仍由只读约束段 + HITL 超时拒兜底，持久化归 M3 权限子系统）；hub 通配绑定 `0.0.0.0` 与 `MOMO_HUB_HOST` 硬化归 hub 仓；隔离 profile 的 provider keychain 孤儿键归 M3（服务名未随 profile 作用域化）

版本 `2.1.0-alpha.35`。

## [未发布] — 节点互联 M2.4：失败路径如实化与收尾硬化

无新功能面的收尾批——把「失败路径说谎」清零，补齐测试/CI 护栏，理顺分层。设计见 momo-hub 仓 `docs/specs/2026-10-28-momo-hub-m2.4-failure-honesty-hardening.md`。

- **失败如实化（M2.3 Important-1 根治）**：`HubCatalogLoad` 增 `stale`（仅 `loadFresh` 失败回落时 true，**不写退避/不置 degraded**——P2-9 浏览零刷屏语义不破）；安装链 6 格判定矩阵——hub 不可达时**不再冒充「已是最新」**，改 `HubCatalogStaleError` 人话（「无法确认 hub 上的最新版本（网络不可用）」）；null 条目也不再误报「已下架」；镜像补装遇 stale → 跳过并记入既有 `unresolvedRefs`（协议零变更），其余资源继续
- **provider 错误原文透传（验收 D1 根治）**：断点在 `delegation-ports` 的 `watchTurnProduct` 只映射 status——改为读终态 final 事件的 `payload.error`；新建 `util/redact.ts`（密钥正则族集中，含 `token=`/`access_token=` 可选形态）+ **code point 安全截断 300**+`…`；`\n||details||\n` 分隔符拆分：主文案进卡面、技术详情脱敏后落日志（卡面不再印分隔符）
- **一致性与分层**：`handleOnline` 重启补拍消费 `record.reason`（leader/worker 对称）；`config.skills` 按 slug 首见去重（`config.resources` 既有 type+slug 全局去重保持原样）；`hub/accounting.ts` 抽取（仅 15 行裸查询，自愈链/目录缓存留在 mirror-applier）+ 双架构锁防回环
- **测试护栏**：forks IPC 守卫提升为共享 `electron/tests/setup/`，`main-forks` 一并挂载（消除潜在事件污染通道）
- **CI 纳 e2e**：新增 `.github/workflows/e2e.yml`（`push`/`pull_request` → main；`build` → **electron-rebuild（ABI 149）** → `pnpm e2e`；失败上传 `test-results/`）——既有 `build.yml` 仅 tag 触发，挡不住选择器/等待漂移回归
- **契约注记**：`HubInstallOutcome.cachePath` 可能为空串（发布回填行），存在性以账表为准；hub CHANGELOG 补记 items 排序取 semver-max 行 publishedAt
- **验收**：UC-P1-1~3 真机 pass；UC-P1-4 真机 pass（不可达 provider 路径，reason 含 `fetch failed：bad port`）；UC-P2-1 以单测证据（ABI 149 期间不跑 node vitest）；UC-P2-2 真机 manifest；UC-P3-1 静态校验 + 本地等价全量 e2e 15 pass/1 skip
- **已知限制**：无终态 final 事件时仍回落「未知错误」（真兜底，不伪装原因）；provider 失败卡面为既有双层契约的主文案（原始 401/响应体落日志不进卡面）；下载层失败仍以英文技术串呈现（`fetch failed`，M2.5 票）；**资源卡「可更新」角标仅由 `resource.published` 事件驱动**——重启/离线/带外目录变更后需等下一次发布事件（M2.5 首位票：`load()` 后一次性播种）；镜像对已装旧版不升级（既有镜像语义，M2.3 起记录边界）；e2e CI 首跑需推送后实测（预案：收窄 `--grep hub-distribution`）；本地 stdio MCP 分发域外维持

版本 `2.1.0-alpha.34`。

## [未发布] — 节点互联 M2.3：版本取值链修复与债务清偿

hub 侧 `v0.1.5`（目录 latest 语义 semver 化——乱序发布不回退；协议包仅注释语义更新，零字段变更）；studio 侧 pin 升级 `#v0.1.5` + 版本链四点修复 + 通道/锁面债务 + 测试基建与回归沉淀。设计见 momo-hub 仓 `docs/specs/2026-10-27-momo-hub-m2.3-version-chain-debt.md`。

- **版本取值链修复（验收 D3/O-1 根治）**：安装/更新链强制 fresh 目录（绕 TTL/退避/lastGood 陈旧快照——装旧版根因）；已装判定 semver 化（target ≤ 已装 → 如实「已是最新版本」零动作，根治同版幂等静默假成功）；可更新角标 semver 前进判定（替代字符串不等）；消 hubUpdates 键条件化。新 `version-compare.ts` 单源（数值段/缺段/预发布/非法段容忍）— 与 hub v0.1.5 私有实现契约锁（同输入同输出表）
- **hub v0.1.5**：目录 latest = versions 全集 semver max（时序乱序回退修复）；versions semver 降序
- **worker reason 通道**：`DelegationRecord.reason?`（kv 可选字段零 DDL）——runner settleRun 同源落账本 → sync 写 worker 本机卡 errorMessage（leader 侧对称面补齐；缺席回退老数据零改写）
- **锁面补强七件**：双源单卡锁 / loadHubAccountingSet 导出契约化 / 回填缓存守卫+自愈 / collectSkills 未计入 warn / installProgress 常量契约测试 / CHANGELOG 补句 / **workspace.store load() 保 active 守卫**（消除全关标签后 listChanged 复活 + notifySwitch 无条件重放——漂移排查 P-A 路径）
- **测试基建**：agent-threads 组迁 forks 池（SIGSEGV NAPI 析构债根治，两跑稳定零差）；hookTimeout 10s→30s；monaco diagnostics 三关（unhandled rejection 噪声）
- **e2e 回归沉淀**：`tests/e2e/hub-distribution.spec.ts` 六场景（发布→记账/manifest 携带/全新 profile 零 unresolved/readonly 即时拒/版本链前进/已是最新如实）——mock hub 五端点 + ws 定向 + 本地 OpenAI 兼容 mock LLM，零外网；另修两处既有 e2e 测试侧债（创建空间异步等待竞态 / 提交键改名失配）→ 全量 e2e 15 pass
- **真机验收**：版本全链四段（v1 装→v2 前进→乱序不降级→镜像补装 v2 同 checksum）+ P2 四项全 pass；零 P0/P1/P2
- **已知限制**：worker 运行期 provider 失败 reason 泛化为「未知错误」（原文未透传，M2.4 票）；镜像快照 config.skills 同 slug 冗余（resources/落装正确，去重 M2.4 票）；CI 未纳 e2e（选择器漂移风险，M2.4 票）；本地 stdio MCP 分发域外维持；readonly 标记进程内易失（重启降级）

版本 `2.1.0-alpha.33`。


## [未发布] — 节点互联 M2.2：私有资源分发链闭环与打磨

hub 仓零代码改动（v0.1.4 不变）；studio 侧分发链泛化 + 11 项打磨票 + 类型债清偿。设计见 momo-hub 仓 `docs/specs/2026-10-27-momo-hub-m2.2-distribution-closure-polish.md`。

- **发布记账回填泛化**：agent/skill/mcp/plugin 四类发布成功统一回填 `installed_packages` `hub:{slug}` 记账（幂等升版单行 + item_type 限定防牵连 + 记账失败不翻转发布回执）——「发布 → 记账 → 快照携带 → 目标先装后落」闭环补完最后一环；发布入口对 marketplace 源 skill 开放（canPublishToHub 单点门控，防生效性≠可见性漂移）
- **发布打包链修复**：marketplace 装面 skill 发布 slug 推导错误（版本号当 slug 静默错名上传）修复——slug 取 skill_definitions 行；已发布 custom skill 镜像改走 hub 补装位（collectSkills 内嵌不查记账的断裂修复，验收 D1）
- **镜像 S2 分桶**：SnapshotSummary 增 skillResources/skillEmbedded——差异摘要「N 补装 + M 内嵌」与实际装包数一致（D8 清偿）
- **委派域三票**：readonly 档写工具即时拒（不走等待/超时，kind='denied' 三处联合扩展）；批量提交超限预检提示（不拦提交）；failed 外派卡 reason 全文（title 悬浮 + 摘要优先 errorMessage）
- **资源域三票**：saveAgentDefinition 改真 upsert（INSERT OR REPLACE 的 DELETE 侧触发 FK 级联静默清成员——M2 D3 根因修复；def 复用限 marketplace 血统，异源同 slug 行不动）；来源筛选切换即重拉；（S2 分桶见上）
- **镜像 worker UX 两票**：大包补装进度通知（hub:installProgress 三阶段 + 512KB 字节节流 + 右下角条栈）；两步确认臂态倒计时（useArmedConfirm 公共 hook）
- **壳杂项三票**：0-ws 态设置可达（MiddlePanel 分发前移 + SettingsView 全局分类放行，ws 级分类占位）；catalog 失败指数退避（60s→5min→30min 封顶，成功清零）；ensureWorkspace 错误改写收窄（仅 EACCES/EPERM/EROFS 标「工作目录不可写」）
- **债务清偿**：electron test 类型债 76 条清零（typecheck 检查面闭合防回弹）
- **真机验收**：UC-P1-3 全新 worker 全链（hub catalog→A 记账→manifest resources→B 零 skill unresolved 四件套）+ 恢复性场景（构建步硬失败→重发幂等自愈）+ P2 抽验 9/9
- **已知限制**：hub 资源升版链版本停留（验收 D3——「更新」回执成功但版本不变，M2.3 票）；安装取旧版（latest 解析，同族）；本地 stdio MCP 分发域外维持；worker 本机 failed 卡 reason 无通道（M2.3 票）；readonly 即时拒标记进程内易失（重启降级——回落约束段 + HITL 超时链承载，T3 documented）；agent-threads 测试组 NAPI 析构竞态（SIGSEGV 既有债，评估迁 forks）



## [未发布] — 节点互联 M2.1：工作组 IA 重分配 / 统一任务模型 / HITL

hub 侧两个 payload 透传补丁（`v0.1.3` permissionTier / `v0.1.4` progress.kind，均向后兼容可选字段——hub 侧账目见该仓 CHANGELOG）；studio 侧 protocol pin `#v0.1.4`。设计见 momo-hub 仓 `docs/specs/2026-10-26-momo-hub-m2.1-workgroup-ia-unified-tasks.md`，视觉合同 `.omo/previews/hub-ia-fullapp.html`（6+1 屏）。

- **工作组一等视图（IA 迁移）**：活动栏第 6 项「工作组」——监控台（组/成员 presence+负载/节点卡/在跑任务行/组操作菜单：邀请码重生成·转移组长·退组）+ 未接入空态就地接入（D2 空态困死治愈；0 工作空间可达——验收 D1）；查看全宽化（空间选择器 + 四页签主区整体替换，替代设置页内嵌 640px）+ 侧栏「查看中」态
- **设置瘦身**：节点互联仅剩迁移说明卡 + 连接 + 隐私与受控；GroupPanel/DelegationPanel/DelegationWizard/旧 ViewPanel 退役（retirement 零引用锁）；全部操作面 13 行消费矩阵归宿无丢失
- **统一任务模型**：执行位置=任务路由属性（本机/组内调度/指定节点），看板唯一创建入口——本地+外派任务同列混排（外派卡六态徽标+节点/来源徽标+进度行+取消两步/重试派发/失败重派）；批量模式（多行任务书统一路由+预检）；未镜像空间守门降级仅本机
- **least-busy 调度器**：leader 端纯函数（在线 ∧ 已镜像 ∧ running 最少，字典序破平局）；无候选留待处理不轮询；镜像登记表（workspace.mirrored 广播累积持久化——四消费方同源）
- **HITL 三层最小核**：L0 权限档位（readonly=会话级零授权+只读约束前置段 / sandbox=预授予工作空间写授权 / confirm 默认执行端确认）；L1 超时自动拒（默认 15min 可配 1-120——denied+steer 注入，双倍超时 failed 兜底不永卡）；L1b waiting-input 进度信号（write-blocked 单漏斗信号源；恢复自动去态全链防粘滞）；leader「等待节点确认」/worker「等你确认+来自节点」双侧卡 + 监控台徽标
- **真机验收修复（D1-D6）**：0-ws 主壳化（工作组零前置可达）；镜像携 defaultAgent 段（新 worker 默认实例在位，首派不再必拒）；workspace:listChanged 广播（镜像空间 UI 即时可见）；模型绑定 ghost 自愈；targetNodeId 回执回写（未知节点徽标）；取消两步确认
- **测试**：`tests/hub` 326 用例；renderer 2805；electron 全量 4858；真机 33/39→修复后冷启动全链 pass
- **已知限制**：调度无候选不自动轮询（待派发卡手动「重试派发」）；HITL 远程代答（leader 经 hub 回复确认）为 M3 议，本期确认仅在执行端就地处理+超时自动拒；任务源（插件/cron/外部 TODO）不在互联域——多元入口接入统一任务管道属插件生态，互联设置零占位；查看选择器 v1 列本机空间名（远端空间清单 RPC 为 M3 议，RM-M21-9）

## [未发布] — 节点互联 M2：工作组 / 镜像 / 委派 / 远程查看

hub 侧（独立仓 momo-hub `v0.1.2`，协议 1.2.0）交付工作组内核、快照存档 + 镜像两段式、委派账本 + 续传、查看转发 + consent、快照模型绑定可选段（hub 侧账目见该仓 CHANGELOG）；studio 侧四域全链接通 + protocol pin 升级 `github:bearangel/momo-hub#v0.1.2`（M2 私有 wire 段随 tag 发布，本地镜像模块补单源指针注释 @ v0.1.2 后保留——hub 无 `MirrorApplyOutcome`/`extractModelBinding` 本地类型导出，切换 import 得不偿失）。设计见 momo-hub 仓 `docs/specs/2026-10-24-momo-hub-m2-distributed-workgroups.md`。

- **前置小票（M2a）**：keychain 实例作用域（D2——多实例并行凭证互不踩踏）；资源库角标锚定已装版本（D7）；凭证作用域改全路径派生——根除同名隔离目录互撞（验收 profile 形态）
- **工作组管理**：组面板（创建/邀请码加入/退出/成员列表）+ 组 RPC 关联器 + presence 融合（组内在线状态并入节点互联面板）
- **快照构建器**：manifest 清单全量（agent 成员/团队/MCP/skill/插件/provider 引用/偏好 + 默认模型绑定可选段）；红线零渗漏（无 provider key/无 url 凭证头/无聊天历史，构建侧单测锁）；资源引用分流（slug 引用 vs 内嵌 custom 定义）；MCP 无记账告警补丁
- **镜像应用器 + 向导**：先装后落（M1 资源仓补装缺失 slug → 配置整体替换）；conflict 差异摘要两步确认（新增/移除/变更计数）；并发对账（mirrorId 对账键，伪造回执忽略/重复回执单次结算）；unresolvedRefs 软失败分列；向导四步流（预览获批稿）
- **委派执行器 + 面板**：委派会话独立执行（MC1——与本地会话隔离，首次 running 上报建会话）；前置检查（拒派 declined）；500ms 合并节流进度批（excerpt 恒非空）；断线 interrupted + 重连续传（running 恢复窗口）+ 取消；面板六态列表 + 会话式进度流 + 取消两步确认 + 新建向导；回合观测界定与端口回归锁
- **远程查看服务端 + 四视图面板**：workspace / files / messages / 会话流四组装器；尾部订阅（view.tail → view.appended 定向）；consent 上报链（默认 true / 断线清除 / 变更重报）；面板页签 + 回放分页（含头窗口——修单会话稠密 rowid 丢尾事件）+ 实时追加 + 只读红线断言
- **真机验收修复**：镜像模型绑定段透传（D4）；续传就绪等待（D6——前两次拒绝第三次成功语义）；回放刷新自愈
- **测试**：M2 三段集成测试（镜像/委派/查看全链 + consent 语义）；`tests/hub` 17 文件 210+ 用例全绿
- **已知限制**：UI 单组形态（一节点一组，多组 UI M3 议）；委派为单任务粒度（无编排/依赖图）；委派结果以会话消息流形态在查看面消费（拉取结果文件 M3+ 议）；文件树远程浏览不在版（M2 后跟进项——M2.1 票，spec §9）；镜像只做整体替换 + 差异摘要确认（无增量合并）；跨组路由/组间可见性不做

版本 `2.1.0-alpha.32`。

## [未发布] — 节点互联 M1：hub 私有 marketplace（资源分发）

hub 侧（独立仓 momo-hub `v0.1.1`，协议 1.1.0）交付资源仓三端点（发布 multipart 流式收包 / 目录 HubCatalog / 下载 blob 流）+ 发布事件广播（`resource.published`）；studio 侧四类资源（agent / skill / mcp / plugin）发布与安装全链接通。设计见 momo-hub 仓 `docs/specs/2026-10-24-momo-hub-m1-resource-distribution.md`。

- **四类资源发布编排**：打包形态各异（agent 定义→manifest.yaml 可逆 + README / skill cachePath 目录整包 / mcp package.json stub（name=npx 包名）/ plugin 委派打包链）→ multipart 上传（manifest part 先于 package part 定序契约）→ 错误映射人话（409 该版本已存在 / 413 超 200MB / 401 连接失效）+ C3 范围守卫（仅 custom agent 可发布、mcp 仅 npx 形态、url 红线拒）
- **插件发布打包**：白名单 walk（node_modules / .git / 数据目录不入包）+ 越界拒绝 + 归档校验和锚定（与 hub 端服务端自算对称）
- **hub 源安装链**：agent / skill / mcp 复用 marketplace 缓存链（hub origin 注册下载信任集放行 http + sha256 校验）；plugin 走归档链（checksum 强制 / tar 成员路径守卫 / symlink 与 FIFO 拒 / manifest.id 与 slug 锚定）复用 `finalizePluginInstall` 与本地 zip 安装完全等价；资源库 hub 第五源页签接入（已装去重 + 幽灵账兜底行）
- **发布对话框与更新角标**：发布入口矩阵（agent 编辑 / skill 卡 / mcp 设置 / 插件设置）+ `resource.published` 事件链 → hub 页签「有更新」角标四态反馈
- **M1 收口扫尾（T15a）**：`hub:{slug}` 跨类型记账防误删（`installed_packages` 按 item_id + item_type 双键删除，卸载/重装/级联三处全收口）；hub 插件 tar 解压炸弹守卫（累计 200MB / 5000 条目，与 zip 链同闸单源）；发布归档体积本地预检（tar 后按实际尺寸 >200MB 拒——避免白传满额包才被 hub 413）
- **已知限制**：hub 资源不可删除/下架（版本不可变 409）；mcp 仅 stdio npx 形态可发布（url 形态无本地包可打）；插件发布不含 node_modules（依赖解析 M1 不做）；目录 TTL 缓存更新窗口盲区（窗口内他节点新发布对本机不可见，角标依赖事件+TTL 双通道）；hub origin 为 http 明文时无内容真实性——checksum 仅防损坏不防篡改（catalog 与包同信道），公网暴露场景应 TLS 反代 + `MOMO_HUB_PUBLIC_ORIGIN`

版本 `2.1.0-alpha.29`。

## [未发布] — 节点互联 M0：接入独立 momo-hub 服务

节点互联重新起于**独立仓 momo-hub**（`github:bearangel/momo-hub`）：hub 是独立部署的中心服务（bin 入口 + Dockerfile），studio 侧只做**接入方**。协议包 `momo-hub-protocol` 经 **git tag 单源消费**（`github:bearangel/momo-hub#v0.1.0`——tag 即契约，协议源码变更须重打 tag 并 bump studio pin）——信封 / RPC / 事件 / semver 协商语义全部走协议包，studio 不自造 wire 格式。设计见 momo-hub 仓 `docs/specs/2026-10-23-momo-hub-overall-design.md`，实施计划 `docs/plans/2026-10-23-momo-hub-m0-connection-foundation.md`。

- **hub 独立服务接入（协议 v0.1.0）**：HTTP `POST /enroll` 以加入凭证换 device token（哈希落库 / 时序安全比较 / 同名轮换），token 入系统钥匙串；ws 升级鉴权 `Bearer <deviceToken>` → hello 协商（协议版本 + 节点名）→ 注册表广播在线状态。**换 hub 地址强制重新接入**——旧 device token 是旧 hub 签发的，对新 hub 无效（拿它连新 hub 会连出「鉴权失败 + 退避重连」死循环），故换址即停旧连接、清凭证、nodeId 归零、**清陈旧 lastError**，且不起新连接
- **连接层（状态机 / 退避 / 心跳 / 换址重接）**：`HubClient` 三态（disconnected → connecting → online）+ **指数退避重连**（1s 起、上限 30s）+ **心跳判死**（25s 一拍，无 pong 即 terminate 重连）+ hello 协商超时（5s）；per-socket 私有计时器与**身份守卫**——过期连接（已被新连接取代）的 close 不清新连接的计时器、不改状态、不调度重连（否则一条被拒连接会连出两条新连接）
- **设置「节点互联」面板**：接入表单（hub 地址 / 节点名 / 加入凭证）+ 三态状态徽章（已连接绿 / 连接中黄 / 未连接灰）+ lastError 人话原文行 + 在线节点列表（绿点 + 名称 + 「本机」Badge + nodeId 短码）+ 危险区「断开并忘记」**两步确认**（首击描边 → danger 填充「再次点击确认」，3s 自动回落）；IPC 四通道（配置 / 状态快照 / 接入 / 忘记）+ 两推送（`hub:stateChanged` / `hub:nodePresence`）+ preload/types 契约
- **已知限制**：在线节点列表为**事件增量维护**（M0 无补拉——面板打开后新上线的节点才会出现，冷启动仅本机行）；文件树远程浏览与远端交互（跨节点任务委派 M1 / 资源镜像 M2）尚未提供；hub 单点（无多 hub 联邦 / 无高可用）

版本 `2.1.0-alpha.28`。

## [未发布] — 移除 P2P 联网与 LSP 子系统

产品方向整改（spec `docs/specs/2026-10-20-remove-p2p-lsp-design.md`）：**P2P 联网子系统整体删除**（Ed25519 身份 / mDNS 发现 / TCP 直连 / hub 死码 / 资源分享与导入 / 任务只读镜像 / `source='p2p'`，-8783 行）——后续联网统一走 momo-hub（未来单独立项）；**LSP 子系统整体删除**（语言检测 / LspManager / 面板 IPC / 休眠工具链 / devDep，-3416 行）——未来以插件形式回归。migration **063** 彻底清（用户裁定 A）：`tasks.source_node_id` 列 DROP、`messages` 的 lan/hub 镜像行删除、`agent_definitions.default_tools` 的 lsp 休眠引用剔除；`ResourceSource` 联合收窄（builtin/marketplace/custom/smithery）、`MessageSource` 收窄（local/matrix）。**行为影响**：设置页「节点互联」分类消失（12→11）、任务看板远端节点分区消失、资源库 P2P 来源筛选消失。userData 残留文件（`p2p-identity.json` / `p2p-trusted-nodes.json` / `lsp-bin/`）无代码读取，保留不清理。依赖卸载四项（bonjour-service / tweetnacl / ws / @types/ws）+ typescript-language-server（devDep）。版本 `2.1.0-alpha.22`。

## [未发布] — Node 24 LTS + Electron 44 升级

工具链与运行时一步到位切换 Node 24 生态（spec `docs/specs/2026-10-20-node24-electron44-upgrade-design.md`）：**Electron 30.5.1 → 44.9**（内嵌 Node 20.18 → **24.22**，Chromium 124 → 152，ABI 123 → 149——两者原先均已 EOL）；**better-sqlite3 11.10.0 → 12.11.1**（11.x 停更无 Node 24 支持；钉 12 不上 13——v13.0.x 零 prebuild）；@types/node ^24；根 `engines >=24` + 新增 `.nvmrc`；CI 三平台 node 24；AGENTS.md/README 纪律同步。破坏面全量比对后唯一必修：`console-message` 事件迁移 Event 对象签名（level 数字 → 字符串）。行为变化登记：原生 dialog 无 defaultPath 时初始目录改 Downloads（不再记忆上次目录）；`window.open` 弹窗恒可缩放；macOS 最低系统要求升至 13。Electron 42 起 npm 包二进制改为首跑按需下载（postinstall 不再下载）。解锁 codegraph 引擎 Library API in-process 路线（Node ≥22.5 的 `node:sqlite`，整合另立项）。版本 `2.1.0-alpha.21`。

## [未发布] — 插件平台「工作空间维度」补全

真实使用四问题（配置不隔离/面板形态/工具门控/索引挂错）的平台级根治（spec `docs/specs/2026-10-17-plugin-workspace-dimension-design.md`）：① config 声明式作用域（manifest 属性级 `scope: workspace|global`，分轨存储 `config.<wsId>.json`）+ service 工作区多实例（lazy 启动带 enablement 门 / 切换停非当前 / 禁用前缀齐停）；② 面板 page 主区形态（panel.json location 扩枚举，codegraph 迁 page 获全宽画布）；③ agent 级插件工具门控（`agent_definitions.denied_tools` 迁移 061 + 配置 UI 分组开关，运行时 assertToolAllowed 现成）；④ codegraph workspaceRoot 留空默认跟随工作区目录——dape 索引挂错案根治（A2 回归锁）。

## [未发布] — 插件系统 P5 真实 LLM 验收轮

**2026-10-17 真实 LLM 独立环境验收**（bigmodel glm-5.3-flash 真实 key + 隔离 profile，`.omo/qa-reports/2026-10-16-plugin-llm-acceptance/`）：六测试点全通过——onboarding 真实供应商验证、dev 目录注册 + P4 config 表单保存即拉起 service（F1 语义）、**真实 LLM 主动调用 plugin:codegraph/explore + status**（C1 修复后 status 输出真实非零统计）、P4 面板 SVG 渲染 + watcher 外部写增量链（后写入符号出现在图上）、错误路径（未知符号→LLM 收到可行动错误并原样转述）、§8.6 禁用即消失/复启复活。验收抓修 1 缺陷：explore/graph 输出 basename 抹掉目录前缀致 LLM 读文件失败（agent 自愈绕行）——改 rel 路径输出 + 嵌套目录回归锁（oracle M5 升级实证）。

## [未发布] — 插件系统 P5：codegraph 插件本体 + §8 验收锚点闭环

平台扩展机制第五期收官（2026-10-16，spec §2.5/§8 / 计划 `docs/plans/2026-10-16-plugin-system-p5.md`）。**验收锚点交付**：codegraph 插件（五组件真实实现，仓库内 `plugins/codegraph`）注册进真实 App，§8 七场景端到端：6 pass + 1 partial（执行层环境故障待定位，调用链/审计归因真机铁证）。验收当场抓修 4 缺陷（setConfig service 拉起语义 / indexer 二次方炸弹 97s→0.8s / process.send 解构病三处 / 工具错误带栈）。版本 `2.1.0-alpha.20`。

### codegraph 插件（plugins/codegraph，自食本仓 1354 文件/4084 符号/12039 边）
- **索引引擎**（lib/indexer.js，单遍调用点提取 O(文本长度)）：符号四类提取（function/class/箭头/方法）+ 文件级调用边 + blast radius 上游传递闭包 + mtime 增量 + 上限守卫（5000 文件/1MB/忽略 node_modules·dist·.git·二进制）；「regex 近似」语义全程明示
- **工具**：`plugin:codegraph/explore`（定义片段+直接调用方+blast）+ `plugin:codegraph/status`（索引摘要）——child 侧按需增量扫描（双实例语义）
- **service**：workspaceRoot/config 驱动；目录树 watcher（800ms 防抖）+ reindex 队列消费（postToolUse hook 生产→dataDir 队列文件→service 消费——插件内闭环零宿主改动）；graph/stats/explore/reindex RPC；stop 关 watcher（§8.6）
- **面板**：查询框 + SVG 邻域图（中心符号环形布局）+ 统计行 + taskCompleted 事件防抖刷新（§8.5）
- **agent/skill**：code-navigator（systemPrompt 强制「先 explore 再读源码」工作流 + 预配两工具）+ codegraph-usage（图谱 vs grep 选择指引）
- 测试：indexer 7 / tools 5 / service 6（含注册走查与 §8.5 全链）+ .d.ts 类型面

### §8 验收修复轮
- **F1** setConfig 无条件 stop→start service（注册期缺配置的插件补配置后复活——§8.2 真机发现）
- **F2** indexer 单遍重写：全仓全量 97 秒（同步阻塞主进程，boot 冻结+SIGKILL 事故期确证）→ **0.8 秒**
- **F3** plugin-hook-bridge 三处 `process.send` 解构病（真实子进程 `this.connected` 抛错；P3 潜伏、mock 不炸）→ `?.bind(process)` + this 语义回归锁
- **F4** 工具/压缩错误 output 带栈前 3 帧（`[at]`，chat loop 与 executeTool 审计终值两处——可观测性补课；审查 I1 修正初版只覆盖压缩路径的漂移）

## [未发布] — 插件系统 P4：面板协议 + 设置页 config 表单

平台扩展机制第四期（2026-10-16，spec `docs/specs/2026-10-15-plugin-system-design.md` §6 / 计划 `docs/plans/2026-10-16-plugin-system-p4.md`）。「看得见」：iframe 沙箱面板挂侧栏、五消息协议双向通、config 由宿主按 JSON Schema 自动渲染表单（敏感值进系统钥匙串，`${config.KEY}` 注入 MCP args/env）。真实 App 隔离冒烟全链通过（面板握手/RPC/表单落盘/MCP 注入真值/禁用即消失），当场抓修 4 个真缺陷（CSP frame-src / 沙箱 origin='null' 语义 / 资源 id≠插件 id / setConfig 回包缺 schema）。含 P3 审查 minor 清扫：workspaceOpened reason 字段、终态双发文档化、hook_calls 50k 行配额。版本 `2.1.0-alpha.19`。

### 面板协议（spec §6）
- **momo-plugin:// 自定义协议**：只放行插件安装目录内的静态文件（standard scheme——插件间 origin 隔离；穿越/非 GET/跨版本全拒绝；数据目录天然不可达）
- **PanelHost + 面板模式**：活动栏「扩展」区图标 → 侧栏槽让渡给沙箱 iframe（`sandbox="allow-scripts"` 无 allow-same-origin）；三态（loading/加载失败红字重试/通道违规三振断开）；Esc 退出
- **五消息通道 PanelChannel**（v1 全集不设扩展）：ready（主题 token 快照）/ app:getContext / app:subscribe（task·resource·session 域白名单）/ plugin:callService（身份由通道绑定，面板只能调本插件 service）；入站 source 身份主锚 + origin 白名单（沙箱不透明 origin='null' 真机实证）+ 256KB 上限 + 20 条/s 令牌桶三振断开；出站仅发持有的窗口引用
- **panel.json 契约**：`{ panels: [{ id, title, icon: lucide:*, location: sidebar, entry }] }` 安装时拒绝式校验（≤4 面板）；禁用/卸载/重载经 plugin:panelsChanged 推送，面板即消失（§8.6）

### config 表单与注入（spec §2.2）
- **双轨存储**：非敏感 → `<dataDir>/config.json`（原子写）；敏感（`sensitive: true`）→ keytar `plugin.<id>.config.<KEY>`——明文永不回传 renderer（只显在场布尔）；主进程激活边界预热内存缓存供同步消费者
- **Schema v1 子集校验**：type/properties/required/title/sensitive/enum 之外拒绝；写入 overlay 语义（空输入=不变、null=清除、required 终态校验）
- **保存即生效**：写双轨 → MCP 重装配（`${config.KEY}` 展开 args/env，缺失键保留字面量可观察）→ 运行中 service 重启
- **设置页「插件」分区**：schema 自动映射控件（string/number/boolean/enum → 输入框/数字/开关/下拉；敏感 → 密码态 + 已配置徽标 + 清除）；无声明插件空态卡

### P3 审查 minor 清扫
- M1：workspaceOpened payload 补 `reason: 'created' | 'switched'`（切换≠新开，watcher 型插件可辨）
- M2：任务终态双发（taskStatusChanged + taskCompleted 同 payload）文档化于事件目录 + spec §5.1 补注
- M3：hook_calls 50k 行配额（观察者写入计数触发，批量删最旧滞回 95%）

## [未发布] — 插件系统 P3：hooks 事件总线 + service 长驻组件

平台扩展机制第三期（2026-10-16，spec `docs/specs/2026-10-15-plugin-system-design.md` §5 / 计划 `docs/plans/2026-10-15-plugin-system-p3.md`）。「管得深」：插件参与工具治理（preToolUse 拦截）与生命周期（15 事件 + 主进程长驻 service）。

### 新增
- **HookBus 类型化事件总线**：15 事件 × 三分发（emit=fire-and-forget 事务安全 / parallel=并发等齐 / waterfall=preToolUse 专属洋葱式 deny·rewrite）；handler 抛错 fail-open + logger.error；matcher 通配（git_* 式）；分发观察者落 `hook_calls` 审计（每 handler 每插件一条）
- **迁移 060**：`hook_calls` 审计表 + `tool_calls.pre_tool_use` 决策列
- **preToolUse 跨进程拦截**：子进程桥（id 配对 + 5s 超时降级 null + 无 IPC 直通）→ 主进程 waterfall → 决策回写；顺序「插件 → 内置权限 → 执行」；rewrite 后审计记生效值；**装配面 `pluginHooks` 标志零往返短路**（无 hook workspace 不白付 IPC——全量回归实证）
- **postToolUse/postToolUseFailure**：fire-and-forget 通知 + 审计
- **service 长驻组件**：start/stop/handle 管理器（崩溃隔离 + 惰性实例）+ `pluginCtx.callService` 子进程桥（工具/service 两侧——service 侧刻意无 callService 防递归）；启停联动（禁用时按 enablements 反查仍启用 workspace 数）；app 退出 stopAll
- **hooks.json 主进程加载**：`createRequire` 原生语义 + `require.resolve` 规范化缓存键失效（reload 新代码；两坑实证：vite-node 拦截 transform 态 require / macOS realpath 差异）
- **15 事件源**：storage 层 setter 注入（sessions/tasks repo 单点，事务安全分发）；resource/workspace 于 IPC 尾部单点 emit；**插件自身安装/卸载也发 resourceInstalled/Removed**（plugin:* 通道补线——语义缝隙修正）
- **生命周期全接**：install（hooks+service+agents+mcp）/ uninstall（全清）/ reload（重激活新代码 + runtime 重建）/ setEnabled（事件 + service 联动）

### 设计取舍
- preToolUse 钩子落 doExecuteTool + decisionSink 参数回传 executeTool 审计终值（包装层方案被否——测试群直调 doExecuteTool）
- spawner plugin 分支前加同步前缀门卫——非插件消息零 await 让步（audit:toolCall 同步落库线契约）
- 测试群隔离卫生：pretool/审计测试补 AP_USER_DATA_DIR（曾碰真实库一轮，NOT NULL 失败未写入、零污染实证）；service-manager 测试 afterAll 清原生 require 缓存（teardown 段 SIGSEGV 防线）

### 已知遗留
- P1/P2 的预存失败域与 minor 不变（全量对照基线一致）
- 冒烟（隔离实例）：fixture v0.3.0（hooks+service 组件）注册/重载全通、DB 表就位；事件→hook_calls 落库链以单测+契约锁为准（运行实例代码新鲜度受 dev 重启链不确定影响，未强证）

## [未发布] — 插件系统 P2：工具扩展点 + 声明式组件激活 + reload

平台扩展机制第二期（2026-10-15，spec `docs/specs/2026-10-15-plugin-system-design.md` §4 / 计划 `docs/plans/2026-10-15-plugin-system-p2.md`）。「用得上」：agent 能调用插件工具、插件 skills/agents/MCP 三面激活、改码→重载即生效。

### 新增
- **子进程插件工具加载器**（`agent/tools/plugin-tools.ts`）：纯 tsc CJS 无 bundle → `require(绝对路径)` 原生可行；命名空间强制 `plugin:<id>/<短名>`（拒绝自带前缀 / 内置重名——防跨插件仿冒与目录污染）；坏模块降级进 failures 不拖垮 runtime；`pluginCtx`（getConfig/getDataDir/logger）注入；插件工具与内置 14 个同环境同治理（per-call ToolContext 全套：wsFs 沙箱/权限/readTracker/流式/中断）
- **AGENT_CONFIG 装配**：`PluginToolRef` 线协议（rootDir/modulePaths/dataDir/config 快照）+ `buildSpawnOpts` 按 workspace 启停过滤（快照冻结语义继承）；skills 零复制追加（`SkillRegistry.register` 直指插件目录）；MCP 贡献名双滤（`filterDisabledPluginMcps`）
- **审计溯源**：迁移 058 `tool_calls.source`（builtin/plugin）四点透传（logToolCall 载荷 → spawner 桥 → insert → 落库）
- **声明式激活**：agents 落库 `source='plugin'`（id=`plugin:<id>:<slug>`，幂等，卸载级联清成员行）；MCP 注册 `plugin_id` 归属列（迁移 059，卸载精确级联 + 清 agent 引用）；安装/卸载钩子双向接线
- **manifest 校验步骤 5**（交叉引用）：agents YAML 的 `plugin:` 前缀工具 ref 与 defaultSkills 引用存在性检查（短名域 = tools 文件名约定）
- **plugin:reload**：重读 manifest → 组件重激活 → 受影响 workspace 的 lastRunning 实例 stop→start 重建（镜像 init-runtime 装配链）；详情面板「重载」按钮 + 横幅反馈
- **pluginTools 对 allowed/denied 的语义**：插件工具不进精确白名单（可见性=装配面）；`plugin:<id>/*` 前缀 deny 整插件禁用（P2 一档）

### 设计取舍
- `RuntimeConfig.pluginTools` 可选（线协议向后兼容——必填破坏 20+ 存量测试夹具）
- MCP 归属用真 schema 列（plugin_id）而非「source 全删+重放收敛」——避免闪断他插件条目
- 交叉校验短名域取模块文件名（静态近似；运行时真名以 getDefs 为准）——覆盖绝大多数插件形态，注释记录约定
- WarmPool 一 task 一进程 → 子进程 require 缓存无失效需求；真失效面 = spawn 闭包旧 opts，reload 走现成 stop→start 链，不发明 pool eviction API
- pluginCtx.callService 留 P3（service 组件期）；config 敏感值 keytar 与设置表单留 P4（面板协议期）

### 已知遗留
- 同 P1 的预存失败域与 SIGSEGV 家族（本次全量对照基线一致，零新增）
- P1 的 6 条 minor 未动（handler async 一致性 / setEnabled 中文错误 / 竞态兜底 / DRY / 空转测试 / 启停无反馈）——建议 P3 开工顺手清

## [未发布] — 插件系统 P1：注册表 + 安装链 + 资源库插件页

平台级扩展机制第一期（2026-10-15，spec `docs/specs/2026-10-15-plugin-system-design.md` / 计划 `docs/plans/2026-10-15-plugin-system-p1.md`）。momo-studio 获得统一插件单元：一个目录 + `momo-plugin.json` 清单，P1 交付「装得上、管得了」——manifest 校验管线、zip / dev 目录两条安装链、机器级注册 + workspace 级启停、资源库第四类型页。工具 / hooks / service / 面板的**运行时激活在 P2-P4**（P1 插件卡仅注册与展示）。

### 新增
- **DB 迁移 057**：`plugins`（机器级注册表：id/version/manifest_json/state/source）+ `plugin_enablements`（workspace 级启停，**行缺失 = 启用**默认语义）；dev 源目录消失由读路径自愈标 `missing`、恢复即回 `active`
- **manifest 解析校验管线**（`plugin/manifest.ts`）：JSON 形状 → id/version 白名单（复用 marketplace 的 `SLUG_PATTERN`/`VERSION_PATTERN` 注入防线）→ components 路径安全（`./` 前缀、拒 `..` 与反斜杠、锁插件根内——Claude Code path traversal 同款防线）→ 组件存在性；违规聚合抛 `PluginManifestError`（错误带字段路径）
- **zip 安装器**（`plugin/installer.ts`）：AdmZip 复用 skill 链骨架（`isIgnoredEntry` + 路径防御），新增 **zip bomb 守卫**（累计解压 200MB / entry 5000 上限——skill 链没有的缺口）、单层包裹目录支持（macOS 压缩产物）、`minAppVersion` 硬校验、staging 原子落位 `installed/<id>/<version>/`（单版本驻留、失败零残留）、卸载（zip 源删目录 / dev 源仅解注册 + keepData 问询）
- **dev 目录注册**：不拷贝直读源目录，重复注册刷新版本——插件开发日常流（改码→重载，重载动作 P2 提供）
- **plugin:* IPC 四通道**：`installZip`（Uint8Array→Buffer 归一）/ `installDevDir` / `setEnabled` / `uninstall`
- **资源库第四类型页「插件」**：侧栏「扩展」分组 + Blocks 图标；行级 dev 源 / 目录缺失徽标；详情面板组件 chips（`组件（N）——运行时激活将在后续版本逐步开放`）+ dev 源目录路径；「安装插件 zip…」「注册开发目录…」双入口弹窗（校验错误逐条内联不关弹窗）；启停开关（workspace 级）；keepData 双按钮卸载弹窗
- **ResourceFilter.workspaceId** 透传（插件行启停态解析；可选字段对既有调用方零破坏）

### 设计取舍
- 插件行映射进现有 `ResourceItem`（type='plugin', source='custom'，特有信息走新增 `plugin` namespace）而非独立列表体系——复用资源库全部同构 UI 与筛选；`parseResourceId` 正则同步扩展
- 组件激活不在 P1：skills/agents/mcp 走现有管线的激活属 P2（与 ToolModule 扩展点同期），P1 插件卡展示 manifest 元信息
- `isSafeEntryRelPath` 纯函数直测锁穿越防御——adm-zip `addFile` 写侧会把 `../x` 规范化为 `x`（实证），集成测试无法构造真实穿越 entry，读外部恶意 zip 时该分支是真防线
- 信任模型 v1「装了即信」：进程内 JS = 完整权限，与 dsh / Claude Code hooks 同档；强制项为命名空间隔离 / 路径安全 / minAppVersion / bomb 守卫（spec §7.3 诚实清单）

### 已知遗留
- electron 全量套件在本机存在预存间歇 SIGSEGV（ABI 横跳后签名态损伤家族，基线复现；单文件/分域运行稳定）与 7 个预存失败域（marketplace catalog 计数漂移 / dispatch-parallel pm-agent 文案 / events-pruning / hub-install / sessions-repo / office / sandbox——全部基线实证，与本次无关）
- 「重载插件」动作、settings 页插件面板留 P2；p2p 分享协议扩展插件包类型留生态阶段

## [未发布] — 智能体命名统一 + 创建表单收敛 + 工具名中文化

UX 一致性批（2026-10-12）。三件事：同一实体两套叫法（智能体管理视图=英文 Agent / 资源库=中文智能体，交叉引用混乱）、两份字段几乎相同的创建表单（单屏 Dialog vs 四步向导，preset/守卫逻辑已双份漂移维护）、能力列表 ~60 个工具全是英文 id 对中文用户不友好。

### 变更
- **命名统一「智能体」**：UI 英文 Agent 文案全量归一（活动栏 / 智能体成员 Tab / 「+ 新建智能体」「+ 添加智能体」/ AddAgentDialog / 资源库 TypeSidebar / 智能体市场 / 快速与协作会话引导 / onboarding / 删除披露文案），动词统一「新建」；代码标识符（`agents` 路由、IPC 通道、类型名）不动
- **创建表单收敛为 AgentCreateWizard 单表单**：向导迁至 agent 域并加 `source='agentView'`（步 4「设为默认会话智能体」勾选 + 无工作空间守卫，提交链 `createCustom→addMember→setDefaultAgent→loadDefinitions` 平移自 CreateAgentDialog）；CreateAgentDialog 删除（含 `source='library'` 死代码路径），向导成为唯一创建入口，资源库 fork 预填不变
- **工具名中文化**：目录条目（`ToolCatalogEntry`）加 `displayName`（`read_file`→读取文件、`git_stash`→贮藏管理…14 模块全量），能力列表**中文主名 + 英文小字副注**；勾选值与提交 ref 仍为英文 name；TS 必填 + `buildCatalog` fail-fast + 契约测试三保险防新工具漏译

### 设计取舍
- displayName 挂主进程目录（单一真相源）而非 renderer 映射表——防漂移，与 v2.x 目录切源同构；i18n 预留——将来主进程按 locale 返回 displayName 即可，renderer 零改动
- ResourceDetail 的 YAML 能力预览保留英文 ref（展示的是定义原文，非 UI 命名面）

### 已知遗留
- CollabSessionDialog.test 的 addMember mock 不仿真 Promise（既有 unhandled error，测试仍绿，另行处理）
- 外围域（SandboxNotice / About / ProviderSettings 等 ~8 处）散文残留小写 agent，是否专项清扫待定

## [未发布] — 工具预算软续期 + 默认上限 50

预算治理改进（2026-10-10，CFO 办公与 DevKanban 编码两次真实走查驱动）。走查实测：多文件产出型任务的工具需求 ≈ 探测 2 + N 文件 + 走查 2-3 次，旧默认 10 次必撞墙且以「出错 · 工具调用预算已耗尽」硬终局，任务报废需手动调上限重发。

### 新增
- **软续期卡**（顶层会话预算耗尽时）：`end(budget_exhausted)` 的 final 事件附 `reason` 字段（DB 行 status 仍 failed，零迁移），renderer 聚合为 `awaiting_renewal` 态——气泡以「待续期」卡替代错误框，三动作：**继续任务**（自动发续作指令，新回合满额预算）/ **本会话无限制**（先写 session `maxToolCalls=-1` 再续作，顺序锁）/ **就此停止**（定格已停止）。重启后事件流重放仍能还原卡片态
- 续作指令上下文透明（`[预算续期] …不要重做已完成的部分`）——agent 与用户均可见

### 变更
- **全局工具调用上限默认 10 → 50**：常量 + 徽标 fallback 同步；migration 054 把 kv_store 里旧默认痕迹 `maxToolCalls=10` 升 50（显式自定义值 20/-1/0 一律不动）
- dispatch 子 agent 流（PM tool_budget）保持硬预算失败回执原语义——无人值守场景不弹卡

### 设计取舍
- 续期走「发新消息」而非 resume 通道：resume 仅支持 task 流（快速会话不覆盖）；且预算语义本就是「单回合上限」，续期=新一轮满额更简单直接
- 防失控语义不弱化：默认仍有限（50），真失控时用户看到续期卡会自然警觉，比静默大默认更安全

## [未发布] — 协作会话未加入分区 + 会话只读即时生效 + 行内停用（走查反馈第三轮）

真机走查反馈闭环（2026-10-10 第二批）。三个问题：已启用预设不在协作会话候选（启用全局/成员按空间的模型不可发现）、停用/删除后会话要发一条消息才转只读、预设列表行无停用入口。

真机走查反馈闭环（2026-10-10 第二批）。三个问题：已启用预设不在协作会话候选（启用全局/成员按空间的模型不可发现）、停用/删除后会话要发一条消息才转只读、预设列表行无停用入口。

### 新增
- **协作会话「未加入」分区**：弹窗成员列表下新增「已启用、未加入本工作空间」区——启用是全局的、成员是按空间的，就近提供「+ 加入」入口（加入中 pending 态防秒级 IPC 空窗误判），免去去资源库停用重启用绕圈
- **预设行内停用按钮**：ResourceRow builtin 已启用态显示「停用」（danger 样式，与详情面板对称；同样走影响面披露确认）

### 修复
- **会话只读即时生效**：停用/删除 agent 级联后，主进程 `broadcastSessionListChanged` 推送 + renderer 侧（停用确认流/删除确认流）主动 `pullSessionList + loadMembers(active)`——`activeSessionReadOnly` 的 loadMembers 权威层立即翻转，输入框置灰 + 只读提示条（锁图标），不再等发消息
- 上轮验收探针误报修正记录：textarea 只读走 HTML readOnly/置灰态而非 disabled 属性，`isEnabled()` 恒真——验收须查只读提示条/输入框属性

### 已知遗留
- addMember IPC 含 agent 启动（WarmPool spawn，秒级）——加入按钮 pending 态已兜底 UX；启动异步化属 runtime 优化另行立项


## [未发布] — 预设停用 + 删除披露式级联 + 资源库三处 UX 修复

真机走查反馈闭环（2026-10-10）。上游分析：删除已入空间的 agent 现有链路存在「leader 团队 FK 级联静默解散无 UI 披露」与「deleteDefinition 非事务半状态不可重试」两处风险；用户裁定停用/删除均走**披露式级联**、停用语义 = **回到未启用态**。

### 新增
- **预设 agent 停用**：详情页已启用态新增「停用」按钮（与「启用」对称）；`agent:disablePreset` 删 builtin def 行回到未启用态（YAML 恒在，重启用走 enablePreset 既有 UPDATE 管线），成员/团队/会话级联与删除 custom 同内核
- **删除/停用影响面预查**：`agent:definitionImpact` 只读返回五维影响（成员数/空间名/leader 团队名/只读会话数/默认 agent 空间名）；删除与停用确认框逐条披露（`buildImpactMessage` 非零项才列行），预查失败回落通用文案不阻断操作

### 修复
- **deleteDefinition 事务化**：DB 部分（置空 default + 删成员 + 删定义）单事务，修复旧版「keychain 已清/部分成员已删/def 残留」半状态重试死循环；keychain 清理挪到事务后 best-effort（失败仅孤儿 key 无引用风险）
- **资源行删除按钮常显**：hover 浮现方案（上一轮改的 hidden/group-hover）实测导致「点编辑时删除恰好出现在指针处」误点——回退常显，误触由 danger 样式 + 披露确认框兜底
- **来源徽章挪位**：「系统预置/自定义」标签从按钮簇旁挪到名称旁（中间以弹性描述区隔开），消除「误以为是按钮」
- **详情面板溢出**（上一轮遗留补锁）：ResourceDetail 根节点补 `h-full`——内容区出滚动条、底栏按钮固定可操作

### 已知遗留
- `tasks.assignee_agent_id` 无 FK：删除 agent 后看板/详情对残留引用回退显示 ID 前 8 位（useTaskEntityNames 既有设计，加载期与悬空无法区分，暂不改为「已删除」文案）
- 主进程改动需重启 dev 实例生效（tsc watch 不重载运行中进程）

## [未发布] — 预设 agent 阵容全面重做（八角色 · 英文命名 · 领队重定义）

上游：16 款主流工具内置 agent 阵容调研（Claude Code / OpenCode / oh-my-openagent / Roo / Kilocode / Amp / Gemini CLI / Factory Droid / Devin 等，一手来源核实）——三功能轴共识（调研→执行→验证）、review 是生态投入最重的角色、检索型 agent 是第二共识、description 即委派语义。Momo 原五角色阵容缺审查与调研两个生态位，pm-agent 定位（编排统领，v25 已废）与管理职能错位。

### 新增
- **八角色阵容（1 领队 + 1 通用 + 6 专家）**：新增 `code-reviewer` Hawk 🦅（只审不改：六步审查 + 分级发现 + 修复处方；git 只读四件套，无 git 写与 apply_patch）、`researcher` Sherlock 🕵️（网页+文档调研：webfetch + 浏览器组 11 工具 + office_read 消化，结论必附出处与置信度分级）、`general-assistant` Momo 🐾（品牌吉祥物当通用兜底，快速会话默认候选）
- **英文身份名 + 纯委派语义 description**（属性→职能映射，参考 OmO Sisyphus 一派；slug 全部不变——catalog id / 资源 id / 存量启用行零破坏）：pm-agent→Architect 🏗️、coder→Smith 🔨、requirement-analyst→Socratic ❓、ui-designer→Muse 🎨、office-assistant→Butler 🤵；description 不带中文角色头衔前缀（列表展示干净），中文角色定位保留在 systemPrompt 身份句与 README 正文，同时服务 picker 副标题与 dispatch 快照注入
- **Architect 领队重定义**（Sisyphus 生态位 × Momo 双会话）：带队工作流六步（接待→拆解→dispatch 派发→read_task_progress 盯进度→收拢核对证据→汇报）+ 单兵退化回管理专家（规划/评审/周报）；全阵容去掉 type/parentAgentId 层级残留（v25 去编排后不被消费，全员拉平）
- **prompt v2 结构**：四段式骨架保留（身份/工作流/工具要点/NEVER-ALWAYS 硬规则），全阵容补「被派发时」成员回传礼仪（task_reply 三件事：做了什么/验证证据/未尽事项）；Smith/Hawk/Sherlock/Momo 挂 verification-before-done（证据化完成纪律）
- **模型建议升当前代**（provider 白名单内、对照 provider-presets 校验）：Smith→openai gpt-5.2，其余→anthropic claude-opus-4-5（Architect）/ claude-sonnet-4-5（专家与通用）；原 gpt-4o / claude-3-5-sonnet 全部退役

### 变更
- catalog.json：8 agent 条目对齐（5 更新 + 3 新增），version→2.0.0，updatedAt 2026-10-09；终态 29 items（8 agent + 1 mcp + 20 skill）
- 契约测试同步：builtin-yaml-tier1 文件数 5→8；preset-preview 锚点更新（Muse 名 + 新阵容三元组断言）；resource ipc-handlers 预置清单断言 8 slug + Butler/Smith 名称

### 已知遗留
- 存量已启用的 builtin agent 行不自动更新（无 hash 同步机制，v16/v32/v37/v52 先例从不用 migration 覆写 prompt）——新装/重新启用/预览/薄 fork 即得 2.0.0 内容；Butler 实战纪律段落逐字保留（踩坑沉淀不动）
- Smith/Hawk 的 lsp_* 两项为 LSP 下架（9cc3407a）后的刻意休眠引用（preset-consistency 测试 E 豁免同先例），prompt 正文不提及休眠工具

## [未发布] — 预设内容库：五角色 agent + skill 全覆盖

设计依据：`docs/specs/2026-10-08-preset-agents-skills-design.md`；实施计划：`docs/plans/2026-10-08-preset-agents-skills.md`。上游：目标用户五类角色（需求/UI/全栈/管理/办公）的内置预设覆盖不足——UI 设计师缺失、pm-agent 编排定位与管理职能错位、builtin skill 仅 3 个开发向；选题全部来自跨生态装机量验证（Anthropic 官方 skills / superpowers / Vercel / oh-my-openagent 模式），内容原创中文零复制（license 纪律：Anthropic 文档 skill 私有协议、OmO SUL-1.0）。

### 新增
- **五角色 agent 阵容**：新增 `ui-designer`（设计契约产出 + 浏览器截图走查，最小权限工具集，Tier 1 全集）；升级 4 个为四段式 prompt（角色锚定→工作流→工具要点→NEVER/ALWAYS，OmO 模式原创转译）——`requirement-analyst` 更名需求分析师（三维追问 + [TBD] 纪律）、`coder` TDD 工作流化、`pm-agent` 重定位研发管理向（编排教学移交 formatDispatchHint 运行时注入）、`office-assistant` 追加技能挂载段（主体与 27 工具契约锁不动）
- **20 个 builtin skill**（17 新增 + 3 规范化）：通用组（长文档共创/反 AI 腔中文写作/完成前验证）+ 需求组（PRD 渐进共创/用户故事与验收标准）+ UI 组（设计 spec 契约/前端审美规范含 18 条反模式清单/设计走查七项清单）+ 全栈组（TDD 工作流/前端最佳实践 + code-review/write-tests/debug-reproduce 升级 1.1.0）+ 管理组（任务分解与排期/技术方案评审九项清单/周报三段式）+ 办公组（Excel 公式实战含速查/PPT 汇报构建/PDF 提取问答/Word 长文档排版，全部对齐 office_* 工具）；四组带 `references/` 走三层渐进披露（description → loadSkill → readResource）
- **一致性契约锁**（`tests/skill/preset-consistency.test.ts` 五项）：catalog builtin skill 条目 ≡ skills 目录（防双轨漂移回归）/ agent defaultSkills 引用存在 / frontmatter 完整含触发语 / manifest 生产解析器全过 / defaultTools 工具名真实（LSP 下架休眠豁免注释指回 9cc3407a）
- **catalog 双轨对齐修复**：skill 条目与目录一一对齐（原仅 1 条 vs 目录 3 个）；终态 26 items（5 agent + 1 mcp + 20 skill），updatedAt 2026-10-08

### 已知遗留
- LSP 下架（9cc3407a）后 3 个内置 YAML 的 lsp 工具引用为刻意休眠态（测试 E 豁免，恢复时摘除）；macOS 宿主 vitest 1.6.1 runner 对 child-process 密集文件（dispatch-bg / runtime-entry×5 / tools×10）有既有 IPC 反序列化崩溃与 sandbox linux 分支 9 例既有失败（真 main 对照证实，容器环境不受影响）

## [未发布] — 跨会话引用（@ 会话 pill + list_sessions / read_session 工具）

设计依据：`docs/specs/2026-09-30-session-reference-design.md`；实施计划：`docs/plans/2026-09-30-session-reference.md`。上游：会话间彼此隔离，引用旧会话结论只能复制粘贴——双通道收敛于 read_session（用户 `@` 明确指定 + agent 自然语言发现消歧），指针轻注入 + 按需读（评审裁定 A/B 方案）。

### 新增
- **SessionTools 双工具**：`list_sessions`（本 workspace 发现与消歧：标题关键词不区分大小写子串 + 时间/成员/消息数/首条用户消息预览冗余元信息，排除当前会话）+ `read_session`（范围门三连：不存在/跨 workspace/读自己，先于任何内容查询；默认最近 50 条 + beforeTs/afterTs 严格不等式翻页 + 双游标 footer 截断后追加恒存活；B 颗粒度渲染：正文行（body 单一真相源）+ 🔧 工具调用摘要 + 📤 dispatch 段，段聚合复用 exportAggregateEvents；OUTPUT_LIMITS 30KiB 兜底）；严格只读零写路径，runtime 子进程直连 SQLite（TaskTools 同款既有模式）
- **@ 会话引用（输入框）**：`@` 菜单第三组「引用会话」（agent→文件→会话组序，排除当前激活会话 + 标题过滤，数据源已加载 session store 零新 IPC）；session pill 七类 PillKind（`@标题` 正文锚点 + context.sessions 按 sessionId 去重保序——指针注入无双重曝光，异于 skill 正文透明）；消息气泡会话引用 chip（MessagesSquare 11px 纯展示）
- **Context 契约链七层**：`MessageContext.sessions?`（SessionContextItem 指针级）→ sanitize 元素级校验（sessionId 非空 + title string，堵 spread 透传陷阱）→ parse 形状校验（畸形剔字段不牵连 skills/files）→ expander 指针展开（deps 注入可测、missing 降级、「永不抛错」契约）→ `ExpandedContext.sessions?` 可选字段（旧 steer/resume 线上载荷兼容，消费方 `?? []`）→ `<session>` 块渲染（元信息 + read_session 使用提示，missing 先判不消费占位字段）
- **全路径可用**：快速会话 / 协作 leader / 被 dispatch 子 agent（per-run ctx `roomId=executionSessionId`，runtime-entry 单点注入），任务派发时自然语言「请参考 xx 会话」经 list_sessions 消歧后 read_session 直达

### 已知遗留（oracle 终审裁定，择期）
- read_session 上限 clamp（200）测试仅锁不抛错未锁 clamp 值（30KiB 截断独立兜底，风险极低）；存在性预言机（「不存在」vs「跨 workspace」双文案可探测他 workspace 会话 id 存在性——单用户桌面威胁模型接受，spec 既定取舍）；truncateString 多行截断标记嵌入行内的可读性微损（字节截断使 CJK 预览 ~26 字符，短于 spec 字面 80 字符）

## [未发布] — 看板泳道语义重构（待办=草稿 / 排队中=已启动队列）+ 看板顶置 + 变更视图收敛

设计依据：`docs/specs/2026-09-30-board-lane-semantics-design.md`；实施计划：`docs/plans/2026-09-30-board-lane-semantics.md`。上游：泳道命名与心智模型错位（「已分配」实为排队池）、「创建即入队」违背草稿-启动两段式、计划时间对已入队任务失效三处断链的收口。

### 新增
- **泳道语义重构**：表单创建一律草稿（agent create_task 保留建即入队）；「启动」成唯一入队动作（详情按钮/拖拽双入口，统一 executeMove 单点）；「已分配」列正名「排队中」，三等待原因（等并发/等计划时间/等车道）由 executor `scheduled_at` 闸门统一表达；无目标草稿拖入排队中弹「指派并放入队列」弹框（目标三选 + 可选计划时间，P1 预览确认）
- **看板顶置**：卡片右键顶置/取消顶置（pin 时间倒序压顶），列内排序收敛「顶置组→创建时间倒序」，boardPosition 手动排序链退役（迁移 050/051）
- **任务详情变更视图**：JournalRollback/TaskChangesPanel 退役为 TaskChangesView 纯查看（与气泡 ChangesChip 同款）
- **详情防空白**：任务详情抽屉首帧从任务列表命中行零等待渲染（切执行会话回看板不再空白）

### 修复
- 编辑资格收敛：进入执行管线（已分配/排队/进行中/暂停）即锁定编辑，仅草稿/待分配可改
- 新建任务分组默认跟随看板选中分组
- pending 状态退役（迁移 051 存量转草稿 + 计划时间由闸门消费）；scheduler 升级扫描改 due-wakeup 唤醒；新建/编辑表单删除无执行语义的截止时间字段

## [未发布] — 会话与任务联动优化（G1 变更显示统一 / G2 双锚点定位 / G3 撤回联动取消）

设计依据：`docs/specs/2026-09-29-session-task-linkage-design.md`；实施计划：`docs/plans/2026-09-29-session-task-linkage.md`。上游：任务详情与来源会话之间「变更摘要不常显 / 消息定位无处落 / 撤回殃及任务」三处断链的收口。

### 新增
- **G1 任务变更显示统一**：抽取 `JournalFileChangesList` 共享文件行渲染件——任务详情「变更与回滚」摘要常显（journal.list 挂载即查，scan 保持懒执行），ChangesChip 薄壳化（同款视觉单源）
- **G2 任务双锚点定位**：任务详情新增来源消息定位（分页循环查找 + 悬空/非顶层消息如实降级）与执行会话全状态回看；消息锚点归一 MessageList 行包装 + `msg-flash` 共享闪烁件
- **G3 撤回联动取消**：TurnUndoDialog 撤回前预检关联任务（`listTasks` 新增 `sourceMessageIds` 集合过滤），未启动任务默认勾选一并取消——先撤后取消顺序锁（invocationCallOrder 回归锁），失败逐条呈现不中断

## [未发布] — v2.9 事件驱动 dispatch 与回执结果完整性（两轮 5-agent review 修复闭环）

设计依据：`docs/specs/2026-09-24-v2.9-event-driven-dispatch.md`。上游：主机会话实测（followup 盲等 9 分钟 + 子 agent 长报告回执截断丢失）+ opencode/oh-my-openagent 契约调研。

### 问题定义
- **followup 盲等三盲区**：发送前不知子 agent 存活、等待中零感知、超时后死局（「请直接查看该 agent 的回复」——PM 无任何查看工具）
- **回执截断三根因**：task_complete 分段后终态回执只携带末段尾巴（14 项报告只剩 1 行摘要）；无超长落盘机制；max_tokens 从未透传（OpenAI 请求体无该参数）

### 新增
- **DispatchRegistry（主进程跨轮链真相源）**：runtime 子进程每轮 task-end 即退出——pendingReplies/bgHandles 不跨轮存活，迟到回执被静默丢弃。注册表上移主进程：心跳续命/终态翻转/PM 空闲快照 awaitWake/死亡清扫（3×60s 无信号判死）/settled 容量驱逐。纯逻辑 + 可注入时钟
- **followup 异步化**：派发即返回送达确认（不再盲等 3+6 分钟）；终态回执恒投递——落 dispatch-result 消息行（sender='owner' + taskId=链 ID，进链历史供后续 followup 聚合）+ routeUserChat(systemKickoff) 唤醒 PM 新回合
- **子 agent 心跳**：dispatch 任务 60s 周期 in_progress task_reply（首拍立即发，注册即活）；主进程据 lastHeartbeatAt 判活——活链永不误杀（心跳重置同步计时器），死链约 3 分钟确诊（替代盲等 9 分钟）
- **分段重组进终态回执**：completedSegments 收集全部已持久化段——终态全文 = 全部段 + 末段尾巴（七个出口统一 buildFinalText 组装，分段上限溢出的 summary 也并入不丢）
- **超长回执落盘引用**：>8KB 全文写 `.momo-scratch/dispatch/<chainId>.md`（workspace 沙箱内，read_file 可分页读），body 换「落盘说明 + 头部摘录 1500 字符 + 相对路径」；写盘失败降级回原文（回执绝不丢）
- **max_tokens 透传**：model-catalog outputTokens → AgentRuntimeOpts → AGENT_CONFIG → parseConfig → createLLMProvider → OpenAI/Anthropic 请求体（此前 OpenAI 从不发该参数、Anthropic 硬编码 4096/16384）

### 修复（两轮 5-agent review 阻塞项）
- **B1**：OpenAI 官方 reasoning 模型（gpt-5/o 系）硬拒 `max_tokens`（400）——`resolveMaxTokensParam` 单点判别（官方模型名前缀 + 无自定义 baseUrl → `max_completion_tokens`；GLM/DeepSeek 兼容端点保持 `max_tokens`），11 项判别矩阵锁死
- **B2（含 R2 fail-closed 收紧）**：内部事件桥层 owner 身份绑定（envelope sender 与 spawn 闭包身份不符即丢弃）+ routeDispatch dispatch_from↔sender 反查 + settle 只接受链的 subAssignmentId 本人回执；R2 三态化——环境性 DB 失败降级放行，「会话不存在/非成员」等攻击者可经 envelope sessionId 安排的反查落空一律拒绝（堵死 owner 行注入 + 任意 PM 唤醒 + 第三方链 settle 劫持的复活路径）
- **B3**：taskId 消费点加固——routeDispatch 形状门（`/^[A-Za-z0-9_-]{1,64}$/`）、spill 文件名同门 + `unsafe-<uuid>` fallback（堵路径穿越逃逸 workspace 沙箱）、steer/送达文案插值剥离控制字符（堵伪造结构注入）
- **B4（含 R1 退出边沿修正）**：强制截断（预算/中断/错误）时 done-未投递链补投；R1——退出路径仅当确实中止活跃任务（cleanedAny）才触发 forced 边沿（warmPool.release 每轮 kill 子进程，无条件触发会把每个正常回合都当强制截断，重复补投已消费结果）；链复用前 requeueUndelivered 快照补投上一轮（R3：经 pendingDeliveries 队列走串行化 busy 门，不并发拉起第二条顶层流）；教学文案诚实化（回合内完成请先 gather，正常收尾不补投）
- **B5**：inFlightFollowups 仅终态清除——心跳清标记曾造成子/主校验漂移（PM 二次追问拿到「已送达」确认后被静默吞掉）
- **B6**：sweepOnce notifyTaskReply 补 .catch（主进程 unhandled rejection 面）+ tryDeliver per-runner 串行化（takeNextDeliverable 单条取走 + await + busy 重查——一回合一条，消除同会话并发 PM 回合与 session-lane 覆盖）

### 已知遗留（spec §7.7/§8.6，择期）
回执全文双计（注入行 + 流行，需去重裁定）；task_reply body 无大小上限；spill 文件被 followup 下轮同名覆盖；notifyTaskReply reply_to 转发未门控（taskId 为能力凭证）；Playwright e2e 与真机验收未跑

## [未发布] — 会话卫生与状态真实性修复（2026-09-18 会话实测发现）

设计依据：`docs/specs/2026-09-18-session-hygiene-batch-design.md`。上游：一次「待办列表 + 并行委派」实测会话的 14 项发现全量处置。

### 修复
- **mandate 死锁（同一请求双倍执行）**：未完成判定完全依赖 agent 手动 todowrite 状态——hint 分级措辞（进行中/未开始 +「切勿重做」+「列表非新请求」）+ 一次性收尾校验轮（终文前仍有 user-source in_progress 待办时注入合成校验条，强制先对齐状态再收尾）
- **dispatch_bg 状态误报**：后台完成走 handleTaskReply→gather 旁路、tool_result 不带 subStatus，成功委派被双聚合器终态收敛误判 aborted（实测 6/6）——gather/cancel/派发失败补发 subStatus patch 事件回链 chip；仍未收割的收敛为 `delegated`（已派出后台）；句柄新增 `outcome` 区分子任务成败（失败不再显示为完成）
- **secrecy 泄漏**：模型私有规划块（`<secrecy>…</secrecy>`，含工具预算等内部策略）原样进入用户可见消息与导出——三个呈现面（messages.body 回写 / 导出文本段 / 实时 UI）统一剥离（含流式中途未闭合尾段），事件库原文保真不动（断点续跑/审计不受影响）
- **导出保真**：工具结果不再 2000 字符截断（导出定位无损审计产物）；`actualCount` 对齐实际渲染的顶层条目数（不再「宣称 12 条只渲染 6 条」）；agent 消息头渲染起止时间跨度 `开始 ~ 结束（跨 N）`（回合起点时间戳不再伪装成完成时刻）
- **memory_save 挂靠误伤**：全部待办完成后的收尾沉淀不再误报「未挂靠」（新谓词 `hasUserTodos` 任意状态；create_task 维持未完成挂靠判定）
- **args 写入链路契约锁**：tool_call args 经 chunk→routeChunkToBuffer→批量落盘→payload 的字节级一致回归锁（3KB 中文/emoji/引号对抗载荷 + 35 条跨批阈值 + 委派 chip）；生产库损坏裁决指引留档测试头
- **prompt 注入**：当前时间常驻注入（实测出现「2025」年份幻觉并写入持久记忆）；dispatch 教学「以 gather 的 toolCallsUsed 客观计数为准，不采信子 agent 自报」

### 新增
- **todo 稳定 ID**：全量替换协议不变，按归一 subject（写入即 trim）延续既有 id——跨重写逐项身份稳定，同批重复 subject 仅首个延续
- **记忆时效**：超 7 天未更新的常驻记忆注入时标注「保存于 N 天前，使用前请核实」；memory_save 教学补「事实类记忆先核实、内容注明核实日期」
- **workspace 卫生约定**：一次性/测试/演示产物写入 `.momo-scratch/<任务名>/`（注入全部 agent + dispatch 教学指定子 agent 子目录，并行不踩踏）

## [未发布] — v25 agent/会话域重构（去编排 + 团队 + 双会话）

设计依据：`docs/specs/2026-08-31-agent-team-session-redesign.md`。无旧数据兼容负担（migration v25 丢弃 role/parent 数据）。

### 重构（Breaking Change）
- **去编排**：`agent_assignments`（role=standalone/main/sub + parentInstanceId 父子链）退役 → `workspace_agent_members` 成员制（无角色，同 ws 同 def 唯一）；agent 定义全局化（`agent_definitions.workspace_id` 列 DROP）
- **团队取代主子编排**：`teams` / `team_members`（leader + 成员，建团事务保证 leader 必在成员集）；leader 在多成员会话中自动获得 dispatch 权（`buildDispatchSnapshot` 会话快照在 spawn 时定型，取代 role='main' + parent 链）
- **会话双类型**：「快速会话」（免弹窗直达 workspace 默认 agent；首条消息截断命名 + 接待 agent 首次回复后 LLM 异步生成标题）与「协作会话」（指定单 agent 或团队，建会快照展开 `session_members`）；workspace 级「团队会话」概念退役（`workspaces.team_session_id` / `coordinator_instance_id` → `default_agent_instance_id`）
- **接待路由**：非 @ 消息由会话内 `is_leader` 成员接待；@ 成员直答；目标成员离线自动拉起
- **IPC 通道面**：`agent:addToWorkspace`→`agent:addMember`、`agent:removeAssignment`→`agent:removeMember`、`agent:listAssignments`→`agent:listMembers`、`workspace:setCoordinator`→`workspace:setDefaultAgent`；`agent:assignMain` / `agent:updateAssignmentRole` / `workspace:getCoordinator` 退役；新增 `team:*` 七通道
- **AGENT_CONFIG 线协议**：`teamSessionId` 字段删除（dispatch/abort 目标会话一律用当前 `executionSessionId`）

### 新增
- AgentsView 双 Tab（Agent 成员 + 团队）；创建 Agent / 创建团队 / 创建协作会话三弹窗；会话入口 ⚡快速 + 👥协作 双常驻按钮；无默认 agent 时一次性选择引导
- 成员 leader 守卫（是任一团队 leader 拒绝移除，返回 blockedTeams）；删除命中默认 agent 联动置空
- 会话列表图标语义派生（单成员显示该 agent emoji；多成员显示成员 icon 组，leader 带 👑）

### 清理（Task 15 收官）
- 退役概念源码零残留：`AgentRole` / `parentInstanceId` / `coordinator` / `teamSessionId` / `assignMain` / `addToWorkspace` / `AgentAssignment` 过渡别名全部清除（合法残留仅 migrations 历史 SQL 与类型对齐注释）
- 148 个依赖 v25 前语义的红测试逐文件清账：夹具修复 / 断言重写 / 退役覆盖删除（裁定记录 `.superpowers/sdd/task-15-report.md`）；electron 全量 1306 + renderer 719 全绿
- e2e：新增 v25 最小冒烟（smoke.spec.ts）；旧 onboarding/Matrix 场景 spec 标记待重写（2.x 技术债在案）

## [未发布·研发账本] — 2.1.0-alpha 累积特性（自 v2.0.0 起）

以下条目为特性分组账本（非发布史）；spec 见 `docs/specs/` 对应文件。

### 多语言 LSP 子系统（spec 2026-10-01）
- **多语言 LSP 子系统**：LSP 工具多语言化（16 门语言注册表——验证层 12 + 实验层 4）；LspManager 迁移主进程 per (workspace × language) 单例（修复每任务冷启动 + 每 workspace 并发上限 3）；检测单一真相源（toolchain markers 根+一层子目录 glob，修复分体/monorepo 判据盲区；二进制 PATH 探测）；AGENT_CONFIG.lspLanguages 快照注入；lsp:op IPC 桥 + 设置页「语言服务」面板（三态 + 安装引导 + 重新检测）；语言服务面板支持一键安装（D3 修正案：仅 npm 分发语言装到 `<userData>/lsp-bin` 共享目录，TypeScript 锁 `typescript@^5` 防 TS 7 无经典 tsserver）。spec：`docs/specs/2026-10-01-multi-language-lsp-subsystem.md`

### 沙箱工具链安装授权（v2.20 账本，spec 2026-10-01）
- **沙箱工具链安装授权**：bash 工具链/依赖全局安装（rustup / npm -g / go install / pip --user）遇沙箱写拦截时给出结构化提示并弹一次性引导卡——「本会话允许」grant 或设置页永久 allow（双态 + 可编辑目录清单，预置五项）；授权仅扩写目录集维度（seatbelt/bwrap profile 追加 allow），黑名单/敏感目录 deny/网络双态不变。spec：`docs/specs/2026-10-01-sandbox-toolchain-grant.md`

### Skill 从 Git 仓库导入（v2.18 账本，spec 2026-09-24 P2.6）
skill 页新增「从 Git 仓库导入…」：输入仓库地址（如 https://github.com/obra/superpowers）即可全量导入仓库内所有技能。
- 机制：HTTPS zip 归档下载（GitHub codeload / GitLab archive，HEAD 默认分支）——**零 git 依赖**（终端用户可能未装 git）、零新依赖（AdmZip 复用）；仅公开仓库；60s 超时 + 100MB 流式上限
- 解析：自动剥归档顶层目录，**全深度**扫描 `**/SKILL.md`，每个父目录识别为一个 skill（slug=目录名，根级用 frontmatter.name 转换）——适配任意仓库布局
- 两阶段交互：扫描 → 预览（名称/描述/同名覆盖警示）→ 确认导入 → 全成功绿色横幅自动关 / 部分失败留窗逐条明细
- 落盘语义与 zip 上传一致：逐 skill 内容 hash 幂等（同内容跳过 / 不同覆盖 = 重导入即更新）、三层路径防御；临时文件一次性消费 + 崩溃残留清扫
- host 白名单适配器（github/gitlab 先行，gitee 等预留扩展位）

### MCP 测试反馈五项修复（v2.17 账本，spec 2026-09-24 P2.5）
主机测试反馈驱动的体验补全：表单尺寸 / 导入反馈横幅化 / MCP 全字段编辑 / 删除二次确认。
- 尺寸：快速创建参数框 3→6 行；导入 JSON 弹窗 520→640 宽、输入区 8→14 行
- 导入完成横幅化：全部成功 → 自动关弹窗 + 顶部绿色横幅「导入成功 N 条 MCP」；存在失败 → 留弹窗展示逐条失败明细
- MCP 全字段编辑（stdio + 远程）：已装自定义 MCP 详情页新增「编辑」——快速创建表单复用为编辑模式（预填全字段/名称只读防引用断裂/支持 stdio↔远程切换/版本防降级回传）；electron 新增 `getMcpEditView`/`updateMcpEntry` 双通道（UPDATE 保 id/installed_at/source，编辑后池驱逐 + 当前 workspace 自动重连）；smithery/marketplace 源的「配置」（连接参数专用）保留
- 删除二次确认：新 `ConfirmDialog` 原子件；mcp/skill/agent 三类型行/详情删除入口统一拦截（MCP 提示 agent 悬空影响），红色危险钮确认后才执行

### MCP 快速创建 + JSON 导入增强（v2.16 账本，spec 2026-09-24 P2.4）
资源库 MCP 页新增/导入体验补全：表单从「只能建 stdio」升级为二态全覆盖，JSON 导入兼容三家格式。
- 快速创建（原「手动配置」）：传输二态 Segmented（本地 stdio：名称/命令/参数一行一个/高级 env+cwd；远程 HTTP：名称/URL https/高级 headers）；env/headers 行可加可删（KeyValueRows 原子件，KEY/VALUE 两列）；同名覆盖二段确认（警示条+「确认覆盖」，改字段重置）；args 从逗号分隔改换行分隔（支持带空格参数值）；标题/入口文案同步更新
- IPC 契约：`RegisterMcpInput` 补 `headers`/`cwd` 双端镜像透传（落库端零改动，headers 含鉴权 key 沿用不落日志纪律）
- 导入 JSON（原「粘贴 JSON」）：顶层三格式识别（`mcpServers` > VS Code `servers` > 裸对象）；条目 `type` 权威判定——`sse` 明确报「暂不支持 SSE 传输」（不再静默误注册）、`http`/`streamable-http`/`streamable_http` 归一远程、stdio/远程字段矛盾检测；远程条目支持 `headers` 直导（导入后可在「配置」替换占位 key）；「插入示例」按钮一键填入结构化多行示例（stdio+带 headers 远程各一条，空输入直填/非空二段确认替换）

### 移除网络获取 + 外部市场快捷打开（v2.15 账本，spec 2026-09-23 P2.3）
战略转向：应用内不再承诺网络下载安装（外部市场适配成本高），资源获取收敛「本地导入 + P2P」；外部市场改浏览器快捷打开，为 momo-hub 统一市场让路。
- 移除面（仅 renderer，−1165 行）：资源页「网络获取」模式整体下线（Segmented 双态/RegistryBrowse/McpConnectDialog/registry 安装接线/store mode 字段）；registry IPC 契约两端保留（electron 管线零改动，momo-hub 复用地基）
- 外部市场 Popover：三页工具栏「外部市场」按钮 → 市场卡片（MCP：Smithery/mcp.so/Glama/PulseMCP/官方目录；Skill：skills.sh/ClawHub；Agent：momo-hub 预告位）→ `misc:openExternal`（https 校验）浏览器打开；面板常驻「回来怎么装」两行指引
- 预置库：AddMenu「启用预置库」（仅 agent 页）→ `resource:listBuiltinPresets` 本地 YAML 零网络清单 → 现有 EnablePresetDialog 配模型启用

### 已装远程 MCP 配置编辑 + MCP 引用对齐（v2.14 账本，spec 2026-09-23 P2.2）
P2.1 主机验收驱动：Smithery 装完 API key 无处改（401 只能卸载重装）、agent 按名引用 MCP 名字对不上即静默悬空。
- 配置编辑链：migration 040（`config_schema` 列，安装时落表单元数据）→ `getMcpConfig` 三级降级（库存 schema → Smithery 实时拉取+回写 → 裸表单）→ `McpConfigDialog` 双模式弹窗（schema 字段回显/裸模式 url+headers 键值行；D9：schema 模式 url 预填去 query）→ `updateRemoteMcpConfig`（`composeRemoteConfig` 单点 x-from 分流 + 专用 UPDATE 保 id/installed_at + name 级池驱逐即时生效）
- 引用对齐：卸载级联（三 deleteRegistered 断面挂 `removeMcpRefsFromAgents`，单行失败降级不破坏卸载原子性 D8）+ MCP 页「未满足引用」提示卡（`listDanglingMcpRefs` 扫描 agent 定义悬空引用，点名 agent 与引用名）
- 配置入口：已装远程条目详情「配置」按钮（`custom.transport` 双镜像填充 hub/custom 两点位）

### Smithery 直连 + DXT/MCPB 导入（v2.13 账本，spec 2026-09-23 P2.1）
P2 主机验收驱动：registry 已 100% hosted 且 install-config 端点死亡 → 直连翻转；魔搭轨移除。
- Smithery 直连安装（A1 免账号）：详情 `deploymentUrl` + `configSchema`（x-from 分 header/query，缺省 header）→ needsConfig 弹窗（McpConnectDialog）→ `installSmitheryRemote` 注册远程 MCP；`installable = isDeployed`
- Smithery 分页：registryList page 参数 + hasMore +「加载更多」+ 300ms 防抖服务端搜索
- DXT/MCPB 包导入：两阶段（parseMcpBundle 预览 + user_config 表单 → importMcpBundle 变量替换 `${__dirname}/${user_config.*}` + S1 校验 + cwd 注册 migration 039 + binary 执行位恢复 + 卸载清目录）
- 魔搭轨整体移除（ResourceSource 缩五源；无公开 API，P3 复核后再评估）；Store 安装流消费 needsConfig 闭合静默窗口

### 双轨 Hub MCP 接入（v2.12 账本，spec 2026-09-22 P2）
资源库 MCP「从网络获取」双轨 provider + 远程 MCP 传输——Smithery（国际）/ 魔搭（降级骨架，P3 复核 API 后接通）。
- Provider 框架：主进程 `resource/hub/`（60s 失败退避负缓存复用 catalog 模式）+ `resource:registryProviders` / `resource:registryList` IPC；RegistryBrowse 顶栏来源选择器（不可达置灰 + localStorage 记忆；置灰由 registryList degraded 驱动「最新信号胜出」）
- Smithery：registry list（无 key，q 搜索，首页 30 条）→ install-config → npx 命令注册（command 白名单 + args 滤引号，S1）；`installable = !remote`（hosted 项展示不可装）
- 远程传输：migration 038（mcp_definitions url/headers_json）+ `McpServerConfig` 二态（stdio | streamable_http）+ `HttpMcpClient`（JSON-RPC over HTTP POST，通知无 id 规范语义，零新依赖）+ 进程池按 transport 分流
- `ResourceSource` 扩 `smithery` / `modelscope`（两端契约 + 契约锁测试）；hub 安装/卸载链（installed_packages 记账 `${source}:${slug}` 先删后插幂等）
- MCP JSON 批量导入支持 url 型远程条目（https 强制双层校验 + 远程/本地徽标 + registerMcp 二态透传）
- catalog 面板切换卡顿修复（失败 60s 退避 + 超时 10s→3s，独立提前合入）

### Windows 全平台化（v2.10 账本）
Windows 代码层硬化 + 打包就绪——路径语义 / spawn / 单实例 / NSIS 四层补齐；Linux 容器内 `vi.mock('node:path')` 注入 win32 语义锁住纯路径逻辑，真机验收进行中（平台标「实验性」）。
- `platform/paths.ts` 统一目录边界判定（win32 大小写/UNC/分隔符归一 + posix 逐字节等价）——六模块七处收敛
- 六模块 `*.win32.test.ts`（大小写命中 / UNC 命中 / 异盘拒 / `..` 边界 / POSIX 归一）
- MCP spawn 修正：win32 `shell` 三态注入 + 逐元素引号转义（内嵌双引号拒绝启动）；其余 spawn 点审计豁免
- 单实例锁（`requestSingleInstanceLock` + second-instance 聚焦，消除 SQLite WAL 双开冲突）
- NSIS per-user 加固 + 未签名 SmartScreen 指引
- 待真机验收：安装 / 首启授权卡 / MCP npx 实启 / 双开聚焦 / UNC 工作区

### 多仓 git 工具（v2.9 账本）
workspace 内层仓 agent 可见可操作——「发现列表是唯一 `-C` 入口」安全骨架。
- `git_repos` 发现工具（根在前字典序；探测器上提 `git/repos.ts` 与 v2.5 对账同源）
- 9 工具可选 `repo` 参数：缺省逐字节零变化；指定时 `resolveRepoPath` 双校验（边界 + 命中列表）
- GitPolicy 均匀继承（分支保护按目标仓当前分支匹配）

### Orchestration 元语（v2.8 账本）
- `dispatch_followup`（链重建续聊）/ `dispatch_bg`（句柄 + 在途上限 8）/ `dispatch_gather`（all|any，超时非错误）/ `dispatch_status` / `dispatch_cancel`
- taskId = 链 ID（多轮聚合）；handleTaskReply 单点收口扩展；零新表零迁移
- 已知边界：followup 子流暂不嵌套渲染 / bg 句柄不跨重启

### McpBrowser 浏览器工具（v2.7 账本）
puppeteer 零依赖——原生 WebContentsView 叠加 + per-workspace partition。
- 12 工具（navigate/tabs/snapshot/screenshot/evaluate/click/hover/type/press_key/scroll/console/close）
- 单页共享 + takeover 三入口（地址栏 / 显式 / overlay）；user 态工具立即失败可重试
- 右侧浏览器侧栏：可折叠 + 宽度拖拽（280-720 持久化）+ agent 折叠期间打开网站自动展开 + dev server 探活
- 安全：file:// 限定 workspace（双防线）/ popup 收编 / 下载拦截 / webPreferences 四硬化

### 任务断点续跑（v2.6 账本）
- `turn-reconstructor` 事件重建（完整工具对 verbatim / 孤儿 tool_call 合成中断 result / 降级 degenerate）
- 关机保态（`markShuttingDown`）+ boot 陈旧流清扫；`resumeTask` 复用 executeTask + 车道闸
- 启动恢复卡（[恢复]/[放弃]，撤回后放弃走 journal:revert）

### 变更账本与撤销（v2.5 账本）
- 五写工具落盘前单点记账（内容寻址 blob）；hash 守卫 + 逆序撤销（漂移拦截 + 黄标）
- 多仓 git 探测器事后核对 bash 账外变更；200MB + 30 天配额滚动清理
- 消息流「N 处变更」chip + 任务卡审查面板（`journal:*` 四通道）

### ShellTools OS 沙箱（v2.4 账本）
- macOS Seatbelt / Linux bwrap / Windows PowerShell plain 三平台；`resolveShellSpawn` 三态（wrapped/plain/blocked）
- **网络策略（2026-09-13 修订 B）**：三态收敛双态 `deny | allow`，默认 allow；ask 信任门全链下线（事后文本鉴定漏检为结构性天花板）；deny 态保留 netOff 信息卡
- bash 结果 `sandbox: <tag>` 行；strict 默认 + permissive 逃生门

### FileTools 防御硬化（v2.3 账本）
- 结构化 apply_patch（V4A + PEG + 原子回滚）；Read-before-Edit 强阻塞；edit_file 失败信息增强

### 供应商预设与思维模式（v2.2.x 账本）
- 15 家供应商预设两段式新建；思维模式两级配置（模型级 + agent 级，四级 fallback + 四种 wire 方言）

### Agent 记忆系统（v2.2.0 账本，三期完结）
- 三层记忆（会话/工作空间/全局）+ FTS5/jieba/BM25 检索；注入链路（7000 字符预算）；memory 三工具 + 自动提取 + 滚动压缩；设置页管理 + 导入导出 + 90 天清理建议
- 待办：macOS 主机冒烟八项

### 效率增强（v2.1 账本）
- ✅ UI 设计系统（语义 token / 原子组件 / lucide + ESLint 机械强制）
- ✅ OS 级沙箱接线（由 v2.4 完成）
- 🔲 分支工作流 / 并发多任务 / token 配额 / LSP 集成 / CRDT / e2e 重写（v2.7 已新增 browser e2e）

### 网络策略收敛为双态（2026-09-13 修订 B，独立条目）
三态（deny/ask/allow）收敛为 `deny | allow`，默认 allow；ask 信任门机制全链下线（−1717 行）——迟到点击语义、签名词形三轮真机修复后裁定：事后文本鉴定存在结构性漏检天花板，默认放行 + 拒绝留挡外传通道是诚实取舍。kv 迁移：显式 deny 保留，其余一律收敛 allow。

### 会话连续性修复（A+B）`2026-09-14`
- fix: 会话上下文窗口「最早 N 条」→「最近 N 条」（getConversationContext；ASC+LIMIT 语义陷阱，/compact 早在 v30 注释警示）
- fix: aborted/failed 空 body 行合成中断/失败标记（防 Anthropic 空 assistant 400 + 模型可见信号）
- feat: rebuildSessionContext——主会话跨轮上下文 events 级重建，工具调用/结果跨轮可见、中断轮孤儿 call 自动合成结果、steer 行时间窗去重、当前指令行双拼消除（spec: docs/specs/2026-09-14-session-continuity-design.md）

### 浏览器接管优雅等待 `2026-09-14`
- feat: browser_* 工具用户接管时驻留等待（gateAgentSide 单飞，默认 120s 可配）+ 空闲自愈（90s 无输入自动回切，仅 agent 等待中判定）+「释放并继续」提示卡（notice kind agent-waiting-release / durationMs 契约加法）
- fix: 接管错误文案诚实化——超时出口携带等待秒数与 webfetch 改道指引（原「等待释放后重试」承诺了不存在的等待能力）
- fix: 释放提示遮挡修复（2026-09-15）——fixed 右下角卡落在浏览器 WebContentsView 占位区 rect 内被页面盖住（OS 合成层高于一切 DOM），改为 BrowserSidebar chrome 列内条幅，构造上无重叠（同类先例：侧栏拖拽手柄 bug 1）

### 提示交互分级统一 `2026-09-15`
- feat: 阻断类确认居中（信任授权带遮罩 / 释放等待无遮罩，安全区动态避让浏览器侧栏）+ 告知类右下堆叠（NoticeStack，上限 4 + 6s 消散）
- feat: 死信补渲染——crash 重载/popup 拦截/导航失败三 kind 首次可见；沙箱/升级/恢复三卡迁入堆叠，四卡同位叠放旧债清偿

### 浏览器 tab 归属制与隐藏/销毁分离 `2026-09-15`
多会话 tab 抢占 + 折叠劫持两痛点根治——agent 各自独立 tab 集合、收起=隐藏不销毁、会话级可见性、自动展开规则、关闭确认防误杀。spec：`docs/specs/2026-09-15-browser-tab-ownership-design.md`；计划：`docs/plans/2026-09-15-browser-tab-ownership.md`（7 任务 TDD 分解）。
- **tab 归属制**：manager `TabRecord.owner` + per-owner 光标 + `ownerTabs` 集合内重索引；12 工具按 `BrowserOpCtx.ownerId` 解析作用域（agent 实例 ID 或 `'user'`），`browser_tabs.list` 仅返回自身集合（user 源透出真实归属），`browser_close` agent 源只清自己集合、user 源全局销毁（含 agent tab）+ 仲裁复位全新起点
- **隐藏/销毁分离**：`browser:setSidebarVisible(false)` 视图 bounds 置零不销毁——agent 在用户收起期间照常 click/snapshot；落库折叠列 `browser_sidebar_collapsed` 退役（spec §7.4 列 inert，无 migration 触及）
- **会话级可见性**：renderer `browser-sidebar-visibility.store` per-session 替代落库 `collapsed`；新建会话默认收起，agent 首次导航自动展开本会话侧栏，他会话不受打扰
- **自动展开规则**：`browser:setActiveSession` 上报活跃会话（`App.tsx` 顶层 effect）；manager `expandHint` 仅活跃会话的 agent 导航触发，非活跃/null 安全缺省永不动可见 tab
- **关闭确认卡**：`browser:closeBrowser` 用户路径遇 agent 活 tab 弹居中确认卡（Tier A，`BrowserCloseConfirmCard`）——强制关闭走 user 源全局销毁路径；agent 工具 `browser_close` 不弹卡（其作用域已只清自己集合）
- **协议层**：线协议 12 op 元组尾部恒携 `BrowserOpCtx = { ownerId, sessionId }`（op-router 信封校验 + 元数上限表双锁 `source='user'` 走私路径）；renderer `BrowserSettings` 读面保留 `sidebarCollapsed`（store 形状不变），写面（`browser:updateSettings` `PATCH_KEYS` + 设置页「默认折叠」勾选 UI）下架
- **IPC 通道面**：14 → 16 通道（新增 `browser:setSidebarVisible` / `browser:setActiveSession` / `browser:closeBrowser` user 源）；`browser:setSidebarCollapsed` 退役
- **回归锁矩阵**：`tests/browser/{ipc,manager,manager-hide-expand,manager-ownership,op-ctx-threading,boot-wiring}.test.ts` + `renderer/src/components/workspace/BrowserSidebar.test.tsx` + `renderer/src/App.test.tsx`（活跃会话上报首报+变更重报）；11 commits 全量 typecheck/test 零错误（Task 7 收尾清扫 + 变异验证：`closeBrowser` 复位行摘除→接管区分度断言红；`App.tsx` 上报 effect 摘除→重报断言红）

### 会话输入框上下文系统（v2.11 账本）
spec：`docs/specs/2026-09-16-composer-context-system-design.md`。输入框从纯文本升级为结构化上下文载体——用户意图（skill / 文件）一次性注入本轮对话，metadata 与正文分离。
- **@ 文件引用**：composer `@` 提及 workspace 相对路径文件，随消息下发（≤64KB/文件、256KB/条消息内联，超限降级路径引用由 LLM 转文件工具自读）
- **/ 菜单命令 + 技能**：斜杠命令注册表（主进程 `commands.ts` 单一真相源）+ `/技能名` 挂载上下文；预置三技能（代码审查 / 调试 / 文档）
- **context 一次性注入（spec D2）**：主进程 `context-expander` 展开 → `<user-context>` 块包装进本轮用户正文（`turn-context.ts`）——每会话轮仅注入一次，会话重建只重放原文不重放展开
- **消息 chip**：owner 消息气泡上方的技能 / 文件 chip 行；文件 chip 点击 `file:read` 直开编辑器 tab，读取失败降级 disabled
- **P2P context 同步**：`SyncMessage.contextJson` 随消息广播，远端镜像同样渲染 chip
- **resume 断点重放（终审 I1）**：中断回合重建时首条用户消息的 context 与 steer 对称重放展开
- **egress 投影（终审 I2）**：steer 事件 `context` 全文只留 DB 供 resume，两处 renderer 出口（event batch 推送 / getMessages）一律剥离
- **交互精简（v2.11.1 主机验收反馈）**：`@` 统一菜单（agent + 文件同浮层双源过滤，移除 `@/` 独立语法，文件标记 `@路径` 与 agent 同形）；`/`、`@`、`#` 触发正则放宽为非空白字符集——中文名直接过滤；📎 点击直开菜单 + 空查询根目录默认文件列表（`file.list`，主进程零改动）；chips 自顶置工具条移入输入框容器内底部（Kimi 式），📎 移至框内左下角
- **内联 pill 富输入块（第三轮主机验收）**：textarea 升级为 contentEditable 富输入块——@（agent/文件）/ #（任务）/ /（命令/技能）选中的引用以原子 pill 内联在文字流中（填充底色式：agent 蓝 / 文件中性 / 技能紫 / 命令橙 / 任务绿；命令无前缀图标），光标处插入、退格两段式整删、IME 组字保护；会话草稿存 segments（pill 不丢）。发送序列化保持 IPC 三参契约不变（技能不进正文、命令整串拦截语义由形态保持）；菜单选择后焦点自动回编辑器、点编辑器即放弃菜单（终审修复）
- **句中 / 触发（第四轮主机验收）**：`/` 从整串锚定（仅空 body）改为空白前缀锚定——句中空格后与 pill 之后均可弹出命令/技能菜单，与 `@`/`#` 对称；路径/分数/URL 的 `/` 与 `//` 转义仍不触发；命令整串拦截语义不变（句中命令 pill 按混排正文发送）
- 已知边界：builtin 预置技能包不进子进程运行时 skill 索引——composer 注入路径不受影响；`<user-context>` 对内容零转义为设计取舍（与 file:read 等价暴露面）；selectSkill 光标居中会丢弃前段文本（低频边角）；e2e 打包路径待容器外验证

### Agent 创建工具集重构（v2.19 账本，spec 2026-09-30）
- **Agent 创建工具集重构**：修复 per-agent 工具白名单失效 P0（v1.7.1 并集误放行全部工具）；工具目录改为注册中心自描述单一真相源（`tools:getCatalog` IPC 下发，删除 renderer 镜像，24/33/60 三层漂移根除）；工具分级 Tier 0-3（平台机制恒注入 / Tier 1 公共默认 17 个 / 可选 / MCP+Skill 扩展）；创建入口（CreateAgentDialog + Wizard）支持 工具/MCP/Skill 三类能力配置；migration 052 存量 Tier 1 加法回填。spec：`docs/specs/2026-09-30-agent-tool-capability-redesign.md`

## [2.0.0] — 2026-09 Released

五期重构：**单进程 Electron + 内置 SessionService + 进程内事件分发**，本地零外部依赖（Matrix/Tuwunel 全家移除，−54 文件 −3226 行）。
- **P1 会话内核**：`sessions`/`session_members` 取代 Matrix room；dispatch/task_reply 内部事件桥
- **P2 UI 骨架**：无边框 + 自绘 TitleBar；活动栏 + 统一侧边栏；设置独立界面；provider platform 显式化；审计滚动删除；MCP 子进程桥恢复
- **P3 半成品处置 + IPC 收敛**：platform 运行时接线；#T 双语法 + T-序号任务 id 端到端；资源注册收敛 `resource:*`
- **P4 局域网 P2P**：payload 五类型分发；任务快照广播 + 远端只读镜像（D7 铁律）；资源分享 + 一键导入
- **P5 升级体验**：旧库只读导出 Markdown/JSON + `.legacy-v1.bak` 备份 + 首启一次性提示；完全重新开始（D5，不丢数据）
- 升级说明：v1.x 不做数据兼容；检测旧库自动全量导出 + 备份 + 告知路径；导出异常仅 warn 不阻塞

## [1.7.4] — 2026-08-12

### 修复
- **Bug 2（多段消息归组）**：MessageList 按 `io.momo-studio.segment_of` 字段归组多段 task_complete 消息，重启后 UI 显示与重启前一致——之前 N 段消息显示为 N 个独立气泡
- **Bug 3（事件顺序）**：多段消息由新组件 SegmentStack 按段顺序（segment_index）纵向堆叠，单段消息保持原顺序不变
- **Bug 4（增量 tool_calls）**：task_complete 分段 tool_calls 改为增量持久化（v1.7.3 全量快照导致每段重复显示所有工具调用）；新增 `io.momo-studio.tool_calls_offset` 字段
- **Bug 5（子 agent fresh session）**：dispatch 子 agent 跳过 `loadRecentHistory`——之前无差别加载房间历史，子 agent 误判任务已完成（输出"您好👋 之前的工作总结已加载完毕"）。参考 opencode task 工具设计：子 agent 是 fresh session，只看到 system + task prompt

### 新增
- 新组件 `SegmentStack`：多段消息纵向堆叠渲染（顶部聚合标签 + 每段段号分隔）
- 新类型 `SegmentGroup`：归组数据结构
- 诊断日志插桩：`task_complete` 分段 / `sendFinalMessage` / `loadRecentHistory` 关键决策点 trace 输出
- 测试：`segment-message-restart.test.ts` (3) + `dispatch-fresh-session.test.ts` (4) + `MessageList.segment.test.ts` (5) + `SegmentStack.test.tsx` (2)

### 已知限制
- v1.7.3 之前的旧分段消息已永久丢失 thinking/tool_calls（Matrix event 不可变）

## [1.7.0] — 2026-08-11

### 重构（Breaking Change）
- **资源库取代 Marketplace**：UI 重命名（MarketplaceView → ResourceLibraryView）+ 数据模型统一（`ResourceItem` 取代 MarketplaceItem / InstalledSkill / RegisteredMcp 三结构）
- **取消底部"自定义资源"折叠区**：custom 资源直接出现在主网格（按 source 过滤）
- **IPC 统一**：`resource:list` / `resource:getDetail` / `resource:install` / `resource:delete` 四通道，取代 `mcp:listRegistered` / `mcp:deleteRegistered` / `skill:listInstalled` / `skill:deleteCustom` / `marketplace:*` 等多套通道
- **资源 ID 命名约定**：`${source}-${type}-${slug}`——全局唯一 + 可路由（parseResourceId 反解三元组）

### 新增
- 双层 tab（类型 + 来源）AND 过滤 + 单按钮「+ 添加资源 ▼」下拉菜单（创建 Agent / 添加 MCP / 上传 Skill）
- SourceBadge 组件（4 source 颜色 + 文案：系统预置/我的上传/网络资源/P2P 共享）
- ResourceDetail 按 source 分支详情面板（builtin/marketplace/custom 字段差异分支显示）
- ResourceCard 统一卡片（install/removable 状态 + 删除/安装按钮）
- listResources 三源合并（builtin + marketplace + custom），filter 短路 + fetchCatalog 失败容错（catalog 拉失败时仅返回 builtin+custom，不阻断 UI）
- resource.store 双层 tab 状态机 + 安装/删除流程

### 删除
- `renderer/src/components/marketplace/` 目录（MarketplaceView / ItemCard / ItemDetail）
- `renderer/src/stores/marketplace.store.ts`
- IPC: `mcp:listRegistered` / `mcp:deleteRegistered` / `skill:listInstalled` / `skill:deleteCustom` / `marketplace:*`（5 通道）
- preload 6 个废弃绑定 + `marketplace` 命名空间
- types.d.ts: `RegisteredMcp` / `InstalledSkill` 类型 + ApiSurface 对应字段

### 修复
- v1.6.x 累积 bug 修复——`uninstallPackage` 之前传 `ResourceItem.id`（格式 `marketplace-mcp-foo`）但底层需要 catalog opaque id，导致 marketplace delete 静默 no-op；改为正确传 catalog opaque id

### 不动
- DB schema（Migration v0-v16 完全兼容，无新 migration）
- 底层函数（`listRegistered` / `listInstalled` / `installPackage` / `uninstallPackage` 等保留，作 `resource/` 内部复用）
- 现有 add 弹窗（RegisterMcpDialog / UploadSkillDialog / DefinitionEditor 保留，仅 IPC 调用层改名）
- builtin catalog 内容（catalog.json 不动，5 项全部归 `source='builtin'`）

### 架构预留
- `ResourceItem.source` enum 四值（`builtin` / `marketplace` / `custom` / `p2p`）——v2 agent 互联时加 `listP2PResources()` 即可接入

## [1.6.4] — 2026-08-11

### 修复
- **Marketplace 自定义资源区看不到上传的 skill**：根因双重——
  1. `<details>` 默认折叠，用户不知道点击展开；改为 `defaultOpen`
  2. `UploadSkillDialog` 成功后立即 `onClose()` 把弹窗关了，用户来不及看 successMsg 反馈；改为只 `setSuccessMsg + onSuccess`，弹窗保留显示「已安装：xxx」，用户手动关闭
- **refreshCustomResources 错误之前静默吞掉**：现在打到 `console.error`，DevTools 可看到 listInstalled 失败的真实原因（之前用户排查时看不到任何信号）

## [1.6.3] — 2026-08-11

### 修复
- **关键 bug**：UploadSkillDialog 上传 zip 永远报"未找到 SKILL.md"——根因是 Electron IPC buffer 传输损坏。renderer 经 preload 用 `Buffer.from(arrayBuffer)` 创建的 Node Buffer 跨 contextBridge 经 `ipcRenderer.invoke` structured clone 时，底层 ArrayBuffer view 关联断裂，main process 收到的是损坏数据。修复：preload 改用标准 `Uint8Array` view（structured clone 标准类型），main process IPC handler 加 `Buffer.isBuffer` 守卫自己转回 Buffer。

## [1.6.2] — 2026-08-11

### 新增
- **zip-uploader 支持三种 zip 结构**：
  - 模式 A（扁平）——`SKILL.md` 在根目录，slug 取 frontmatter.name 转 kebab-case，否则 zip filename 去 `.zip`。修复 macOS 用户 Finder 压缩的 xlsx.zip 场景（之前报"SKILL.md 未找到"）
  - 模式 B（单子目录包裹）——`<slug>/SKILL.md`（向后兼容，slug = 子目录名）
  - 模式 C（多子目录批量）——一个 zip 含多个 `<slug>/SKILL.md`，每个独立安装为一个 skill
- **自动忽略 OS 元数据**：`__MACOSX/` 整目录、`.DS_Store`、`._*`（macOS AppleDouble 资源叉）、`Thumbs.db`、`*.bak`——解压时跳过，不写进 skill 目录
- **批量安装幂等**：模式 C 下每个 skill 独立判断 SHA256（同 hash 跳过，不同 hash 覆盖），返回数组记录全部处理结果

### 改动（Breaking Change）
- **IPC 返回类型 `skill:uploadZip`**：`{ slug, description }` → `UploadedSkill[]`（即使只装 1 个 skill 也返回长度 1 的数组）。协调点：`zip-uploader.ts` / `ipc.handlers.ts` / `preload/index.ts` / `types.d.ts` / `UploadSkillDialog.tsx` 全部对齐
- `filename` 参数现在被使用（之前 `_filename`）：扁平结构时作为 slug 来源
- `UploadSkillDialog` 成功提示：1 个 skill 显示"已安装：slug（desc）"，多个显示"已安装 N 个 skill：a, b, c"

### 修复
- **Fix #1**：macOS 用户 Finder 压缩 zip 含 `__MACOSX/` 元数据导致"SKILL.md 未找到"——扁平结构现在合法支持 + 元数据自动忽略
- **Fix #2**：扁平结构（SKILL.md 在根目录）之前合法但 slug 退化为 `'unnamed'`，现在 frontmatter.name > filename 优先级正确

## [1.6.1] — 2026-08-11

### 修复
- **Layer 3 deltas 首次 spawn 不生效**：`AddToWorkspaceDialog` 在 `setAssignmentDeltas` 成功后未重启 agent，用户在折叠区改的 add/remove 工具不会反映到首次 spawn（agent 已在 `addAgent` 时 spawn，deltas 是后落库的）。修复为：deltas 落库后自动 `stopAgent` + `startAgent`；workspace 已删除则只 stop。
- **builtin marketplace 安装包 `defaultTools` 为空**：`installer.createInlinePackage` 之前写 `defaultTools: []`，导致 marketplace 安装的 builtin agent 落库后 `def.defaultTools` 为空，Layer 3 弹窗显示「默认 0 工具」误导用户。修复为：从 `ALL_BUILTIN_TOOLS` 生成 24 工具的 `[{kind:'builtin', ref}]` 数组，与 Migration v16 builtin YAML 同步策略一致。
- **`defToCapabilities` 重复定义**：`DefinitionEditor` 本地副本与 `capability-helpers` 完全重复，移除本地副本改 import 共享版本。

## [1.6.0] — 2026-08-11

### 新增
- **三层能力配置**：DefinitionEditor 加 Tab + 类别分组 checkbox，编辑 Layer 1 defaultTools / defaultMcps / defaultSkills
- **Layer 3 per-assignment override**：AddToWorkspaceDialog + WorkspaceAgentsPanel「调整能力」按钮（AssignmentCapabilitiesDialog），对 builtin/自定义 agent 做 add+remove delta
- **新建 custom agent 默认"安全最小集"**：read/write/list/edit/grep/glob/todowrite + dispatch-if-main（不再默认全放行）
- **Marketplace 自定义 MCP 入口**：顶部「+ 添加 MCP」（RegisterMcpDialog 表单式注册 name/command/args/env，写入 mcp_definitions 标记 source='custom'）
- **Marketplace 自定义 Skill 入口**：顶部「+ 上传 Skill」（UploadSkillDialog 本地 zip 包上传，解压校验 SKILL.md）
- **自定义资源管理区**：MarketplaceView 底部列出已注册自定义 MCP / 已上传 Skill，可删除
- **CapabilityConfig 增强**：builtin agent 显示「编辑 def」「调整实例能力」两个增强按钮入口

### 修复
- **关键 bug**：`buildSpawnOpts` 把 `mergeCapabilities` 的 `merged.tools` 注入 `RuntimeConfig.allowedTools`——之前完全丢弃导致 permission 层走空数组全放行，所有 agent 实际能用全部 24 个工具，能力白名单形同虚设

### 改动
- **Migration v16**：新增 `agent_assignment_capabilities` 表（Layer 3 deltas：add_tools/remove_tools/add_mcps/remove_mcps/add_skills/remove_skills）；`mcp_definitions` 加 `source`（builtin/custom/marketplace）+ `installed_at` 列
- **builtin default_tools 修复**：Migration 同步 builtin YAML 到 DB（之前 DB 里 builtin def 的 default_tools 为空）；三个 builtin YAML defaultTools 扩展为 24 工具全集（保持 v1.5 行为，升级无感）
- **mergeCapabilities 扩展**：支持 Layer 3 deltas 合并（builtin 全集 + add/remove delta 正确产出 tools/mcps/skills）

## [Unreleased] — v1.2

### v1.2.0 — 主/子 Agent 编排（M3）

#### 新增
- 主/子 agent 编排 UI：Agent 面板"列表/编排"视图切换，树形展示 main→sub 关系
- 添加子 agent / 解除父子关系 / 设为主 agent 三项操作
- AddAgentDialog 角色选择（独立/主/子）+ main 定义子 agent 勾选安装
- AgentList 角色徽标（📋主 / 🔗子 / 🤖独立）+ sub 缩进分组
- assignMain 支持 selectedSubDefIds 选择性安装子 agent

#### 修复
- assignMainAgent 传递 subAgents 给 main 的 spawnAgent（R1）
- auto-start 从 DB 重建 main agent 的 subAgents（R2）
- createFromYaml 解析 parentAgentId slug 为 UUID（R3）
- 删除 main agent 时级联删除其全部 sub agents

### v1.2.1 — 质量打磨（M4）

#### 修复
- keychain slot helper 去重（统一使用 llmApiKeyRef）
- updateAgentDefinition modelBaseUrl NULL 往返保真
- stopRunningInstancesByDefinition 实际停止分支补测
- 协调 agent 设定后自动重启（不再提示手动操作）
- setCoordinator + file CRUD 异常处理一致化
- 文件树折叠状态 localStorage 持久化
- 编排视图 main 节点支持折叠/展开
- assignMain 重复安装守卫
- 编排视图显示孤儿子 agent

#### 变更
- .gitignore 清理裸 docs 条目（docs/ 现可直接 git add）

## [1.1.1] — 2026-07-31

### 新增
- Agent 创建后可编辑（定义层；apiKey 独立更新）
- 文件树折叠修复（根级 + 子目录折叠；刷新/全部折叠工具条）
- 文件 CRUD（新建 / 改名 / 删除 / 移动；走 WorkspaceFS 路径防御）
- 团队群自动调度（主 agent 默认接待非 @ 消息）

### 修复
- 删除 agent 时让 bot 离开所有房间 + 清空悬空 coordinator
- bot 不接受新建房间邀请（owner 检查误拒）
- @候选只含本房成员 + 修复首次启动 @ 失效（运行态同步竞态）
- 自定义群 @agent 可回复（解除 team-room-only 守卫）
- 直接 @ 协调 agent 时不再注入协调引导（消除回复混乱）
- 会话中 bot 显示配置名称而非 Matrix userId
- 全部 IM 组件统一显示 agent 配置名称

## [1.1.0] — 2026-07-31

### 新增
- 会话房间新增 / 重命名 / 自适应解散（本地全员离开清空；团队群受保护）
- 群成员查看（⭐自己 / 🤖bot / 管理 徽标）
- 设置页分类导航（左导航 + 右内容）
- 全局模型供应商注册表（baseUrl + apiKey 入 keychain；创建 agent 时下拉自动填充）
- Agent 创建表单接供应商下拉

## [1.0.0] — 2026-07-28

### 初始发布
- Electron + React + Conduwuit 一体化桌面应用
- Workspace 管理（目录映射 + git init）
- Declarative agent（YAML manifest + LLM chat loop + 工具执行）
- 主子 agent 调度（IM dispatch/task_reply 协议）
- MCP stdio transport（共享进程池）
- Skill 渐进式披露（SKILL.md 三层加载）
- IM（Matrix /sync + Markdown + @mention）
- Marketplace 浏览/搜索/安装
- 安全（WorkspaceFS + sandbox + 审计 + Git policy）
