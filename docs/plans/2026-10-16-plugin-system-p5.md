# 插件系统 P5 实施计划：codegraph 插件本体 + §8 端到端验收闭环

依据：`docs/specs/2026-10-15-plugin-system-design.md` §2.5（codegraph manifest 实例）/ §8（验收用例——设计完成的定义）/ §10 分期。P1-P4 已合并（alpha.19）：安装链、工具扩展点、hooks/service、面板协议、config 表单全部就位。

## 0. 本期交付一句话

**验收锚点闭环**：codegraph 插件（五组件真实实现）注册进真实 App，§8 七场景端到端走通——包括真实 LLM 问「符号被谁调用」调 `plugin:codegraph/explore`（§8.4）与 postToolUse→watcher→面板刷新链（§8.5）。

## 1. 关键设计裁定

### D1 插件位置与形态
- 仓库内 `plugins/codegraph/`（dev 源注册——§8.1 明文「dev 模式注册」；非 fixture，是产品交付物）。
- 纯 Node 自包含，零原生依赖、零外部 CLI 依赖（host 机器的 `.omo/codegraph` 是环境设施，不作插件依赖）。

### D2 索引引擎（lib/indexer.js，tools 与 service 共享同源码两实例）
- **regex-lite 扫描**（无 tree-sitter——插件不得引原生依赖）：符号提取 `function/class/const 箭头/方法`，调用边 = 文件内已知符号调用点（v1 文件级粒度）。
- **explore(symbol)**：定义片段（file:line + 源码摘要）+ 直接调用方（文件+行）+ blast radius（上游传递闭包）。
- **增量**：mtime 缓存逐文件重扫（child 侧工具每次调用增量校验）；上限守卫（≤5000 文件 / 单文件 ≤1MB / 跳过 node_modules、dist、.git、二进制）。
- **双实例语义**（裁定）：工具跑在 child 进程、service 跑在主进程，无 IPC 互通（P3 刻意不设 tool→service 通道）——工具侧按需自扫（本仓 ~1s 级，可接受）；service 侧 watcher 常驻索引。同源码不同实例，索引一致性由同一 lib 保证。

### D3 config 契约（manifest §2.5 扩展两键）
```jsonc
{ "workspaceRoot": { "type": "string", "title": "索引根目录（绝对路径）" },   // required
  "indexCommand":  { "type": "string", "title": "自定义索引命令（可选）" },   // 预留，v1 留空用内置引擎
  "maxFiles":      { "type": "number", "title": "最大索引文件数" } }
```
service 从 `pluginCtx.getConfig().workspaceRoot` 取索引根（同时真实验收 P4 config 表单链）。

### D4 postToolUse → 面板刷新链（§8.5，纯插件内闭环，零宿主改动）
- hooks/postToolUse handler → 把 `{paths}` 写入 `dataDir/reindex-queue.json`（生产者）；
- service fs.watch 自己的 dataDir → 消费队列 → 增量重扫（消费者）；
- panel 订阅 taskCompleted/taskStatusChanged（§6.2 白名单内）+ callService('graph') 刷新。

### D5 panel v1 形态
- 查询框 + SVG 邻域图（目标符号 + 直接调用方/被调方，≤30 节点）+ 统计行（文件/符号/边/最近索引时间）+ 事件驱动刷新。插件自有产物，不受设计系统管辖（与 fixture 面板同性质）。

## 2. 目录结构

```
plugins/codegraph/
├── momo-plugin.json            # id=codegraph 五组件 + config（D3）
├── lib/indexer.js              # 共享索引引擎（CJS）
├── tools/codegraph.js          # explore + status（child 侧，按需增量扫描）
├── service/index.js            # watcher + 队列消费 + graph/stats/reindex/explore RPC
├── hooks/hooks.json + hooks/reindex.js   # postToolUse → 队列生产
├── agents/code-navigator.yaml  # 预配 plugin:codegraph/explore 的导航 agent
├── skills/codegraph-usage/SKILL.md
└── panel/panel.json + panel/index.html
```

## 3. 测试计划（TDD）

| 域 | 文件 | 覆盖 |
|---|---|---|
| 索引引擎 | electron/tests/plugin/codegraph-index.test.ts | 符号提取（function/class/箭头/方法）/调用边/blast radius 传递闭包/mtime 增量/上限守卫/忽略目录 |
| 工具 | electron/tests/plugin/codegraph-tools.test.ts | explore 返回形状（定义+调用方+blast）/status 摘要/未知符号错误路径/空 workspaceRoot 守卫 |
| service+hooks | electron/tests/plugin/codegraph-service.test.ts | createService 形状（start/stop/handle）/队列文件消费→增量重扫/graph RPC 形状/watcher 清理（stopAll 后 fs.watch 关闭） |
| 安装链 | 复用既有（注册走查在验收 T6 覆盖；安装期 config schema/panel.json 校验已由 P4 测试锁） | — |

插件代码无 ts 类型面（插件 JS 域）——测试从 `../../../plugins/codegraph/...` 相对引入（CJS require），不进 tsc 编译面。

## 4. 任务序列（每任务 RED→GREEN→commit）

1. **T1 骨架**：目录 + manifest + 注册走查（dev 注册过 P4 全套校验）
2. **T2 索引引擎**：lib/indexer.js + 单测
3. **T3 工具**：tools/codegraph.js + 单测
4. **T4 service + hooks**：watcher/队列/RPC + 单测
5. **T5 panel + agent + skill**
6. **T6 §8 验收**：隔离 profile 场景 1-3/5-7 + 真实 profile 场景 4（真实 LLM，P2 双轮法纪律）+ 报告
7. **T7 收官**：CHANGELOG + alpha.20 + 全量回归 + oracle 审查 → 修复 → 合并

## 5. 全局约束（沿用）
- momo-test-rules 保真（真实文件系统、AP_USER_DATA_DIR、native require 清缓存）；vitest `--pool=forks`；预存失败域不算。
- 真实 profile 纪律（P2 同款）：eval 仅限被测功能、不截设置/密钥页、evidence chmod 700、测后卸载清理 + 残留披露。
- §8.4 真实 LLM 复用用户工作空间既有 provider 配置（2026-10-15 已授权真实测试）。

## 6. 风险
- regex 索引的误报/漏报（v1 明示近似语义——explore 输出带「近似调用图（regex 扫描）」标注，不做静态分析伪装）。
- 大仓扫描时长：上限守卫 + mtime 增量兜底；首次全量在 service start 后台执行（不阻塞 start）。
- child 侧工具扫描延迟：按需 + 增量；status 工具暴露缓存状态可诊断。
