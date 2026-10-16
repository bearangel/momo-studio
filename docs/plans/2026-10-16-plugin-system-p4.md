# 插件系统 P4 实施计划：面板协议 + 设置页 config 表单

依据：`docs/specs/2026-10-15-plugin-system-design.md` §6（面板协议）/ §2.2（config schema）/ §5.4（审计）/ §10 分期；P3 审查 minor M1-M3 清扫一并入本期。

前置：P1-P3 已合并 main（alpha.18）。本期不动迁移（无新表；config 走文件 + keytar，panel.json 走盘上文件）。

## 0. 本期交付一句话

**iframe 面板可挂载**：插件声明 `panel` 组件 → 活动栏出现插件图标 → 侧栏渲染 PanelHost（沙箱 iframe）→ 五消息协议双向通；设置页「插件」分区按 JSON Schema 渲染 config 表单（敏感值进 keychain，非敏感进数据目录 JSON，`${config.KEY}` 注入 mcp args/env）；M1-M3 minor 清扫。

## 1. 关键设计裁定（逐项）

### D1 momo-plugin:// 自定义协议（主进程）
- 复刻 `browser/protocol.ts` 模式：新建 `electron/src/main/plugin/protocol.ts`，`ProtocolLike` 结构性注入（单测零 Electron import）。
- scheme `momo-plugin` 进 `index.ts` L63 `registerSchemesAsPrivileged`（`{ standard: true }`——standard 使 `momo-plugin://<id>/...` 的 origin = `momo-plugin://<id>`，插件间天然 origin 隔离，postMessage targetOrigin 严格校验依赖此）。
- handler：`url.host` = pluginId（注册表查当前版本定根：zip → installed/<id>/<ver>，dev → sourcePath）；pathname 逐段清洗（拒 `..`/反斜杠/绝对段，同 browser safeSegments）+ resolve 落根双重锚定；仅 GET；mime 最小映射（html/js/mjs/css/svg/png/json/ico/map → 其余 octet-stream）；404/403 语义 Response。数据目录（plugins/data）不在任何 servable 根内——敏感 config 天然不可达。
- 注册位置：index.ts whenReady 内（L86 reactivatePluginsOnBoot 附近）。

### D2 panel.json 契约与加载（主进程）
- 形状（v1 全集，多收拒绝）：
```jsonc
{ "panels": [ { "id": "graph", "title": "代码图谱", "icon": "lucide:git-fork", "location": "sidebar", "entry": "./index.html" } ] }
```
- `panel/panel.json` 在安装/重载时读取校验（新 `plugin/panel-sync.ts`）：panels 非空数组 ≤4 项；id slug、title 非空、icon 可选（须 `lucide:` 前缀，缺省 `lucide:puzzle`）、location v1 仅 `sidebar`、entry 相对路径 + 越界防御 + 文件存在。校验失败 → 安装拒绝（同 manifest 管线拒绝式）；重载失败 → 该插件面板下线 + warn（不炸重载）。
- 面板 URL：`momo-plugin://<pluginId>/<panelId>/`（handler 内 panelId→entry 映射在 panel-sync 提供：URL 第一段匹配 panel.id 时重写到 entry 文件）。v1 简化：iframe src 直接用 `momo-plugin://<pluginId>/<entry 相对 panel 根的路径>`，panelId 仅作 UI key——**不需要 URL 重写层**（裁定：entry 路径即 URL，少一层映射少一类 bug）。
- 暴露：新 IPC `plugin:listPanels(workspaceId)` → `[{ pluginId, panelId, title, icon, entryUrl }]`（只含 workspace 已启用插件，§8.6 禁用即消失的判定点）；安装/卸载/重载/setEnabled 后 `webContents.send('plugin:panelsChanged')` 推 renderer 刷新。

### D3 PanelHost 与侧栏挂载（renderer）
- **挂载形态裁定**：面板 = 侧栏槽内容（非独立主区视图）。活动栏在主项与设置之间加分隔线 + 插件面板图标（icon 映射 lucide，tooltip = title）；点击进入「面板模式」：`ui.store` 新增 `activePluginPanel: string | null`（key = `pluginId/panelId`），`ViewSidebar` 检测到面板模式渲染 `<PanelHost>`（替换侧栏内容），主区不动（同 files/tasks 侧栏语义）。再点同一图标或 Esc → 退出面板模式回原视图。空列表（无已启用面板）→ 活动栏不出现插件区。
- PanelHost 外壳：header（icon + title + 状态 badge）+ iframe 区。iframe 属性 `sandbox="allow-scripts"`（**无** allow-same-origin）+ `src=momo-plugin://...`。设计系统：外壳 bg-surface-1、header 13px、错误态 status-error + tint（预览定稿）。
- 三态：loading（Spinner）→ 正常；加载失败（iframe load error → 红字占位 + 重试按钮）；通道断开（协议违规超限 → 「通道已断开」+ 重新连接按钮 → 重挂 iframe）。§6.3 全覆盖。

### D4 postMessage 五消息协议（renderer `PanelChannel`）
- 出站（host→iframe）：`event.source === iframe.contentWindow` **且** `event.origin === momo-plugin://<pluginId>` 双校验；消息类型白名单（ready / app:getContext / app:subscribe / plugin:callService）；单条 ≤256KB；令牌桶限流 20 条/s（超限计数，违规 ≥3 → 断开通道：摘监听 + 卸 iframe + 断开态）。
- 入站（iframe→host）：`targetOrigin` 恒 `momo-plugin://<pluginId>`（协议违规即丢）。
- 五消息语义：
  - `ready`（可带 id）→ host 回 `rpc:result`（id 配对）携主题快照 `{ theme: 'light'|'dark', tokens: {...css 变量换算值} }`（§6.2 面板配色跟随宿主）；后续主题切换再推 `event: theme`。
  - `app:getContext`（id）→ rpc:result `{ workspaceId, workspaceName, sessionId? }`（renderer stores 现值）。
  - `app:subscribe`（id, events[]）→ 白名单子集（taskCreated/StatusChanged/Completed、resourceInstalled/Removed、sessionStarted/Ended）外的拒绝；host 侧记订阅集，事件到达转发 `event` 消息。
  - `plugin:callService`（id, method, params）→ IPC invoke → 主进程 `callPluginService(pluginId, ...)`——**pluginId 由通道构造绑定，不取自消息**（面板只能调本插件 service，§7.3-4）；无 service → rpc:result error 回包，面板自行降级。
  - host→panel 推送统一 `{ type: 'event', event, payload }` / 回包 `{ type: 'rpc:result', id, result? , error? }`，v1 不设扩展机制（§6.2）。
- 事件供给链：主进程 HookBus → 新 preload 事件面 `plugin.onPanelEvent(cb)`（`webContents.send('plugin:panelEvent', ...)`，preload 显式通道 allowlist，不开通用 on）→ PanelChannel 过滤订阅集转发 iframe。

### D5 config 存储（主进程 `plugin/config-store.ts`）
- 收敛 P3 三份 readConfig（hook-sync/service-manager/assembly）到 config-store 单实现。
- 双轨：非敏感 → `<dataDir>/config.json`（原子写：tmp+rename）；敏感（schema 属性 `sensitive: true`）→ keytar `plugin.<id>.config.<KEY>`（照 providerApiKeyRef 命名惯例）。
- 敏感值进主进程内存缓存 `pluginConfigCache[id]`（写入时更新；boot/安装/重载/启用时异步预热）——同步消费者（pluginCtx.getConfig / service ctx）读 config.json + 缓存 overlay，keytar 异步性被激活边界吸收。裁定依据：装了即信信任模型（D2），主进程持密可接受；renderer **永不明文可见**（表单只显「已配置/未配置」）。
- Schema 校验（写入时，拒绝式）：manifest.config 形状校验（type=object、properties 键 slug、每属性 type ∈ {string,number,boolean} + title/sensitive/enum 可选——超出 v1 子集拒绝）；setConfig 逐值类型校验 + required 齐备 + 未知键拒绝。

### D6 IPC 扩展（plugin 命名空间四通道 + 两推送）
- `plugin:getConfig(id)` → `{ schema, values（非敏感明文）, sensitiveConfigured: Record<KEY, boolean> }`（表单渲染全输入）。
- `plugin:setConfig(id, values)` → 校验 → 双轨写 → 缓存更新 → **联动**：重跑 `syncPluginMcps`（换 mcp args/env）+ 运行中 service 重启（拿新 config）。
- `plugin:listPanels(workspaceId)` / `plugin:callService(pluginId, method, params)`（面板 RPC 主进程侧，直调 service-manager 现函数）。
- 推送：`plugin:panelsChanged` / `plugin:panelEvent`。preload 三处同步（preload/index.ts + types.d.ts PluginApiSurface + client）——**改 IPC 双 workspace typecheck** 红线。

### D7 ${config.KEY} 注入
- 唯一注入面：mcp-sync `toConfig` args/env 逐 string 做 `${config.KEY}` 展开（config = config-store 全量含敏感）。缺失键 → 保留字面量 + warn（可观察，不静默吞）。hooks/tools 无用户值面，不注入（pluginCtx.getConfig 程序化读取已覆盖）。

### D8 M1-M3 minor 清扫
- M1：workspaceOpened payload 加 `reason: 'created' | 'switched'`（向后兼容可选字段）+ event-sources 注释。
- M2：终态双发（taskStatusChanged + taskCompleted）在 hook-sync 事件目录注释 + spec §5.1 补一行说明（文档化裁定，不改行为）。
- M3：`enforceHookCallsQuota()`（audit/quota.ts 旁，行数上限 50k、批量删最旧、滞回 95%）挂 `wireHookBridgeAudit` 观察者 INSERT 后计数触发（每 500 次一巡，照 AUDIT_ENFORCE_INTERVAL 模式）。

## 2. 测试计划（TDD，RED 先行）

| 域 | 文件 | 覆盖 |
|---|---|---|
| 协议 | electron/tests/plugin/protocol.test.ts | 合法文件服务/穿越拒绝/跨插件 id 拒绝/非 GET 拒绝/mime/404/dev 目录根/数据目录不可达 |
| panel 契约 | tests/plugin/panel-sync.test.ts | panel.json 校验矩阵（拒绝式）/listPanels 启用过滤/panelsChanged 推送时机 |
| 通道 | renderer/src/components/plugins/PanelChannel.test.ts | origin+source 双校验/白名单/大小上限/限流断开/rpc id 配对/targetOrigin 严格 |
| 挂载 | renderer/src/components/plugins/PanelHost.test.tsx + stores 测试 | 三态渲染/面板模式进出/空列表无图标/Esc 退出 |
| config | tests/plugin/config-store.test.ts | Schema 校验矩阵/敏感拆分（setKeychainImpl 注入 mock）/缓存 overlay/原子写/getConfig 不泄敏感 |
| 注入 | tests/plugin/mcp-config-substitution.test.ts | args/env 展开/缺失键保留字面量/敏感值经 keytar 路径生效 |
| IPC | tests/plugin/ipc-config.test.ts | getConfig/setConfig 往返/setConfig 联动重同步 mcp + service 重启/callService 面板通道 |
| 配额 | tests/plugin/hook-calls-quota.test.ts | 超限删最旧/滞回/计数触发 |
| UI 表单 | renderer/src/components/settings/PluginSettings.test.tsx | schema→控件映射/sensitive 掩码态/必填校验/保存调用 |
| 冒烟 | .omo/qa-reports/…-plugin-p4-smoke/ | fixture v0.4.0（+panel +config）真实 App：面板挂载/五消息/表单落盘/注入进 mcp_definitions/禁用面板消失 |

## 3. 任务序列（每任务 RED→GREEN→commit）

1. **T1 协议层**：protocol.ts + registerSchemesAsPrivileged + whenReady 注册 + 测试
2. **T2 panel 契约**：panel-sync.ts（校验 + listPanels + panelsChanged 推送）+ 测试
3. **T3 PanelChannel**：renderer 通道类（校验/限流/断开/rpc 配对）+ 测试
4. **T4 PanelHost + 挂载**：组件三态 + ui.store activePluginPanel + ActivityBar/ViewSidebar 接线 + 测试
5. **T5 config-store**：收敛 readConfig + 双轨写 + 缓存 + 测试
6. **T6 IPC + 注入**：四通道两推送 + mcp 替换 + setConfig 联动 + 测试
7. **T7 设置页表单**：PluginSettings.tsx + SettingsNav 分区 + 测试
8. **T8 minor 清扫**：M1 reason 字段 + M2 注释/spec 行 + M3 hook_calls 配额 + 测试
9. **T9 fixture v0.4.0 + 真实冒烟**：面板 HTML（ready/getContext/订阅展示）+ config schema + mcp ${} → 隔离实例走查 + 报告
10. **T10 收官**：CHANGELOG + alpha 19 + 全量回归（插件域逐文件 + agent 域 4 文件 + typecheck）

## 4. 全局约束（沿用 P2/P3）
- TypeScript strict 禁 any/@ts-ignore；UI 只用语义 token（ESLint 机械强制）；lucide 16/1.75。
- 测试 beforeEach 设 `AP_USER_DATA_DIR`；native require 用后清缓存；every commit Conventional + Sisyphus trailer。
- 预存失败域不修不算（marketplace/events-pruning/sessions-repo/builtin-office/hub-install/sandbox/全量 SIGSEGV）。
- UI 实现前静态预览门禁：`.omo/previews/plugin-p4-panels.html`（真实 token、明暗双主题、面板三态 + config 表单、中文 mock 数据）——**用户确认后才动 renderer 代码**。

## 5. 风险
- iframe 内 postMessage 在 sandbox 无 same-origin 下的 origin 值：Chromium 对自定义 standard scheme 的 iframe origin = scheme://host（预期成立；T3 以真实 Electron 冒烟验证，单测层用常量注入解耦）。
- panel 静态资源带 ES module：sandbox iframe 允许 module script（allow-scripts 足够）；momo-plugin 无 CORS 头需求（同 origin 自身）。T1 mime 覆盖 .mjs。
- 活动栏插件区溢出（≤4 面板/插件 × N 插件）：v1 上限自然受 manifest 校验约束（每插件 ≤4），图标区纵向滚动兜底（ActivityBar 已 overflow-auto）。
