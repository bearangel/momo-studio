# Momo Studio 插件系统设计（v1：自用优先，生态预留）

- 日期：2026-10-15
- 状态：已批准（用户 2026-10-15 逐节确认六节设计：架构总览 / manifest / 工具扩展点 / hooks+service / 面板协议 / 生命周期安全验收）
- 类型：架构新增（plugin 子系统，五期重构后的第一个平台级扩展机制）
- 上游调研：业界插件系统调研报告（MCP / Claude Code / Dify / Cursor / OpenClaw / VS Code / DeepSeek Harness），存 `.omo/reports/plugin-system-survey-2026-10-15.md`（gitignored，60KB，含 permalink 引用）
- 版本：特性合入只动 alpha 号（按 `docs/dev/release.md` 研发期策略）

## 1. 背景与目标

### 1.1 现状与差距

momo-studio 已有「半个插件系统」：三类资源（agent YAML / MCP npx-stdio / skill SKILL.md 三层渐进披露）× 四来源（builtin / marketplace 外链 / custom 导入 / p2p 分享），进程内 `ToolModule` 接口（14 个内置实现），以及成套安全基建（slug 白名单注入防线、sha256、OS 沙箱、变更账本、审计）。

差距：

1. 没有统一插件单元——无法把 agent + skill + MCP + 可执行代码打包分发
2. 无第三方进程内扩展路径——`ToolModule` 只对内置代码开放
3. 无生命周期管理（安装 / 启用 / 禁用 / 更新 / 卸载 / 版本）
4. 无事件钩子（hooks）与 UI 扩展点

### 1.2 意图裁定（用户逐项确认）

| 裁定项 | 结论 |
|---|---|
| 插件受众 | **先自用，留生态余地**——v1 本地开发安装，manifest / 生命周期 / 权限声明按生态标准设计；不建市场、不做审核、API 允许随版本破坏 |
| v1 扩展面 | **四面全做**：新工具（ToolModule）/ UI 面板 / 事件钩子 / 资源包组合 |
| 验收锚点 | **codegraph 插件**（具体插件，钉住优先级防自嗨） |
| 路线 | **方案 C 混合模型**：声明式组件走现有管线 + 进程内 JS 扩展点 + iframe 面板协议；吸收 dsh 三抽象（waterfall 事件分发 / capability seam / 事件溯源不变式）；不采「一切皆插件」 |

### 1.3 调研结论摘要（设计依据）

1. **业界三层共识**：工具层 MCP（已捐 Linux Foundation）+ 知识层 Agent Skills（SKILL.md，agentskills.io 开放标准）+ 自动化层 Hooks（各家自定义）；打包分发层 Claude Code / Cursor 同构（plugin.json + 组件目录 + 自动发现）
2. **无强沙箱先例**：VS Code extension host 也只是「与宿主同权限」；Dify 明确弃强沙箱选签名+审查；dsh（250k stars）进程内 TypeScript 插件且自认「未经安全审计」——「装了即信 + 事后生态加锁」是全行业现实
3. **dsh 三个可抄抽象**：5 种事件分发（含 waterfall 洋葱拦截）、capability seam 三角色强契约、append-only 日志唯一真相（momo 的 `message_events.seq` 已同构）
4. **dsh 两个不抄**：「一切皆插件」（agent loop / session store 可替换 → API 天天破坏、bug 面翻倍）；HMR / vendored 框架 / npm 分发（桌面应用收益低、门槛高）
5. **已死者教训**：ChatGPT Plugins 死于双 spec 摩擦 + 远程部署负担 → 单 manifest + 本地优先
6. **MCP 生态安全危机**（STDIO 注入 / tool poisoning / rug pull）→ 工具命名空间隔离是必做防线

### 1.4 非目标（v1 明确不做）

- HMR 热替换（提供手动「重载插件」动作；安装/启停/卸载本身免重启动态生效）
- npm / registry 分发、momo-hub 市场本体（契约预留）
- 进程级隔离 extension host（业界无先例，自用阶段不值）
- 插件自定义模型 provider
- 插件间依赖解析（manifest `dependencies` 字段预留，v1 只装不解析）
- 声明式面板（YAGNI：codegraph 用例表达不了，砍）
- `messageAppended` 级高频事件（分发成本 > 需求，生态阶段再议）

## 2. 插件单元与 manifest 规范

### 2.1 插件目录结构

```
my-plugin/
├── momo-plugin.json      # 唯一清单（schema 校验）
├── tools/                # 可执行：JS ToolModule（CJS，runtime 子进程）
├── service/index.js      # 可选：主进程长驻服务（见 §5）
├── hooks/hooks.json      # 可执行：事件订阅声明
├── skills/               # 声明式：SKILL.md（现有三层披露管线）
├── agents/               # 声明式：agent YAML（现有 manifest 管线）
├── mcp.json              # 声明式：MCP server 注册（现有 stdio 进程池）
└── panel/                # UI：iframe 面板（见 §6）
```

组件声明 = 根路径：manifest 声明目录则扫描其内部（`skills/<slug>/SKILL.md` 与现有 `listInstalled()` 同构），未声明的目录不可见（显式安全面）。

### 2.2 momo-plugin.json 完整 schema

```jsonc
{
  "$schema": "https://momo-studio.dev/schemas/plugin-v1.json",
  "id": "codegraph",                    // 唯一标识，复用 SLUG_PATTERN 白名单
  "name": "Codegraph 代码图谱",
  "version": "0.1.0",                   // 复用 VERSION_PATTERN
  "description": "…",
  "author": { "name": "…" },
  "minAppVersion": "2.1.0",             // 低于则拒绝安装（v1 就锁，防 dsh 式跟进灾难）

  "components": {
    "tools": "./tools",
    "service": "./service",             // 可选
    "skills": "./skills",
    "agents": "./agents",
    "mcp": "./mcp.json",
    "hooks": "./hooks/hooks.json",
    "panel": "./panel"
  },

  "config": {                           // 用户可填配置（JSON Schema）
    "type": "object",
    "properties": {
      "indexCommand": { "type": "string", "title": "索引构建命令" },
      "apiToken": { "type": "string", "title": "API Token", "sensitive": true }
    }
  },

  "permissions": {                      // v1 只记录 + 设置页展示，不强制执行
    "fs": ["read:workspace"],
    "network": ["*"],
    "subprocess": true
  }
}
```

### 2.3 关键裁定

| 裁定 | 内容 | 依据 |
|---|---|---|
| 工具命名空间 | `plugin:<id>/<toolName>`，与内置工具名物理隔离；agent YAML `defaultTools` 用全名引用 | 防 rug pull 式重名劫持（MCP 生态 P0 攻击） |
| config 敏感值 | `sensitive: true` → keytar 入 keychain（复用现有 API key 通道）；非敏感 → 插件数据目录 JSON | 现有惯例 |
| 变量注入 | `${config.KEY}` 占位符可在 `mcp.json` 的 args/env 与 hooks 配置里替换 | Cursor 验证过的模式 |
| minAppVersion | 安装时硬校验 | 自家 API 允许随版本破坏，不锁必成灾难 |

### 2.4 安装时校验管线（一次性，全部拒绝式）

1. JSON Schema 校验（fail loud，错误带字段路径）
2. `id` / `version` 白名单（复用 `marketplace/types.ts` 的 `SLUG_PATTERN` / `VERSION_PATTERN`，注入防线同源）
3. 路径安全：components 路径必须 `./` 开头、不含 `..`、解析后落在插件根内（Claude Code 踩过的 path traversal，直接抄防线）
4. 组件文件存在性 + 形状校验（skills 有 SKILL.md、tools 模块可 require 且导出形状正确）
5. 交叉引用：agents 里 `defaultSkills` / `defaultTools` 引用的 slug / 工具名必须存在（预置库对齐测试思路前置到安装时）

### 2.5 codegraph 插件 manifest 实例（贯穿全文的验收锚点）

```jsonc
{
  "id": "codegraph",
  "name": "Codegraph 代码图谱",
  "version": "0.1.0",
  "description": "workspace 符号/调用边索引，agent 一查询拿到源码+调用路径+blast radius",
  "components": {
    "tools": "./tools",          // tools/codegraph.js → 注册 plugin:codegraph/explore + /status
    "service": "./service",      // watcher + 增量索引引擎（主进程长驻）
    "agents": "./agents",        // agents/code-navigator.yaml → 预配上述工具的导航 agent
    "skills": "./skills",        // skills/codegraph-usage/SKILL.md → 何时用图谱 vs grep
    "panel": "./panel"           // panel/ → 调用关系可视化面板
  },
  "config": {
    "type": "object",
    "properties": {
      "indexCommand": { "type": "string", "title": "索引构建命令" }
    }
  },
  "permissions": { "fs": ["read:workspace"], "subprocess": true }
}
```

## 3. 架构总览与宿主边界

### 3.1 分层架构

```
┌─ Renderer ─────────────────────────────────────────────┐
│  现有 React UI + PanelHost（新）：iframe 沙箱挂载插件面板 │
└──────────────▲ postMessage 协议（§6）──────────────────┘
┌─ Electron 主进程 ──────────────────────────────────────┐
│  PluginRegistry（新）：清单校验/装配/启停/版本管理        │
│  HookBus（新）：类型化事件总线（§5）                      │
│  PluginServiceHost（新）：插件 service 加载与生命周期      │
│  现有管线不动：agent manifest / skill / MCP / 资源库      │
│  sessions 内核 + message_events 流（插件事件入流）        │
└──────────────▼ 装配 ──────────────────────────────────┘
┌─ Runtime 子进程（现有，WarmPool）──────────────────────┐
│  插件 ToolModule 与内置 14 工具同环境加载执行             │
│  共用全套 ToolContext 治理：沙箱/审计/权限/readTracker   │
└────────────────────────────────────────────────────────┘
```

数据流：安装（目录/zip）→ PluginRegistry 校验 → 声明式组件注册进现有管线、可执行组件登记注册表 → workspace 启用 → agent 工具目录出现插件工具 → 调用时与内置工具同一执行路径。

### 3.2 宿主边界（硬线）

| 层 | 裁定 | 依据 |
|---|---|---|
| agent loop / sessions 内核 / 内置 14 工具 | **不可替换**，电池内置 | dsh 教训：全插件化 = bug 面翻倍 + API 天天破坏 |
| 声明式组件（skill / agent / MCP） | **复用现有管线**，插件只是分发壳 | 不造平行系统 |
| 可执行组件（tools / hooks / service） | **进程内加载，装了即信** | 全行业同档（§1.3-2） |
| 插件事件 | 入审计流水；影响模型可见行为的决策附在工具调用审计上 | 「model-visible = recorded」不变式延伸 |

### 3.3 生效语义（无 HMR 的动态性）

| 场景 | 行为 |
|---|---|
| 安装 / 启用 / 禁用 / 卸载 | 运行时动态生效，新会话立刻看到（或失去），**无需重启** |
| 正在跑的会话 | 按启动时工具快照跑完（现有 spawn 定型语义，天然一致） |
| 开发中改源码 | 「重载插件」动作手动生效（对齐 Claude Code `/reload-plugins`） |

## 4. 工具扩展点（capability seam）

### 4.1 插件工具模块形状

`tools/` 下 CJS 模块导出工厂函数，返回**现有 `ToolModule` 接口**实现（`getDefs` / `getCatalog` / `handles` / `execute`）——扩展点即内置工具接口，不是新发明：

```js
module.exports.createTools = function (pluginCtx) {
  return {
    getDefs() {
      return [{
        name: 'explore',              // 只写短名；注册表强制加 plugin:<id>/ 前缀
        description: '…',
        inputSchema: { … },
      }];
    },
    getCatalog() { /* 一一对应的目录条目，source: 'plugin' */ },
    handles(name) { … },
    async execute(name, args, ctx) {
      // ctx = 内置工具同款 ToolContext：wsFs / permissionConfig / readTracker /
      // abortSignal / sendStreamChunk / taskId / workspaceDir / agentInstanceId…
    },
  };
};
```

`pluginCtx` 是插件专属收窄 API：`getConfig()`（schema 校验后配置）、`getDataDir()`（跨更新持久目录）、`logger`、`callService(method, params)`（§5.4）。**没有** electron API、没有无限定 fs——文件访问走 `ctx.wsFs`（沙箱内）。

### 4.2 注册与装配时机

| 步骤 | 动作 |
|---|---|
| 启用 | PluginRegistry require 模块（绝对路径）→ 前缀校验（拒绝冒充内置名）→ 注册 |
| agent spawn | AGENT_CONFIG 定型时按启用集合并插件工具目录 → **spawn 时快照冻结** |
| 执行 | runtime 子进程 require 插件模块 → 与内置工具同分发路径（`handles()` 路由）→ 同一 ToolContext 注入、审计记账 |
| 禁用/卸载 | 注册表摘除 → 新 spawn 不再含 → 跑着的会话按快照跑完 |

### 4.3 治理等价性（核心承诺）

插件工具与内置工具**同环境、同治理**：沙箱校验、权限配置、Read-before-Edit、审计流水、中断清理、流式进度全部自动适用。唯一区别是来源标记：目录条目 `source: 'plugin'`，审计记录带插件 id。

### 4.4 ToolModule vs 捆绑 MCP 选择指引

| | ToolModule（进程内） | mcp.json（捆绑 MCP） |
|---|---|---|
| 语言 | JS/TS (CJS) | 任意（npx / python / bin） |
| 延迟 | 进程内调用 | 子进程 IPC |
| 治理 | 全套 ToolContext | 现有 MCP 管线（进程池/热重载） |
| 适合 | 低延迟、深集成、本地状态 | 复用现成 server、跨语言 |

## 5. hooks 事件总线与 service 组件

### 5.1 事件目录（v1 共 15 个，刻意收窄）

| 域 | 事件 | 分发模式 |
|---|---|---|
| app | `appReady` | emit |
| workspace | `workspaceOpened` / `workspaceClosed` | emit |
| session | `sessionStarted` / `sessionEnded` | parallel |
| agent loop | `preToolUse` / `postToolUse` / `postToolUseFailure` | **waterfall** / parallel / parallel |
| task | `taskCreated` / `taskStatusChanged` / `taskCompleted` | emit |
| resource/plugin | `resourceInstalled` / `resourceRemoved` / `pluginEnabled` / `pluginDisabled` | emit |

### 5.2 hooks.json 与 handler

```jsonc
{ "hooks": {
    "workspaceOpened": [{ "module": "./hooks/watch.js" }],
    "preToolUse":      [{ "module": "./hooks/guard.js", "matcher": "git_*" }]
}}
```

```js
// handler：主进程进程内 JS（不学 Claude Code 的 shell+jq 地狱）
module.exports.handle = async (event, pluginCtx) => {
  return { action: 'deny', reason: '保护分支' };  // 或 { action: 'rewrite', args } / null
};
```

分发模式由平台按事件固定，插件只订阅：

- **waterfall**（仅 preToolUse）：洋葱式依次过全部订阅者，每层可 deny（短路）或 rewrite args（透传下游）→ 然后进内置权限系统 → 执行。顺序：插件 waterfall → 内置 permissionConfig → execute
- **parallel**：全并发 Promise.all，单订阅者失败不影响其余
- **emit**：fire-and-forget

### 5.3 service 组件（长驻状态的归宿）

工具模块加载在 runtime 子进程，WarmPool K=2 会双份持有长驻状态（内存翻倍、watcher 重复）——长驻状态放主进程 service：

```js
module.exports.createService = (pluginCtx) => ({
  async start() { /* 起 watcher / 引擎 */ },
  async stop()  { /* dispose 纪律：清理干净 */ },
  async handle(method, params) { /* RPC: 'query' / 'status' / … */ },
});
```

- 生命周期：插件启用即 start，禁用 / 卸载 / 应用退出即 stop
- 工具侧调用：`pluginCtx.callService(method, params)` 走**现有内部事件桥**，通道 `plugin:<id>` 命名空间（复用 dispatch / task_reply 的桥，不造新 IPC 面）
- codegraph 分工：service 持 watcher / 引擎保新鲜；工具快路径直读 SQLite 索引（WAL 多读者安全），慢路径 / 写操作走 callService

### 5.4 审计与错误处理

- 每次 hook 调用记录插件 id / 事件 / 决策，入现有审计流水；preToolUse 的 deny / rewrite 附在对应工具调用审计条目
- handler 抛错：该订阅者本次跳过、红字日志，不影响主流程与其他订阅者（preToolUse fail-open + 醒目审计；生态阶段再收紧）
- service 崩溃：callService 拿到错误工具结果；惰性重启（退避），不拖垮主进程

## 6. UI 面板协议

### 6.1 形态（v1 只有 iframe 一种）

- PanelHost（renderer 唯一新增面）：外壳语义 token（设计系统合规），内部 `<iframe sandbox="allow-scripts">`（**无** `allow-same-origin`——插件拿不到宿主 DOM / storage / origin 权限）
- **自定义协议 `momo-plugin://<id>/...`**：protocol handler 天然路径约束（只放行插件安装目录内），origin 隔离（VS Code webview 同款思路）
- 面板元数据 `panel/panel.json`：`{ panels: [{ id, title, icon: "lucide:git-fork", location: "sidebar" }] }`
- v1 挂载点：sidebar + 设置页（插件 config 由宿主按 JSON Schema 自动渲染表单）

### 6.2 postMessage 协议（v1 全集即下表，panel→host 四种 + host→panel 两种，不设扩展机制）

| 方向 | 消息 | 用途 |
|---|---|---|
| panel→host | `ready` | 握手；host 回 theme token 快照（面板配色跟随宿主） |
| panel→host | `app:getContext` | 当前 workspace / session / task 上下文快照 |
| panel→host | `app:subscribe` | 订阅事件（HookBus 目录子集：task / resource / session 域） |
| panel→host | `plugin:callService` | RPC 透传到**本插件** service（同 §5.3 通道） |
| host→panel | `event` / `rpc:result` | 推送与回包 |

硬约束：targetOrigin 严格校验、消息白名单、单条大小上限、频率限流（超限断开通道）。面板**不能**：开外链、跨插件调用、直接碰 IPC。**第三方代码永远不进 React 进程**。

### 6.3 错误处理

iframe 加载失败 → 面板槽红字占位；协议违规 → 丢弃计数、超限断开（面板显示「通道已断开」，宿主无恙）；无 service → rpc 错误回包，面板自行降级。

## 7. 生命周期与安全模型

### 7.1 存储与状态

```
userData/plugins/
├── installed/<id>/<version>/    # 不可变安装目录（更新=新目录+原子切换，旧版即删，单版本驻留）
└── data/<id>/                   # 跨更新持久（service 状态、非敏感 config）
```

DB 两张新表（现有内联 SQL 迁移）：`plugins`（机器级注册表：id / version / manifest_json / state / source）+ `plugin_enablements`（workspace 级启停）。**安装机器级，启用 workspace 级**——与资源库「全局定义、按 workspace 装配」语义同构。

### 7.2 安装来源（v1 两种）

| 来源 | 流程 | 用途 |
|---|---|---|
| dev 目录模式 | 注册表记源路径不拷贝，每次加载直读最新代码 | 插件开发日常：改码→重载 |
| zip 导入 | 临时目录解压 → §2.4 校验管线 → 原子移入 installed | 分发安装（复用现有上传链路） |

更新 = zip 同管线装新版本目录 → 原子切换 → 删旧版；卸载 = stop service → 删注册行 → 删目录 → 弹窗问询是否保留 data。

### 7.3 安全模型（v1 诚实清单）

**信任声明：装了即信。** 进程内 JS = 完整权限（与 dsh / Claude Code hooks 同档），自用阶段接受，生态阶段加签名 / 审查 / 市场策展。

**v1 实际强制**（不靠自觉的部分）：

1. 工具命名空间隔离（无法冒充内置工具）
2. manifest 路径安全（`./` 前缀、拒 `..`、锁插件根内）
3. 面板沙箱（无 same-origin、五消息协议、限流断开）
4. service RPC 仅限本插件 `plugin:<id>` 通道
5. 工具执行全治理（wsFs 沙箱 / 权限 / 审计 / Read-before-Edit）
6. `permissions` 字段记录 + 设置页展示（生态阶段变强制）

## 8. codegraph 插件验收用例（设计完成的定义）

1. dev 模式注册 codegraph → manifest 校验过 → 资源库出现插件卡（tools / agents / skills / panel / service 五组件）
2. workspace 启用 → service start（watcher + 索引构建）→ 侧栏出现图谱面板
3. 启用 `code-navigator` agent（预配 `plugin:codegraph/explore` + codegraph-usage skill）
4. 会话问「X 符号被谁调用」→ agent 调 explore → 拿符号源码 + 调用路径 + blast radius → 审计流水含 `source: plugin:codegraph`
5. agent 改代码 → watcher 增量更新 → 面板图刷新（postToolUse 订阅链）
6. 禁用插件 → 新会话无此工具、面板消失、service stop、watcher 清理干净
7. 改插件源码 → 重载动作 → 新会话用新代码

## 9. 测试计划

| 层 | 内容 |
|---|---|
| 单测 | manifest 校验管线逐拒绝分支；PluginRegistry 状态机；HookBus 三种分发模式各一（waterfall 短路/改写、parallel 隔离、emit）；PanelHost 协议（origin 校验、限流、超限断开）；命名空间强制 |
| 集成 | fake 插件（echo 工具 + hook + service + 面板）走 安装→启用→执行→禁用 全链；spawn 冻结语义（跑动会话不受禁用影响） |
| 回归锁 | ToolContext 注入保真（this 绑定 / ID 透传，按 momo-test-rules 仿真真实语义）；`plugin:<id>` 桥通道生产者-消费者两端契约测试 |
| 验收 | §8 场景走 momo-acceptance（CDP 接管 + 隔离实例，产出 `.omo/qa-reports/` 报告） |
| 守护 | typecheck 双 workspace + 全量测试 + PanelHost 设计系统 lint |

## 10. 实施分期建议（供实施计划细化）

| 期 | 内容 | 交付物 |
|---|---|---|
| P1 | PluginRegistry + manifest 校验 + zip/dev 安装 + 启停 + 资源库 UI 插件卡 | 装得上、管得了 |
| P2 | 工具扩展点（加载 / 命名空间 / AGENT_CONFIG 装配 / 审计标记） | echo 工具插件可被 agent 调用 |
| P3 | HookBus（12 事件 / 三分发模式）+ service 组件 + 内部桥通道 | hooks 与长驻服务可用 |
| P4 | 面板协议（momo-plugin:// 协议 + PanelHost + 五消息 + 设置页 config 表单） | iframe 面板可挂载 |
| P5 | codegraph 插件本体 + §8 端到端验收 | 验收锚点闭环 |

每期独立可交付、可验收；P2-P4 顺序可按实际需要并行调整（P4 仅依赖 P1 的安装目录布局）。

## 11. 决策记录

- D1 路线 = 方案 C 混合模型（vs A 纯打包层不满足四面 / B 全隔离 extension host 业界无先例且自用不值）
- D2 信任模型 = 装了即信 + 强制清单（§7.3），生态阶段再加锁——对齐用户「先自用留余地」裁定
- D3 宿主边界 = 电池内置不可替换（agent loop / sessions / 内置 14 工具）；扩展点只对第三方能力开放（dsh 反例教训）
- D4 工具扩展点 = 复用现有 ToolModule 接口 + 收窄 pluginCtx；不造平行工具协议
- D5 工具命名空间 `plugin:<id>/<tool>` 硬隔离（防 rug pull / 重名劫持）
- D6 长驻状态 = 主进程 service 组件（可选第五组件），RPC 走现有内部事件桥 `plugin:<id>` 通道
- D7 hooks = 主进程进程内 JS handler（不采 shell+jq 模式）；preToolUse waterfall 且 fail-open
- D8 面板 = iframe sandbox 无 same-origin + momo-plugin:// 自定义协议 + 五消息收窄协议；砍声明式面板（YAGNI）
- D9 事件目录 v1 收窄 15 个；`messageAppended` 高频事件明确排除
- D10 安装机器级 + 启用 workspace 级（与资源库语义同构）；单版本驻留；dev 目录模式支持开发迭代
- D11 minAppVersion 安装时硬校验（API 允许破坏 → 必须锁版本）
- D12 分发 v1 = 本地目录 + zip；npm / 市场 / p2p 分享延后（p2p 资源分享协议需扩展插件包类型，生态阶段立项）

## 12. 风险与备注

- **进程内插件的恶意风险**：v1 接受（装了即信）；`permissions` 字段先行记录，生态阶段签名/审查是市场立项的前置
- **插件事件桥通道与现有 dispatch/task_reply 共用基础设施**：实施时须按 momo-boundary-rules 做两端契约测试，防 P0 级契约漂移（历史上 4/8 P0 源于此）
- **WarmPool 与插件模块缓存**：runtime worker require 缓存跨任务复用，重载动作需让 worker 失效缓存（实现细节，实施计划里定）
- **codegraph 索引引擎**：本设计只定义插件如何包装它（service 持引擎、工具直读 SQLite），引擎本体（解析器/增量更新）属插件自含实现，不在本 spec 范围
- **调研报告位置**：`.omo/reports/plugin-system-survey-2026-10-15.md` 为 gitignored 工作产物；本 spec §1.3 已沉淀关键结论，设计不依赖报告文件存续
