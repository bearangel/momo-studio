# Spec #5 McpBrowser — Agent 浏览器自动化与实时预览

**版本**：v0.1（draft，brainstorming 后落地）
**日期**：2026-09-11
**作者**：brainstorming session
**状态**：brainstorming → spec → plan → SDD

## 0. 背景与动机

Momo Studio 当前 `WebTools` 仅提供 `webfetch`（HTTP 抓取 → Markdown/text/html），**无 JS 渲染、无交互、无截图、无登录态**。前端 / UI 工程师使用 agent 编写前端代码时，需要「agent 写完代码 → 用户实时预览」的能力，这要求：

1. **agent 能驱动真实浏览器**——渲染 SPA、点击登录按钮、提交表单、抓取 dev server 输出
2. **用户能从 app 内看见浏览器**——前端工程师在 agent 写 Vue/React 代码时实时看到效果
3. **登录态与跨调用状态保留**——cookie、localStorage、open tabs 不能每次工具调用都重置

竞品参考：Claude Code Browser MCP（Puppeteer）/ Cline Browser / Cursor Browser。三者形态收敛：①Chromium 子进程 ②per-session 持久化 ③LLM 通过工具调用驱动 ④用户可选接管。本 spec 取其核心，按 Momo Studio 既有 ToolModule 架构与 v2.4 sandbox 边界落地。

## 1. 目标与非目标

### 1.1 目标（In Scope）

| ID | 描述 |
|---|---|
| G1 | 11 个 BrowserTools 作为 ToolModule 接入既有工具注册中心（与 v1.5 24 工具同源架构） |
| G2 | 每个 workspace 一个 Chromium 实例（puppeteer-core），per-session 持久化（cookie/login/tabs 跨 turn 保留） |
| G3 | 主窗口右侧 BrowserView 嵌入真实 Chromium 渲染，用户可直接看到 agent 当前 page |
| G4 | 工具调用与 sidebar 渲染共用同一 Chromium，无状态分裂；tabs 隔离 agent page vs user preview page |
| G5 | 双预览模式：file:// 静态文件 + http://localhost:dev-server（agent 自动跑 vite/npm run dev 后探活） |
| G6 | 首启信任卡 + 设置页「浏览器」分类；`browser_evaluate` 单独开关（默认关） |
| G7 | 与 v2.4 sandbox 接缝明确：dev server 需要网络访问，沙箱默认禁网络，spec 明确两者边界 |
| G8 | chromium crash 自动恢复 + warm pool 消首次启动延迟 |

### 1.2 非目标（Out of Scope）

- ❌ **不做截图 OCR**——LLM 直接看 sidebar 即可（截图仅做存档与 chat 内嵌）
- ❌ **不做 extensions**——无意义
- ❌ **不做跨 workspace 共享 browser**——隔离原则
- ❌ **不做 agent browser tool 编排层**（如 `browser_plan` 等高级工具）——agent 自决
- ❌ **不做下载文件 quarantine**——v2.4 sandbox 已隔离 workspace 文件系统
- ❌ **不做 cross-origin iframe 沙箱**——Chromium 内置同源策略
- ❌ **不做 browser skill 机制**——不抽象层；工具已足够
- ❌ **不做多浏览器支持**（Firefox / WebKit）——agent 场景不需要
- ❌ **不做独立 IPC server 模式**（让 Claude Code / Cursor / Codex 等外部客户端连我们）——独立 spec 范畴（v2.7+）
- ❌ **不做远端 MCP client**（连别人的 MCP server 取工具）——独立 spec 范畴

## 2. 架构

### 2.1 分层

```
Renderer（React, ESM）
  ┌────────┬───────────────────────┬──────────────────────┐
  │Activity│ Chat Column           │ Browser Sidebar      │
  │ Bar    │ (existing, ~65%)      │ (BrowserView, ~35%) │
  │        │                       │ + address bar        │
  │        │  + input box          │ + tabs               │
  │        │  + tool call cards    │ + takeover btn       │
  │        │  + inline screenshots │ + dev server probe   │
  └────────┴───────────────────────┴──────────────────────┘
            ↑ IPC stream           ↑ BrowserView embed (CDP)
─────────────────────────────────────────────────────────────
Main Process (CommonJS)
  ┌──────────────────────────────────────────────────┐
  │ BrowserTools implements ToolModule              │
  │  - getDefs(): 11 LLMToolDef                     │
  │  - execute(name, args, ctx) → BrowserSession    │
  └──────────────────────┬───────────────────────────┘
  ┌──────────────────────┴───────────────────────────┐
  │ BrowserSessionService (per-workspace singleton)  │
  │  - launch / dispose Chromium                    │
  │  - tabs (agent page vs user page)                │
  │  - takeover state machine                        │
  │  - warm pool + idle cleanup                      │
  │  - crash recovery                                │
  └──────────────────────┬───────────────────────────┘
                         ↓ child_process / CDP
  ┌──────────────────────────────────────────────────┐
  │ puppeteer-core  →  Chromium subprocess            │
  │   (one per workspace, ~150MB, headless flag=true) │
  └──────────────────────────────────────────────────┘
```

### 2.2 关键不变量

1. **一个 workspace 一个 Chromium 实例**——不在主进程内（隔离崩溃 + 隔离内存）
2. **agent 工具与 sidebar 共用同一 Chromium**——无状态分裂；agent 操作 → sidebar 自动反映
3. **BrowserView 嵌入主窗口右侧**——sidebar 真实像素渲染（不是 iframe 静态卡片）
4. **BrowserTools 是 ToolModule**——路由进既有 11 个工具的注册中心
5. **ToolContext 扩展可选字段 `browserSession`**——向后兼容旧调用方（未注入时跳过守门）
6. **tabs 隔离 agent / user page**——同一 context 不同 page，互不踩
7. **生命周期绑定 workspace**——workspace 关闭销毁 Chromium（不持久跨 workspace）

## 3. 组件

### 3.1 BrowserTools（`electron/src/main/agent/tools/browser-tools.ts`）

```typescript
export class BrowserTools implements ToolModule {
  getDefs(): LLMToolDef[];          // 11 个
  handles(name: string): boolean;
  async execute(name, args, ctx): Promise<string>;  // 路由到 BrowserSessionService
}
```

- 单实例，注册时调用 `buildToolRegistry(ctx)` 加入
- `execute` 内根据 name 分发到 11 个具体函数
- **不直接持有 BrowserSession 引用**——每次调用通过 ctx 拿（多 workspace 时隔离）
- ToolContext 扩展字段：
  ```typescript
  interface ToolContext {
    // ... 既有字段
    /** v2.7 BrowserTools：当前 workspace 的 browser session handle。可选——未注入时跳过守门 */
    browserSession?: BrowserSessionHandle;
  }
  ```

### 3.2 BrowserSessionService（`electron/src/main/browser/session-service.ts`）

```typescript
class BrowserSessionService {
  private sessions = new Map<workspaceId, BrowserSession>();

  async getOrLaunch(workspaceId: string): Promise<BrowserSession>;
  async dispose(workspaceId: string): Promise<void>;
  async disposeAll(): Promise<void>;  // app lifecycle

  // 工具入口（被 BrowserTools.execute 调用）
  async navigate(workspaceId, url): Promise<{ url, title }>;
  async snapshot(workspaceId): Promise<string>;
  async screenshot(workspaceId, filename?): Promise<{ path }>;
  async click(workspaceId, selector): Promise<void>;
  async type(workspaceId, selector, text, submit?): Promise<void>;
  async pressKey(workspaceId, key): Promise<void>;
  async hover(workspaceId, selector): Promise<void>;
  async evaluate(workspaceId, expression): Promise<unknown>;
  async consoleMessages(workspaceId): Promise<string[]>;
  async tabsAction(workspaceId, action, index?): Promise<TabInfo[]>;
  async close(workspaceId): Promise<void>;
}

class BrowserSession {
  workspaceId: string;
  chromium: ChildProcess;        // puppeteer.launch() 返回
  agentPage: Page;                // agent 工具专用 page
  userPreviewPage: Page;          // user preview page（隔离 agent 操作）
  takeoverState: 'agent' | 'user';
  warmPoolTimer?: NodeJS.Timeout;
}
```

**takeover 状态机**：

```
       user click in BrowserView
   ┌────────────────────────────┐
   ↓                            │
agent ───────────────────────→ user
   ↑                            │
   └────── user clicks release ─┘
```

- `agent` 状态：agent 工具可正常调用
- `user` 状态：agent 工具调用抛 `BrowserTakenOverError`；sidebar 顶栏显示 🟡「用户接管中」+ 「释放」按钮
- 状态变化通过 IPC `browser:takeover-changed` 同步 sidebar
- agent 工具调用期间 user-takeover 切换：当前调用立即 throw，下一次调用正常

### 3.3 BrowserView 嵌入（renderer 侧）

`renderer/src/components/workspace/BrowserSidebar.tsx`：

- 占主窗口右侧 ~35%（Q7 B 锁定）
- 顶部 chrome：tabs / address bar / 导航按钮 / 探活下拉 / takeover 状态徽标
- 内容区：`<webview>` 或 `BrowserView` API（Electron）—— 指向主进程 BrowserSession 的 CDP target
- 探活下拉：监听常见 dev server 端口（5173/3000/8080/4200/8000），活的列出来一键跳转
- screenshot 内嵌：浏览器工具返回 `{ path }` 后，chat 列渲染 `<img src="momo://..." />`

**BrowserView vs iframe 决策**：
- BrowserView：Electron 官方 API，真实 Chromium 渲染；性能好；可绑定 CDP target
- iframe：renderer 进程内嵌，简单但仅能嵌 HTML；无法跨 context 通信
- **采用 BrowserView**——渲染真实 Chromium 是核心价值

### 3.4 IPC 通道

| 通道 | 方向 | 用途 |
|---|---|---|
| `browser:listActiveDevServers` | renderer→main | sidebar 探活查询 |
| `browser:getState` | renderer→main | sidebar 启动时同步状态 |
| `browser:userNavigate` | renderer→main | 用户在 address bar 输入 URL |
| `browser:userTakeover` | renderer→main | 用户主动接管 |
| `browser:releaseTakeover` | renderer→main | 用户释放 |
| `browser:closeTab` | renderer→main | 关闭 tab |
| `browser:takeover-changed` | main→renderer | 状态变化广播 |
| `browser:navigated` | main→renderer | agent 导航完成广播 |
| `browser:urlChanged` | main→renderer | URL/title 实时同步 |

注：**agent 调用 BrowserTools 不走 IPC**——同进程内函数调用；只有 sidebar 主动行为 + 状态广播走 IPC。

## 4. 工具定义（11 个）

### 4.1 工具列表

| # | 工具名 | 输入 schema | 输出 | 备注 |
|---|---|---|---|---|
| 1 | `browser_navigate` | `{ url: string }` | `{ url, title }` | 跳 URL 到 agent page |
| 2 | `browser_snapshot` | - | a11y 树文本（结构化） | LLM 决策首选 |
| 3 | `browser_screenshot` | `{ filename?: string }` | `{ path: string }` | 落 userData，chat 内嵌 |
| 4 | `browser_click` | `{ selector: string }` | `{ ok: true }` | selector 语法见下 |
| 5 | `browser_type` | `{ selector, text, submit?: boolean }` | `{ ok: true }` | submit=true 按 Enter |
| 6 | `browser_press_key` | `{ key: string }` | `{ ok: true }` | Enter/Tab/Escape/ArrowUp 等 |
| 7 | `browser_hover` | `{ selector: string }` | `{ ok: true }` | 触发 hover 菜单 |
| 8 | `browser_evaluate` | `{ expression: string }` | JSON 序列化结果 | **evaluate 设置默认关** |
| 9 | `browser_console_messages` | - | 文本块（last 50 条） | 控制台日志 |
| 10 | `browser_tabs` | `{ action: 'list'\|'open'\|'close'\|'switch', index?: number }` | tab list / `{ ok }` | 多 page 管理 |
| 11 | `browser_close` | - | `{ ok: true }` | 销毁整个 workspace browser |

### 4.2 selector 语法

支持四种前缀（与 puppeteer-core 一致）：
- `css:.btn-primary` — CSS selector（默认，无前缀）
- `text=Login` — 文本匹配
- `xpath://button[@type="submit"]` — XPath
- `aria/[role="button"]` — ARIA selector

无前缀默认按 CSS 解析。错误路径：selector 不匹配抛 `BrowserSelectorError`，含「已匹配元素 0 个」+ 临近元素提示。

### 4.3 snapshot 输出格式（a11y 树）

```
[ref=0] <button> "Login" (primary, role=button)
[ref=1] <input type="email" placeholder="Email">
[ref=2] <input type="password" placeholder="Password">
[ref=3] <a href="/signup"> "Sign up"
[ref=4] <div role="alert"> "Invalid credentials"
```

LLM 可直接按 `[ref=N]` 或文本匹配定位；与 puppeteer-core `page.accessibility.snapshot()` 输出对齐。

## 5. 数据流（关键链路）

### 5.1 agent 调用 browser_navigate

```
1. LLM 决定调用 browser_navigate，tool_use 携带 { url: 'http://localhost:5173' }
2. runtime-entry.executeTool(name, args, ctx)
3. tools registry 路由到 BrowserTools
4. BrowserTools.execute 校验 args → 调 BrowserSessionService.navigate(ctx.workspaceId, url)
5. SessionService.getOrLaunch(workspaceId) → 若无 session，启动 Chromium（~1.5s）
6. session.agentPage.goto(url, { timeout: 20000 })
7. 提取 url + title 返回
8. session 触发 'browser:navigated' IPC 事件（携带 url + title）
9. renderer BrowserSidebar 监听 → 更新 address bar + tabs 状态
10. BrowserView 自动反映（CDP target 同一 page）
11. BrowserTools.execute 返回 `{ url, title }` 给 agent
```

### 5.2 agent 调用 browser_evaluate（evaluate 默认关场景）

```
1. agent tool_use browser_evaluate { expression: 'document.title' }
2. BrowserTools.execute 检查 settings.browserEvaluateEnabled
3. false → throw EvaluateDisabledError('browser_evaluate 已被设置禁用')
4. agent 收到错误消息，自决调整 plan（用 snapshot 替代或要求用户开权限）
```

### 5.3 用户在 sidebar 操作

```
1. 用户在 address bar 输入 http://localhost:5174，按 Enter
2. BrowserSidebar 触发 'browser:userNavigate' IPC
3. SessionService 接 takeoverState = 'user'（标记接管）
4. session.userPreviewPage.goto(url)
5. 触发 'browser:takeover-changed' IPC（state='user'）
6. sidebar chrome 顶栏显示 🟡「用户接管中」+ 「释放」按钮
7. agent 此时调用任何 browser_* 抛 BrowserTakenOverError
8. 用户点「释放」→ takeoverState = 'agent'，广播
```

### 5.4 dev server URL 探活

```
1. agent bash 后台启动 `npm run dev`
2. SessionService 监听端口 5173/3000/8080/4200/8000 变化
3. 5173 端口 accept 连接 → SessionService 标记 dev-server-detected
4. 触发 'browser:devServerDetected' IPC { url: 'http://localhost:5173' }
5. sidebar 探活下拉出现 "http://localhost:5173 (vite)" 选项
6. 用户点击 → SessionService.userPreviewPage.goto(url)
```

agent 也可从 shell 输出解析 URL banner（vite 打印 `➜ Local: http://localhost:5173/`）—— 两条路径互不冲突。

### 5.5 Chromium crash 恢复

```
1. puppeteer-core 'disconnect' 事件触发（chromium 子进程退出）
2. SessionService 标记 session.crashed = true
3. dispose 当前 session 资源
4. 触发 'browser:crashed' IPC 事件
5. renderer 显示右下角通知卡「浏览器已崩溃，正在恢复...」
6. 后台异步 restart Chromium
7. 成功后触发 'browser:recovered' IPC
8. 通知卡消失；session 继续可用；用户当前 tab 已丢失（边界明确）
```

**边界**：crash 恢复不保留用户当前 page state；agent 转录历史不受影响（不入 message_events）。

## 6. 权限模型

### 6.1 首启信任卡（右下角非模态）

- 触发时机：workspace 内首次调用 `browser_*` 任意工具
- UI 与 SandboxNotice / ResumeNotice / UpgradeNotice 同款基建
- 三选项：
  - 「本次会话允许」——本次会话 agent 可用 browser；会话结束失效
  - 「永久允许」——写 `workspace_settings.trust_browser = 'always'`；后续该 workspace 无需再确认
  - 「取消」——抛 `BrowserNotTrustedError`；agent 收到后告知用户

### 6.2 设置页「浏览器」分类

与「安全沙箱」分类并列。结构：

```
分类：浏览器
  - 信任级别（单选）：
      ○ 每次询问（默认）
      ○ 永久允许
      ○ 拒绝
  - 域名策略（白名单/黑名单，参考 webfetch 的 SSRF 防线）
      - 白名单（每行一个域名，留空 = 全部允许）
      - 黑名单（每行一个域名，命中直接拒绝）
  - browser_evaluate 单独开关（默认关）
  - 闲置超时（默认 5 分钟不销毁，可调 aggressive）
  - 按钮：重新连接 / 立即关闭
```

### 6.3 与 v2.4 sandbox 的接缝

dev server 需要网络访问，v2.4 sandbox 默认禁网络。spec 明确：

| 场景 | 沙箱网络 | browser_* 工具 | 说明 |
|---|---|---|---|
| agent bash `npm install` | 需开网络 | 不可用（agent 没起 browser） | 用户在 sandbox 设置中开网络 |
| agent bash `npm run dev`（后台） | 需开网络 | 可用 | dev server 在沙箱内运行 |
| agent browser_navigate('http://localhost:5173') | 需开网络 | 可用 | puppeteer-core 经 sandbox 内 localhost |
| agent browser_navigate('https://github.com') | 需开网络 | 可用 | 走沙箱出网策略 |

**接缝规则**：
- browser_* 工具的网络策略完全跟随 sandbox 设置（不单独管理）
- spec 明确：若 sandbox 禁网，agent 调 `browser_navigate('https://...')` 失败时返回 `BrowserNetworkError('sandbox 网络已禁用')`，错误信息含「设置 → 安全沙箱 → 网络」指引
- spec **不**为 browser_* 单独加 sandbox setting；保持单一网络策略源

## 7. 生命周期

| 事件 | 触发 | 行为 |
|---|---|---|
| workspace 打开 | workspace store 激活 | 异步预热 BrowserSession（warm pool，~500ms） |
| workspace 关闭 | workspace store 切换 / 关闭 | 同步 dispose Chromium（~200ms） |
| workspace 闲置 5 分钟 | timer | 保留 session（cookie/login 不丢）；aggressive 模式可设更短 |
| agent 首次 navigate | session 首次工具调用 | Chromium 启动延迟 ~1.5s（warm pool 已消大头） |
| chromium crash | disconnect 事件 | auto-restart + 通知卡（见 §5.5） |
| app 退出 | before-quit hook | disposeAll 销毁全部 session |
| session 已被关，agent 再次调用 | 任意工具 | 自动 re-launch session；agent 无感 |

### 7.1 Warm Pool 实现

```
workspace 打开时：
  setTimeout 500ms → 异步启动 Chromium（不阻塞 UI）
  启动完成 → 标记 session.warmed = true
agent 首次工具调用：
  session.warmed === true → 立即可用（无启动延迟）
  session.warmed === false → 同步等待启动（最差 ~1.5s）
```

不设「永远 warm」全局池——workspace 是隔离单位，闲置 workspace 的 Chromium 自然释放（5 分钟 timer）。

## 8. 错误处理

| 错误 | 抛出类 | agent 可见消息 | UI 表现 |
|---|---|---|---|
| navigate 超时 | `BrowserTimeoutError` | `browser_navigate 超时（20s）` | sidebar 显示「导航超时」 |
| selector not found | `BrowserSelectorError` | `选择器 "${selector}" 未匹配到元素` | 同上 |
| 域名黑名单命中 | `BrowserBlockedError` | `域名 "${host}" 已被浏览器黑名单拦截` | sidebar 显示「拦截」 |
| evaluate 关闭 | `EvaluateDisabledError` | `browser_evaluate 已被设置禁用` | 无 |
| user-takeover 中 | `BrowserTakenOverError` | `当前浏览器被用户接管，agent 工具被阻塞` | sidebar 显示 🟡 接管状态 |
| chromium crash | `BrowserCrashError` | `浏览器已崩溃，正在恢复...` | 通知卡显示 |
| 网络被沙箱禁 | `BrowserNetworkError` | `sandbox 网络已禁用，请在 设置→安全沙箱 中开启` | 无 |
| session dispose 中 | `BrowserDisposingError` | `浏览器正在关闭，请稍后重试` | sidebar 显示「关闭中」 |
| navigate 非 http(s) | `BrowserProtocolError` | `浏览器仅支持 http(s) 协议` | 无 |

**错误恢复原则**：
- 自动可恢复：timeout / selector miss / crash → agent 重试或自决
- 需用户介入：blocked / evaluate disabled / network disabled → agent 告知用户
- 状态变更：takeover / dispose → 一次性错误，下次调用正常

## 9. 数据存储

不新增数据库表。BrowserSession 完全内存状态（chromium / pages / takeover state），workspace 关闭即销毁。

仅 `workspace_settings` 表新增 4 字段（migration v32）：

```sql
ALTER TABLE workspace_settings ADD COLUMN trust_browser TEXT DEFAULT 'ask';
ALTER TABLE workspace_settings ADD COLUMN browser_evaluate_enabled INTEGER DEFAULT 0;
ALTER TABLE workspace_settings ADD COLUMN browser_domain_blacklist TEXT DEFAULT '[]';  -- JSON array
ALTER TABLE workspace_settings ADD COLUMN browser_domain_whitelist TEXT DEFAULT '[]';  -- JSON array, 空=全部允许
```

迁移 v32：幂等 ALTER TABLE（SQLite 兼容）。不强制重置现有 workspace——`trust_browser` 默认 'ask' 触发首启卡。

## 10. 测试策略

### 10.1 测试覆盖矩阵

| 类别 | 用例 | mock 边界 |
|---|---|---|
| BrowserTools.getDefs | 11 个工具定义齐全 + schema 校验 | 无 |
| BrowserTools.execute 路由 | 11 个工具名分发正确 | BrowserSessionService mock |
| BrowserSessionService | navigate / click / type / snapshot 等 11 个方法 | 真 puppeteer-core + 真 tmp SQLite |
| selector 语法 | css / text= / xpath= / aria/ 四种 | 真 Chromium |
| error path | timeout / selector miss / blocked / disabled / takeover / crash | 触发各 error 路径 |
| ToolContext 扩展 | browserSession 未注入时跳过守门 | 无 |
| IPC 双向 | userNavigate → 状态广播；agent 导航 → sidebar 更新 | IPC mock |
| takeover 状态机 | agent → user → agent 三态切换 + agent 工具阻塞 | BrowserView 嵌入 mock |
| warm pool | workspace 打开 → 预热；首次调用无延迟 | 计时器 mock |
| crash recovery | disconnect → restart → 通知 | disconnect 模拟 |
| Migration v32 | 4 字段新增 + 幂等性 | 真 DB |
| sidebar 组件 | BrowserSidebar 渲染（chrome + tabs + address bar） | BrowserView mock |
| 接线锁 | 摘 sidebar IPC 监听必红；摘 BrowserView 嵌入必红 | 双向变异 |
| e2e | Playwright（root `tests/e2e/`）+ macOS 主机实测 | 真实 |

### 10.2 关键测试纪律

按 momo-test-rules：
- **真实运行时形态**：fixture 必须用真 puppeteer-core + 真 tmp SQLite，不 mock Chromium 行为
- **错误路径专项**：timeout / selector miss / blocked domain / evaluate disabled / user-takeover / crash 必须有专项测试
- **mock 收窄到边界**：mock 收在 BrowserWindow / Electron BrowserView 边界；agent / session / chromium 全部真实
- **接线锁**：摘 sidebar IPC 监听必红；摘 BrowserView 嵌入必红；摘 take-changed 广播必红

## 11. 验收标准（DoD）

| # | 验收项 | 类型 |
|---|---|---|
| 1 | 11 工具 schema + execute 路由 + ToolContext 透传 | 单测 |
| 2 | per-workspace Chromium 启动/销毁生命周期 | 单测 + 集成 |
| 3 | 11 个工具在真 Chromium 跑通（navigate / click / type / snapshot 等） | 集成 |
| 4 | takeover 状态机 + agent 工具阻塞 | 单测 |
| 5 | 首启信任卡 + 三选项 + 设置页同步 | 单测 + 视觉 |
| 6 | evaluate 默认关 + 单独开关 | 单测 |
| 7 | 与 v2.4 sandbox 网络策略接缝 | 集成 |
| 8 | warm pool 预热 + 闲置不销毁 | 单测 |
| 9 | crash recovery + 通知卡 | 集成 |
| 10 | sidebar BrowserView 真实像素渲染 | 视觉 + 集成 |
| 11 | dev server 探活 + address bar + tabs | 集成 |
| 12 | 主机实测：Vue 项目跑通（agent 写 + dev server + preview） | e2e + macOS |
| 13 | typecheck 双 Done；electron/renderer 全绿；build exit 0 | 门禁 |
| 14 | README + engineering.md 条目 | docs |

## 12. 迁移与发布

### 12.1 Migration 顺序

- migration v32：workspace_settings 加 4 字段（幂等）
- 不强制重置；现有 workspace 默认 `trust_browser='ask'` 触发首启卡
- migration v32 失败回滚策略：标准 SQLite 备份 + 重命名

### 12.2 发布步骤

1. 实施 11 task（按 writing-plans 阶段产出）
2. task 1-3：BrowserSessionService + 11 tools + ToolContext 扩展
3. task 4-6：sidebar + BrowserView 嵌入 + IPC
4. task 7-9：信任卡 + 设置页 + evaluate 开关
5. task 10：v2.4 sandbox 接缝 + warm pool + crash recovery
6. task 11：四门验证 + README + engineering.md
7. final review + merge

### 12.3 已知边界（明示）

- session crash 不保留用户当前 page state；agent 转录历史不受影响
- 跨 workspace 不共享 browser（隔离原则）
- 多浏览器支持不做（agent 场景不需要）
- screenshot 落 userData 不入版本控制（路径：`<userData>/browser-screenshots/<workspaceId>/<timestamp>.png`）

### 12.4 主机验收（macOS）

- 前端工程师场景：agent 写 Vue todo app → npm run dev → sidebar 实时显示 → 用户在 sidebar 看到 vite hot reload 效果
- dev server 网络：设置页开启 sandbox 网络后，agent 能 npm install + 启动 vite
- takeover：用户点击 sidebar 中的按钮，agent 下次工具调用抛 BrowserTakenOverError
- 信任卡：清空 workspace_settings 后重启，agent 调 browser_* 触发首启卡
- evaluate：默认调用抛错；设置开启后正常返回结果
- 多 workspace：workspace A 打开 google.com；切换到 B → 互不干扰；切回 A → google.com 仍在

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Chromium 子进程内存大（~150MB） | 长时间使用累积占用 | 闲置超时 + workspace 切换销毁；不预创建全局池 |
| puppeteer-core 版本升级破坏 API | 工具调用失败 | 锁版本；测试覆盖 11 工具 schema 与返回值 |
| BrowserView 与 sandbox 接缝漏 | dev server 跑不通 | spec §6.3 明确；task 10 专项验证 |
| agent 操作与用户操作冲突 | 状态混乱 | takeover 状态机 + 状态指示器 |
| chromium crash 频繁 | 体验差 | auto-restart + 通知卡；crash counter 上报 |
| 11 工具 schema 漂移 | 旧 agent 误用 | 版本号字段（LLMToolDef 加 `version` 字段，可选） |
| sidebar 嵌入与 Chat 列抢空间 | 1080p 屏局促 | 设置中可调 sidebar 宽度（min 280 / max 600 / default 380） |

## 14. 后续路线（v2.7+）

- 远端 MCP server 模式（让 Claude Code / Cursor / Codex 连我们）—— 独立 spec
- 远端 MCP client（连别人的 MCP server）—— 独立 spec
- screenshot OCR（视觉理解增强）—— 若 LLM 需要
- browser skill 机制（高层抽象任务）—— 若有需求

## 15. 参考

- 既有 spec：`docs/specs/2026-09-10-task-resume-design.md`（v2.6 任务断点续跑）
- v2.4 sandbox：`docs/specs/2026-09-10-shell-tools-os-sandbox-design.md`
- 既有工具实现参考：`electron/src/main/agent/tools/lsp-tools.ts`（条件注册 + ToolModule）
- ToolContext 定义：`electron/src/main/agent/tools/types.ts`
- puppeteer-core 文档：`https://pptr.dev/`
- Electron BrowserView：`https://www.electronjs.org/docs/latest/api/browser-view`
