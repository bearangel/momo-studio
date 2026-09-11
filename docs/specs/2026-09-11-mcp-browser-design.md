# Spec #5 McpBrowser — Agent 浏览器自动化与实时预览

**版本**：v0.2（brainstorming 复审后重写——方向 A Electron 原生架构 + 单页共享模型 + 8 项硬伤修复）
**日期**：2026-09-11
**状态**：spec approved → plan → SDD

## 0. 背景与动机

Momo Studio 当前 `WebTools` 仅提供 `webfetch`（HTTP 抓取 → Markdown），**无 JS 渲染、无交互、无截图、无登录态**。前端 / UI 工程师使用 agent 编写前端代码时，需要「agent 写完代码 → 用户实时预览」的能力。

v0.1 曾设计为 puppeteer-core 外部 Chromium + BrowserView 嵌入。复审发现该方案存在实现级矛盾（Electron BrowserView 只能渲染 Electron 自带 Chromium，无法显示外部进程输出），且 Electron 30 已废弃 BrowserView。v0.2 改为 **Electron 原生架构**：WebContentsView 承载页面渲染（sidebar 真实像素）、session partition 提供 per-workspace 隔离与跨重启登录态、webContents API + 内建 CDP 子集承载 12 个 agent 工具。零新重依赖。

## 1. 目标与非目标

### 1.1 目标（In Scope）

| ID | 描述 |
|---|---|
| G1 | 12 个 BrowserTools 作为 ToolModule 接入既有工具注册中心（与 v1.5 24 工具同源架构），**不改 ToolContext**（workspaceId 既有字段够用） |
| G2 | per-workspace 浏览器隔离：`session.fromPartition('persist:browser-<workspaceId>')`——cookie/localStorage 隔离且**跨 app 重启持久**（登录态保留） |
| G3 | sidebar = WebContentsView（Electron 原生），主窗口右侧真实像素渲染；可折叠/展开（per-workspace 记忆） |
| G4 | **单页共享模型**：agent 工具与用户操作同一个「当前 page」；takeover 状态机仲裁并发；tabs 为双方共用 |
| G5 | 双预览模式：file://（限定 workspace 目录内）+ http://localhost:dev-server（探活 + agent 从 shell banner 自取） |
| G6 | 信任卡（立即失败 + 重试语义）+ 设置页「浏览器」分类；`browser_evaluate` 单独开关（默认关） |
| G7 | 安全边界：file:// 目录限定 / target=_blank 收编为 tab / 下载一律取消 / webPreferences 硬化（sandbox + 隔离） |
| G8 | 崩溃自愈：`render-process-gone` → reload + 通知；无需外部进程管理 |

### 1.2 非目标（Out of Scope）

- ❌ 外部 Chromium / puppeteer-core（v0.1 方案，已废弃）
- ❌ 截图 OCR；extensions；跨 workspace 共享 browser；agent browser 编排层（`browser_plan` 类）
- ❌ 下载文件保存（v1 一律取消；保存到 workspace 留后续版本）
- ❌ 多浏览器（Firefox/WebKit）；MCP server 模式（我们当 server 让外部客户端连）；远端 MCP client——均独立 spec（v2.8+）
- ❌ sidebar 页面内 DevTools（与 CDP 懒附加互斥，已知边界，见 §3.6）

## 2. 架构（Electron 原生）

### 2.1 分层

```
Renderer（React, ESM）
  ┌────────┬────────────────────────┬───────────────────────┐
  │Activity│ Chat Column            │ BrowserSidebar(chrome)│
  │ Bar    │ (消息/工具卡/截图内嵌)  │ tabs/地址栏/探活/接管   │
  │        │                        │ + 折叠钮 + 视图占位 div │
  └────────┴────────────────────────┴───────────────────────┘
              ↑ IPC (browser:*)        ↑ ResizeObserver 上报占位区 rect
──────────────────────────────────────────────────────────────
Main Process (CommonJS)
  ┌────────────────────────────────────────────────────┐
  │ BrowserTools implements ToolModule（12 工具）       │
  │   信任门 / evaluate 门 / 委托 BrowserManager       │
  └───────────────────────┬────────────────────────────┘
  ┌───────────────────────┴────────────────────────────┐
  │ BrowserManager（per-workspace 视图与状态）          │
  │  - tabs: WebContentsView[]（共用 partition）        │
  │  - takeover 状态机（agent ↔ user）                  │
  │  - selector 解析（注入 JS）+ sendInputEvent         │
  │  - a11y snapshot（debugger 懒附加 CDP）             │
  │  - file:// 限定 / 域名策略 / popup 收编 / 下载取消   │
  │  - workspace 切换：销毁视图 + URL 清单恢复          │
  └───────────────────────┬────────────────────────────┘
                          ↓ WebContentsView (Electron 内建 Chromium)
  BrowserWindow.contentView.addChildView(view)——按占位区 rect setBounds
```

### 2.2 关键不变量

1. **零外部浏览器进程**——页面渲染 = Electron 自带 Chromium 的 WebContentsView；agent 工具与用户看到的是**同一个 webContents**
2. **单页共享**——任一时刻一个「当前 tab」；agent navigate / 用户地址栏输入 / 用户点击页内，都作用于当前 tab；并发由 takeover 状态机仲裁
3. **per-workspace partition**——`persist:browser-<workspaceId>`：cookie/storage 互不串、跨重启保留；视图销毁不销数据
4. **任一时刻只有当前 workspace 的视图存活**（内存有界）；切走销毁 + URL 清单内存恢复
5. **BrowserTools 不改 ToolContext**——workspaceId（既有）+ BrowserManager 单例（boot 注入，同 LspTools ensureManager 模式）
6. **浏览器网络独立于 bash sandbox**——域名黑白名单（§6.2）是浏览器唯一网络策略层；与 v2.4 bwrap/Seatbelt 无耦合
7. **sidebar chrome 属 renderer**（React），页面内容属 main（WebContentsView 叠加）——靠占位区 rect 同步 bounds

## 3. 组件

### 3.1 BrowserManager（`electron/src/main/browser/manager.ts`）

```typescript
/** 主进程单例；boot 时 init(store)；BrowserTools / IPC handlers 共用 */
export class BrowserManager {
  /** workspaceId → 活跃状态（仅当前 workspace 有条目） */
  private active: ActiveWorkspace | null;
  /** workspaceId → 切走时的 tab 清单（内存，app 退出即失；cookie 在 partition 不丢） */
  private stashedTabs: Map<string, { urls: string[]; current: number }>;

  /** 工具入口（12 个，全部先过信任门） */
  navigate(workspaceId, url): Promise<{ url, title }>;
  snapshot(workspaceId): Promise<string>;
  screenshot(workspaceId, filename?): Promise<{ path }>;
  click(workspaceId, selector): Promise<void>;
  type(workspaceId, selector, text, submit?): Promise<void>;
  pressKey(workspaceId, key): Promise<void>;
  hover(workspaceId, selector): Promise<void>;
  scroll(workspaceId, direction, amount?): Promise<void>;
  evaluate(workspaceId, expression): Promise<unknown>;
  consoleMessages(workspaceId): Promise<string[]>;
  tabsAction(workspaceId, action, index?): Promise<TabInfo[]>;
  closeBrowser(workspaceId): Promise<void>;

  /** 生命周期（main index.ts / workspace 切换钩子调用） */
  onWorkspaceActivated(workspaceId, workspaceDir): void;
  onWorkspaceDeactivated(workspaceId): void;
  setSidebarBounds(rect): void;          // renderer 占位区上报
  disposeAll(): void;                     // before-quit
}

interface ActiveWorkspace {
  workspaceId: string;
  workspaceDir: string;
  views: WebContentsView[];              // tabs；partition = persist:browser-<wsId>
  current: number;                       // 当前 tab 下标
  takeover: 'agent' | 'user';
  consoleBuffer: Map<viewSerial, string[]>; // 每 tab 环形缓冲 last 50
  trustGrantedThisSession: boolean;
}

export interface TabInfo { index: number; url: string; title: string }
```

**视图创建硬规则**（每 tab 一致）：

```typescript
new WebContentsView({
  webPreferences: {
    session: session.fromPartition(`persist:browser-${workspaceId}`),
    nodeIntegration: false,   // 硬化：绝不开
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  },
});
view.webContents.setWindowOpenHandler((details) => {
  openTab(details.url);                 // C6：target=_blank 收编为 tab
  return { action: 'deny' };
});
session.on('will-download', (e) => {    // C7：下载一律取消
  e.preventDefault();
  pushNotice('下载已拦截（v1 不支持保存文件）');
});
view.webContents.on('render-process-gone', () => {   // G8
  view.webContents.reload();
  pushNotice('页面渲染进程崩溃，已自动重载');
});
```

### 3.2 takeover 状态机（单页仲裁）

```
                ┌── 用户点「接管」按钮（chrome 显式）
                ├── 用户在地址栏输入 URL 并回车
  agent ────────┼── 用户点击/键盘页内交互（before-input-event 检测）
                └──────────────────────────────→ user
  user ──── 用户点「释放」按钮 ─────────────────→ agent
```

- `agent` 态：工具正常执行
- `user` 态：任一 browser_* 工具立即抛 `BrowserTakenOverError`（信息含「等待用户释放」）
- 切换经 IPC `browser:state`（统一状态推送）广播 sidebar
- v1 不做自动回切（用户显式释放）；agent 收到错误自决等待/改道

### 3.3 selector 引擎（`electron/src/main/browser/selector.ts`）

四种前缀（无前缀 = css）：

| 写法 | 解析方式（注入页内 JS） |
|---|---|
| `.btn-primary` | `document.querySelector` |
| `text=登录` | 遍历元素取 `textContent` 包含匹配（取首个可交互祖先） |
| `xpath=//button[@type="submit"]` | `document.evaluate` |
| `aria/[role="button"][name="提交"]` | role + accessible name 匹配 |

解析结果 = `{ x, y, width, height, description }`（元素中心坐标 + 人读描述）：
- click/hover → `sendInputEvent`（mousePressed/Released/moved，Chromium trusted 事件）
- type → 元素中心 click 聚焦后 `sendInputEvent`（char 事件序列）+ 可选 Enter
- scroll → CDP `Input.dispatchMouseEvent(type:'mouseWheel')`（不需 selector）
- 未命中抛 `BrowserSelectorError`，信息含「已匹配 0 个 + 页面可交互元素前 5 个提示」

**内部 executeJavaScript 不受 evaluate 开关约束**——开关只门 `browser_evaluate` 工具（任意 JS 结果返回给 LLM）；selector 解析是内部固定脚本（返回坐标，不回传任意数据）。此区分写入实现注释。

### 3.4 snapshot（a11y 树，`debugger` 懒附加）

```
调用时：webContents.debugger.attach('1.3')
      → sendCommand('Accessibility.getFullAXTree')
      → 格式化为 selector 提示行
      → detach()（用完即还，避免与用户开 DevTools 长期互斥）
```

输出格式（I3：给 LLM 可直接复制进 click 的提示）：

```
- button "登录"  → text=登录
- textbox "邮箱" placeholder="you@example.com"  → css:[placeholder="you@example.com"]
- link "注册账号"  → text=注册账号
- heading "登录到控制台"
- image "验证码"  → css:img[alt="验证码"]
```

### 3.5 BrowserSidebar（renderer chrome，`renderer/src/components/workspace/BrowserSidebar.tsx`）

- 布局：右侧栏 = **chrome 条（tabs + 地址栏 + 导航 + 探活下拉 + 接管徽标 + 折叠钮）** + **视图占位 div**（WebContentsView 由 main 叠加在此区域）
- 占位区同步：`ResizeObserver` + window resize → `getBoundingClientRect()` → IPC `browser:setSidebarBounds`（main 换算 DPR 后 `view.setBounds`）
- 折叠/展开（I2）：折叠时只留竖条图标按钮；状态 per-workspace 记忆（migration 字段）；折叠时 main 销毁视图（省内存）
- 订阅 `browser:state`（统一推送：tabs / 当前 url+title / takeover / trust 状态）驱动 chrome 渲染

### 3.6 IPC 通道

| 通道 | 方向 | 用途 |
|---|---|---|
| `browser:getState` | r→m | sidebar 挂载时拉全量状态 |
| `browser:userNavigate` | r→m | 地址栏回车（隐式接管，§3.2） |
| `browser:takeover` / `browser:releaseTakeover` | r→m | 显式接管/释放 |
| `browser:openTab` / `browser:closeTab` / `browser:switchTab` | r→m | tabs 管理 |
| `browser:setSidebarBounds` | r→m | 占位区 rect 上报（DPR 换算在 main） |
| `browser:setSidebarCollapsed` | r→m | 折叠态变更（联动视图销毁/重建 + 落库） |
| `browser:answerTrust` | r→m | 信任卡应答（session / always / deny） |
| `browser:listDevServers` | r→m | 探活查询（5173/3000/8080/4200/8000） |
| `browser:state` | m→r | 统一状态推送（tabs/url/title/takeover/trust） |
| `browser:notice` | m→r | 非模态提示（崩溃重载 / 下载拦截 / 权限请求） |

### 3.7 与既有系统的接缝

- **工具注册**：`buildToolRegistry` 加 `new BrowserTools()`（无条件注册；信任门在 execute 内）
- **信任卡**：`browser:notice` 携带 `kind: 'trust-request'`，renderer 弹 SandboxNotice 同款右下角卡
- **dev server**：`bash` 起的 server 在 v2.4 沙箱内跑（沙箱需开网络——既有设置，不改）；浏览器连 localhost 与沙箱无关（C4：无耦合）
- **v2.5 账本**：browser 工具不改文件，不记账；screenshot 落 userData 不入账本
- **审计**：browser_* 全部走既有 tool-call 审计（自动，无特判）

## 4. 工具定义（12 个）

| # | 工具 | 输入 | 输出 | 备注 |
|---|---|---|---|---|
| 1 | `browser_navigate` | `{ url }` | `{ url, title }` | file:// 限 workspace 内（§6.3）；完成后即回，页面加载等待由 loadURL 语义保证 |
| 2 | `browser_snapshot` | - | a11y 行列表（含 selector 提示） | LLM 决策首选；debugger 懒附加 |
| 3 | `browser_screenshot` | `{ filename? }` | `{ path }` | `capturePage` → PNG 落 `<userData>/browser-screenshots/<wsId>/`；renderer 经自定义协议 `browser-shot://` 渲染 |
| 4 | `browser_click` | `{ selector }` | `{ ok }` | §3.3 四种 selector |
| 5 | `browser_type` | `{ selector, text, submit? }` | `{ ok }` | submit=true 末尾补 Enter |
| 6 | `browser_press_key` | `{ key }` | `{ ok }` | Enter/Tab/Escape/PageDown/ArrowUp… |
| 7 | `browser_hover` | `{ selector }` | `{ ok }` | mouseMoved 至元素中心 |
| 8 | `browser_scroll` | `{ direction: 'up'\|'down', amount?: number }` | `{ ok }` | mouseWheel；amount 默认 3 滚轮格（约 300px）；长页阅读高频动作（I4） |
| 9 | `browser_evaluate` | `{ expression }` | JSON 序列化结果 | **设置默认关**（§6.2） |
| 10 | `browser_console_messages` | - | 最近 50 条文本 | 每 tab 环形缓冲 |
| 11 | `browser_tabs` | `{ action: 'list'\|'open'\|'close'\|'switch', index?, url? }` | TabInfo[] | open 携带 url；close 当前 tab 且为唯一 tab 时视同 closeBrowser |
| 12 | `browser_close` | - | `{ ok }` | 销毁当前 workspace 全部视图（partition 数据保留） |

工具描述文案（LLM 视角）明确：navigate 适用于 http(s) 与 workspace 内 file://；阅读长页面用 scroll + snapshot 组合。

## 5. 数据流（关键链路）

### 5.1 agent 调 browser_navigate（核心：用户实时看到）

```
1. LLM tool_use browser_navigate { url: 'http://localhost:5173' }
2. BrowserTools.execute → 信任门 → BrowserManager.navigate(wsId, url)
3. 协议检查：http(s) → 域名策略；file:// → workspace 目录断言（§6.3）
4. current view webContents.loadURL(url)（等待 did-finish-load / did-fail-load）
5. pushState（tabs/url/title）→ renderer chrome 更新地址栏
   （WebContentsView 本身就在渲染——用户已实时看到新页面）
6. 返回 { url, title } 给 agent
```

### 5.2 信任门（C5：立即失败 + 重试）

```
1. 工具入口查 workspace 信任设置
2. 'deny' → throw BrowserDeniedError
3. 'ask' 且本会话未授 → 推 browser:notice(kind:'trust-request') 弹卡
   + throw BrowserNotTrustedError('已请求浏览器权限，请在右下角卡片授权后重试')
4. agent 收到错误 → 文本告知用户/等待 → 用户授权 → agent 重试同工具 → 通过
5. 'always' 或本会话已授 → 放行
```

无 pending Promise、无工具级等待——与 bash strict 拒绝同构。

### 5.3 用户接管与释放

```
接管三入口（§3.2）→ takeover='user' → pushState
  agent 此后任一 browser_* → BrowserTakenOverError（信息含「用户已接管，等待释放」）
释放按钮 → takeover='agent' → pushState → agent 可重试
```

### 5.4 dev server 探活

```
sidebar 探活下拉打开 → IPC browser:listDevServers
→ main 对 [5173,3000,8080,4200,8000] net.connect 试连（~100ms 超时）
→ 返回存活清单 [{port, url}] → 下拉渲染，点击即 userNavigate
```

agent 侧无需代码：bash 输出的 vite banner 由 LLM 阅读后自行 navigate（零实现成本）。

### 5.5 workspace 切换（I1）

```
切走：onWorkspaceDeactivated(wsId)
  → stashedTabs.set(wsId, { urls: tabs.map(url), current })
  → 销毁全部 views（partition 落盘数据不动）
切回：onWorkspaceActivated(wsId)
  → 有 stash：按 urls 重建 views + loadURL + 恢复 current tab
  → 无 stash（首次/重启后）：空状态（地址栏引导）
内存不变量：任一时刻仅当前 workspace 的 views 存活
```

### 5.6 页面崩溃自愈

```
view.webContents 'render-process-gone' → reload() + browser:notice('页面崩溃已重载')
（tab URL 不变；SPA 内存态丢失属正常预期）
```

## 6. 权限与安全

### 6.1 信任模型（C5 语义）

| 设置值 | 行为 |
|---|---|
| `ask`（默认） | 首次调用：弹卡 + **立即失败**（BrowserNotTrustedError）；「本次会话允许」→ 会话内放行；「永久允许」→ 落库 `always`；「取消」→ 保持 ask，本次仍失败 |
| `always` | 直接放行 |
| `deny` | 直接 BrowserDeniedError（含设置指引） |

### 6.2 设置页「浏览器」分类（与「安全沙箱」并列）

```
- 信任级别单选：每次询问（默认）/ 永久允许 / 拒绝
- 域名策略：白名单（空=全放行）/ 黑名单（命中即拒）——浏览器唯一网络策略层（C4）
- browser_evaluate 开关（默认关）
- 侧栏默认宽度 + 默认折叠态
```

### 6.3 file:// 限定（C3，硬安全边界）

- `browser_navigate('file://...')` 与 `browser_tabs open` 的 file:// URL：
  - 解析为绝对路径 → 复用 workspace 目录断言（与 `wsFs.assertInWorkspace` 同源规则：拒 `..` 越界、拒 symlink 逃逸）
  - 越界 → `BrowserFileAccessError('file:// 仅限 workspace 目录内')`
- http(s) 默认放行 localhost（dev server 前提），受 §6.2 域名策略约束
- 其余协议（ftp/about:blank 之外的 chrome:// 等）一律拒绝

### 6.4 其余硬化（C6/C7）

- popup/window.open → `setWindowOpenHandler` deny + 收编新 tab（不产生游离 OS 窗口）
- 下载 → `will-download` preventDefault + notice（v1 不保存文件）
- webPreferences：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true`

## 7. 生命周期

| 事件 | 行为 |
|---|---|
| app boot | `BrowserManager.init(store)`；不预建视图（懒创建，首次 navigate/打开 sidebar 时建） |
| workspace 激活 | `onWorkspaceActivated`：有 stash 恢复 tabs；无则空态 |
| workspace 切走 | `onWorkspaceDeactivated`：stash URL 清单 + 销毁视图 |
| sidebar 折叠 | 销毁视图（等同临时切走；展开按当前 URL 重建） |
| app 退出（before-quit） | `disposeAll`（partition 数据自动落盘，无显式 flush） |
| 页面渲染进程崩溃 | §5.6 reload 自愈 |
| `browser_close` 工具 | 销毁当前 workspace 视图 + 清 stash；下次调用重建 |

无 warm pool、无外部进程管理、无闲置 timer（视图随切换/折叠自然销毁）。

## 8. 错误处理

| 错误 | 类 | agent 可见信息 | UI |
|---|---|---|---|
| 信任未授 | `BrowserNotTrustedError` | `已请求浏览器权限，请在右下角卡片授权后重试` | 信任卡 |
| 信任拒绝 | `BrowserDeniedError` | `浏览器已被设置禁用（设置→浏览器）` | — |
| evaluate 关 | `EvaluateDisabledError` | `browser_evaluate 已被设置禁用` | — |
| 用户接管中 | `BrowserTakenOverError` | `浏览器被用户接管，等待释放后重试` | 🟡 徽标 |
| selector 未命中 | `BrowserSelectorError` | `选择器 "x" 未匹配元素；可交互元素前 5：…` | — |
| file:// 越界 | `BrowserFileAccessError` | `file:// 仅限 workspace 目录内` | — |
| 域名策略命中 | `BrowserDomainBlockedError` | `域名 "x" 被浏览器策略拦截` | — |
| 协议不支持 | `BrowserProtocolError` | `仅支持 http(s) 与 workspace 内 file://` | — |
| 导航失败 | `BrowserNavigationError` | `导航失败: <did-fail-load description>` | — |
| 无活跃视图 | `BrowserNoViewError` | `浏览器未打开（先 browser_navigate）` | — |

错误恢复原则：全部可重试类错误（agent 自决）；需用户介入的（信任/接管）信息中带明确指引。

## 9. 数据存储

migration 034（幂等；**勘误**：v0.2 写作 v32 系猜测——032/033 已被 v2.3/v2.5 占用；且 `workspace_settings` 表在全库从未存在（仅 room_settings/global_settings），故为建表而非加列）：

```sql
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  trust_browser TEXT NOT NULL DEFAULT 'ask',
  browser_evaluate_enabled INTEGER NOT NULL DEFAULT 0,
  browser_domain_blacklist TEXT NOT NULL DEFAULT '[]',
  browser_domain_whitelist TEXT NOT NULL DEFAULT '[]',
  browser_sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
  browser_sidebar_width INTEGER NOT NULL DEFAULT 380
);
```

浏览器 cookie/storage 在 partition 目录（Electron 自管，不入 state.db）。tab 清单仅内存（重启丢失可接受；登录态不丢）。

## 10. 测试策略

**分层事实**（诚实声明）：`electron/` vitest 跑在纯 Node（无 Electron runtime）——**视图/CDP/sendInputEvent 行为不可在该层直接测**。覆盖分三层：

| 层 | 覆盖 | mock 边界 |
|---|---|---|
| 单测（electron/tests/browser/） | 信任门全分支 / 域名策略 / **file:// 限定（含 .. 与 symlink 逃逸用例）** / takeover 状态机 / tab 注册表与 stash-restore / selector 解析器（前缀拆分+转义）/ snapshot 格式化器（fixture JSON→行）/ 错误类信息 / migration 034 | Electron API（WebContentsView/session/debugger）mock 在模块边界；store 真 SQLite |
| e2e（tests/e2e/，Playwright 起 xvfb 真应用） | navigate→页面可见 / click/type 真交互 / snapshot 真输出 / tabs 开关切 / popup 收编 / 下载拦截 / 崩溃重载 / bounds 随窗口 resize 同步 | 全真实 |
| macOS 主机验收 | §12.4 场景（Vue 项目全流程 / 登录态跨重启 / 接管往返） | 全真实 |

接线锁（momo-test-rules）：摘 `browser:state` 推送必红；摘 bounds 上报必红（视图位置漂移）；摘 `setWindowOpenHandler` 必红（popup 用例）；摘 file:// 断言必红（越界用例）。

## 11. 验收标准（DoD）

| # | 验收项 | 层 |
|---|---|---|
| 1 | 12 工具 schema + 路由 + 注册中心接线 | 单测 |
| 2 | 信任门三分支 + 会话授权 + 立即失败语义 | 单测 |
| 3 | file:// workspace 限定（含越界/逃逸） | 单测 |
| 4 | 域名黑白名单 | 单测 |
| 5 | takeover 状态机 + 三入口 + 工具阻塞 | 单测 |
| 6 | tab 注册表 + workspace 切换 stash/restore | 单测 |
| 7 | selector 四语法解析 + 未命中提示 | 单测 |
| 8 | snapshot 格式化（selector 提示行） | 单测 |
| 9 | migration 034 建表六列幂等 | 单测 |
| 10 | IPC 全通道双端类型 + 状态推送 | 单测 |
| 11 | sidebar chrome（tabs/地址栏/探活/接管/折叠）colocated | renderer 单测 |
| 12 | 信任卡 + 设置页分类 | renderer 单测 |
| 13 | navigate→可见 / click→真交互 / popup→tab / 下载拦截 / 崩溃重载 | e2e |
| 14 | bounds resize 同步 | e2e |
| 15 | Vue 项目全流程（agent 写 + dev server + sidebar 实时预览 + hot reload） | macOS 主机 |
| 16 | 登录态跨重启（partition 持久） | macOS 主机 |
| 17 | 接管往返（页内点击自动接管 / 释放恢复） | macOS 主机 |
| 18 | typecheck 双 Done / 双 workspace 全绿 / build exit 0 | 门禁 |
| 19 | README v2.7.0 + engineering.md 浏览器规则节 | docs |

## 12. 迁移与发布

### 12.1 Migration

034 建表（§9 勘误版），幂等；现有 workspace 默认 `ask` 触发信任卡。forward-only 不回滚（对齐 032/033 约定）。

### 12.2 实施任务分组（11 task）

- T1 基础：browser 模块骨架（errors + types + manager 核心：信任门/域名策略/file:// 限定，Electron API 边界注入）
- T2 视图管理：WebContentsView 创建/销毁/tabs/bounds/硬化（setWindowOpenHandler、will-download、render-process-gone）+ workspace 激活切换 stash
- T3 selector 引擎 + sendInputEvent 动作层（click/type/press_key/hover/scroll）
- T4 snapshot：debugger 懒附加 + 格式化器
- T5 BrowserTools 12 工具 defs + 路由 + 注册 + 门控（mock manager）
- T6 migration 034 + settings 读写
- T7 IPC 全通道 + preload + types.d.ts + 统一状态推送
- T8 BrowserSidebar chrome（AddressBar/TabsBar/TakeoverIndicator/DevServerDropdown/折叠/占位上报）
- T9 信任卡 + BrowserSettings 分类页
- T10 workspace 钩子接线（boot init / 切换 / before-quit）+ dev server 探活
- T11 e2e + 四门 + README/engineering.md

### 12.3 已知边界（明示）

- sidebar 页面 DevTools 与 snapshot CDP 附加互斥（懒附加把窗口压到调用瞬间）
- tab 清单重启即失（cookie/登录不丢）；SPA 内存态在切换/崩溃/重载后丢失
- v1 不支持浏览器内下载保存
- `about:blank` 之外的 chrome:// 等特型协议一律拒绝
- 截图经 `browser-shot://` 自定义协议渲染（main 注册 handler 返回文件字节）

### 12.4 主机验收（macOS）

1. Vue 全流程：agent 脚手架 → npm install/dev（沙箱开网）→ agent navigate localhost:5173 → sidebar 实时显示 → 改代码 → hot reload 可见
2. 登录态：sidebar 登录某站 → 重启 app → 重新 navigate → 仍登录（partition 持久）
3. 接管：agent 长任务浏览中，用户点击页内 → 徽标变 🟡 → agent 下次工具报错 → 点释放 → agent 重试通过
4. 信任卡：新 workspace 首调 → 弹卡失败 → 「永久允许」→ 重试通过 → 重启后免弹
5. file:// 安全：agent 尝试 navigate workspace 外 file:// → 明确报错
6. popup：agent 点 target=_blank → 新 tab 出现，无 OS 游离窗口

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| WebContentsView bounds 与 React 布局漂移（DPR/resize 抖动） | 视图错位 | ResizeObserver + window resize 双触发上报；DPR 换算单点在 main；e2e resize 用例 |
| Electron CDP 子集（Accessibility 域）在部分站输出空 | snapshot 无内容 | 格式化器对空树返回「页面无可访问元素，建议 screenshot」；e2e 覆盖真实站点 |
| partition 磁盘累积（每 workspace 一份 profile） | 磁盘占用 | 设置页「清除浏览数据」（调 `session.clearStorageData`）——T9 附带 |
| before-input-event 自动接管误触发（滚轮/拖拽选择） | 频繁误接管 | v1 只把「鼠标按下 + 键盘字符」计为接管信号；纯滚动/移动不触发 |
| dev server 端口探活误报（已占用非 http 服务） | 下拉错误条目 | 试连后补发 HEAD 请求校验（非 2xx/3xx/4xx 不列出） |
| 12 工具 schema 漂移 | 旧 agent 误用 | 工具描述内嵌版本语义；README 记录 |

## 14. 后续路线（v2.8+）

- 下载保存到 workspace（+ v2.5 账本联动）· 浏览器内查找（find-in-page）· 多窗口浮动视图
- 远端 MCP server / client 模式（独立 spec）· screenshot 视觉理解增强

## 15. 参考

- 既有 spec：v2.6 task-resume / v2.4 shell-tools-os-sandbox（沙箱边界——本 spec 与其**无**耦合，§2.2-6）
- 工具模块范式：`electron/src/main/agent/tools/lsp-tools.ts`（单例 manager 注入模式）
- Electron WebContentsView / session partitions / webContents.debugger 官方文档
- v0.1 → v0.2 变更记录：外部 Chromium+puppeteer-core → Electron 原生；双页隔离 → 单页共享+takeover；BrowserView → WebContentsView；+C3/C4/C5/C6/C7/I1/I2/I3/I4 修复（11→12 工具）
