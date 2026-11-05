# 邮件插件（email）设计 spec

- 日期：2026-11-05
- 状态：已评审（brainstorming 三节设计逐节确认通过）
- 实施仓库：`momo-plugin`（插件本体，`plugins/email/`）+ `moo-studio`（平台 secrets 扩展）
- 依赖平台能力：插件系统七类组件（tools/service/skills/agents/panel）、dev 目录装载流、PanelChannel

## 1. 背景与目标

Momo Studio 需要邮件能力：用户在面板中管理多个邮箱、浏览邮件；agent 经工具集操作邮箱（列表/读取/附件/起草）；预置「邮件助手」agent 承担读邮析信、生成摘要、按要求起草并发送。

### 1.1 需求决策记录（用户逐项确认）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 接入协议与认证 | IMAP + SMTP，仅授权码/应用密码（QQ/163/Gmail 应用密码、Outlook 应用密码等）；OAuth2 不做（未来工作） |
| D2 | 发送门禁 | 保留 agent 发送工具；行为契约强制「用户会话内确认后才能调发送」（三层纵深见 §7） |
| D3 | 摘要触发 | 会话内按需（用户说「总结今天的邮件」即触发）；定时自动推送不做（未来工作） |
| D4 | 附件范围 | 收发都支持：读附件可存工作区（agent 工具路径）；发邮件可挂工作区文件 |
| D5 | 方案选型 | 方案 A：标准全组件插件（service 常驻 + tools + panel + skill + agent）+ 平台一处小扩展（secrets） |

## 2. 总体架构

```
┌─ renderer ────────────────────────────────────────────────┐
│  panel(page)「邮件」三栏 UI ── PanelChannel ── ipc.plugin.callService │
└──────────────────────────────┬─────────────────────────────┘
                               ▼
┌─ main ────────────────────────────────────────────────────┐
│  service（常驻单例）                                        │
│   账号管理(accounts.json + keytar) / IMAP 连接池(imapflow)   │
│   SMTP(nodemailer) / 信封缓存(dataDir JSON) / 草稿状态机      │
│   附件 base64 通道(RPC ≤10MB)                                │
└──────▲─────────────────────────────────────────────────────┘
       │ plugin:callService RPC 桥（子进程 ↔ 主进程）
┌──────┴─────────────────────────────────────────────────────┐
│  agent 子进程 tools（7 个）                                  │
│   6 只读/起草工具 + send_draft；附件落盘经 ToolContext.wsFs    │
│   （变更记账 recordFileChange）                               │
└─────────────────────────────────────────────────────────────┘
```

- 插件为**全局单例**：manifest 无 config（无 workspace-scope 字段）→ service 单实例、账号全局共享，符合「我的邮箱」语义
- 真相源永远是 IMAP 服务器；本地缓存可丢弃重建

### 2.1 插件目录布局（`momo-plugin/plugins/email/`）

```
plugins/email/
├── momo-plugin.json          # id=email；components: tools/service/skills/agents/panel
├── vendor/                   # 依赖内嵌（office-pro 同款）：package.json + node_modules
│   └── (imapflow / nodemailer / mailparser，全纯 JS，零 native ABI 风险)
├── service/
│   └── index.js              # createService：见 §5
├── tools/                    # 一文件一工具（manifest cross-ref 按文件名对账，强制）
│   ├── list_accounts.js
│   ├── list_folders.js
│   ├── list_mails.js
│   ├── read_mail.js
│   ├── save_attachment.js
│   ├── draft_mail.js
│   └── send_draft.js
├── agents/
│   └── email-assistant.yaml  # 预置邮件助手，见 §9.2
├── skills/
│   └── email-ops/SKILL.md    # 邮箱操作方法论，见 §9.1
└── panel/
    ├── panel.json            # [{id: mail, title: 邮件, icon: lucide:mail, location: page, entry: ./index.html}]
    ├── index.html            # 三栏 UI，无构建静态文件（codegraph 模式）
    └── app.js / mail.css
```

## 3. 平台扩展：`PluginServiceCtx.secrets`（moo-studio 侧唯一改动）

`electron/src/main/plugin/service-manager.ts` 的 ctx 组装新增：

```ts
secrets: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

- 实现：keytar，条目命名 `plugin/<id>/secret/<key>`（key 本体限 `[A-Za-z0-9_.:-]`，总长 ≤128）
- 键域分隔符用 `/` 而非 `.`：插件 slug 允许 `.`（宿主 `SLUG_PATTERN = /^[a-z0-9][a-z0-9-._]*$/`），点分隔会让含点插件 id 与其父 id 前缀碰撞——插件 `email.secret` 的键 `plugin.email.secret.secret.account` 会被卸载插件 `email` 时按前缀 `plugin.email.secret.` 误删（跨插件凭据丢失）；`/` 不在 slug 字符集内，域段边界唯一
- 卸载 `keepData=false`：按前缀 `plugin/<id>/secret/` 经 `keytar.findCredentials` 枚举清理插件自管 secrets（与既有 sensitive config 键清理同事务语义）
- 改动面：service-manager.ts ctx 组装 + 类型 + `electron/tests/plugin/service-manager.test.ts` 增例；预计 <100 行
- 无此项则授权码只能明文落 dataDir——安全红线，不可接受

## 4. 数据流（主场景）

**摘要**：用户「总结今天所有邮箱的新邮件」→ agent `list_accounts` → 逐账号 `list_mails(filter: since=今天)` → 挑重点 `read_mail`（200KB 截断）→ LLM 汇总回复。单账号失败不拖全局（聚合结果带 per-account error）。

**代发（含会话确认）**：用户「给 xx 回信说…」→ agent（可先 `read_mail` 取上下文）→ `draft_mail(to, subject, body, attachments[])` → service 生成 RFC822 → IMAP APPEND Drafts + `drafts.json` 登记（pending）→ agent **在会话内展示完整邮件内容并询问「确认发送？」** → 用户回复确认 → agent `send_draft(draft_id)` → service：SMTP 外发 + APPEND Sent + 删 Drafts + 状态 sent → agent 如实报告发送结果。

**面板直发（并行通道）**：panel 草稿箱预览 → 点「发送」→ 同一 `drafts.send` 方法。

## 5. service 设计

### 5.1 存储布局（`dataDir` = 插件数据目录）

| 文件 | 内容 | 边界 |
|---|---|---|
| `accounts.json` | 账号元数据：accountId、email、显示名、imap/smtp host/port/tls 模式、用户名、创建时间、健康状态 | **不含密码**（密码在 keytar，键 `account:<accountId>`） |
| `cache/<accountId>/<folder>.json` | 信封缓存：uid、subject、from、to、date、flags、hasAttachments、size | 每 folder 有界 500 条 FIFO；可丢弃重建 |
| `drafts.json` | 草稿登记：draftId、accountId、状态 pending/sent/discarded、创建时间、收件人摘要 | 24h 过期作废 |
| 正文缓存 | 纯内存 LRU（50 封），不落盘 | 重启后按需重拉 |

### 5.2 方法目录（`handle(method, params)`）

- **accounts**：`list`（脱敏）/ `add` / `update` / `delete` / `test`（IMAP login + SMTP verify；panel 添加账号「测试连接」用，通过才允许保存）
- **mails**：`list`（缓存优先，stale 时 IMAP 拉增量信封）/ `get`（按需拉正文 + mailparser 解析）/ `refresh`（强制刷新）
- **drafts**：`save`（RFC822 生成 + APPEND）/ `list` / `send` / `discard`
- **attachments**：`getContent`（base64，≤10MB 上限）

### 5.3 连接与并发

- 每账号一条 IMAP 长连接（imapflow）：惰性建连 + 空闲 10min 回收；SMTP 即连即关
- 加密强制：IMAP 993 TLS / 143 STARTTLS；SMTP 465 TLS / 587 STARTTLS；**明文模式（无 TLS 也无 STARTTLS 的连接，含裸 25/143）拒绝**（表单校验 + service 双守门）
- 常用预设一键填 host/port（QQ/163/Gmail/Outlook），全字段可自定义

## 6. agent 工具面（7 个，一文件一工具）

| 工具 | 语义 | 关键约束 |
|---|---|---|
| `list_accounts` | 已配置邮箱清单 | 脱敏（无凭据）；带账号健康状态（ok / error+原因） |
| `list_folders` | 账号文件夹树 | special-use 探测 + 中文常用名 fallback（草稿箱/已发送） |
| `list_mails` | 列邮件（分页+过滤） | filter：since / unreadOnly / from / subject 关键词；页大小默认 20 上限 50 |
| `read_mail` | 读单封全文 | text/plain 优先、text/html 降级提取；200KB 截断并标注；附件清单（文件名/大小/partId） |
| `save_attachment` | 附件存工作区 | 经 ToolContext.wsFs 写 + `recordFileChange` 记账；单附件 ≤10MB（RPC base64 通道上限），超限明确报错 |
| `draft_mail` | 起草邮件 | to/cc/subject/body（纯文本）/attachments（工作区相对路径[]，工具侧 wsFs 读取）；总量 ≤25MB；service APPEND Drafts + 登记 pending |
| `send_draft` | 发送已确认草稿 | **仅接受 draft_id**（不可凭空指定收件人）；行为契约见 §7 |

## 7. 发送门禁（三层纵深）

1. **主门禁（行为契约，D2 用户裁定）**：agent YAML system prompt + skill + 工具描述三处强制工作流——`draft_mail` 起草 → 会话内展示完整内容（收件人/主题/正文/附件）→ 明确询问「确认发送？」→ 用户在会话回复确认 → 才调 `send_draft`。跳步调用 = agent 违约（审计可见）
2. **纵深 1：draft_id 强绑定**——`send_draft` 只接受已存在草稿 id，收件人在起草时定型，杜绝绕过起草环节的凭空外发/群发
3. **纵深 2：panel 草稿箱全程可视**——pending 草稿实时可见、可「放弃」；发送审计完整（账号/收件人/draftId/时间）；草稿 24h 过期作废

平台现状无通用插件工具级 HITL 硬门控（授权卡仅覆盖越界文件写）；物理硬门禁列入未来工作（§14）。

## 8. panel 设计（`location: "page"` 主区三栏）

```
┌─────────┬──────────────────┬──────────────────────┐
│ 账号+文件夹│  邮件列表          │  阅读器               │
│ ▣ qq.com │ [搜索框]          │ 头：发件人/收件人/主题/时间 │
│   收件箱 12│ 发件人/主题/时间/未读 │ 正文：纯文本直显；HTML→   │
│   草稿 1  │ 附件标记；分页 20/页 │ 嵌套 sandbox="" 全惰性   │
│   已发送  │                  │ iframe + CSP 拦远程图片  │
│ [+添加账号]│                  │ 附件：清单+大小          │
│          │                  │ 草稿态：[发送] [放弃]     │
└─────────┴──────────────────┴──────────────────────┘
```

- 账号表单：邮箱地址/显示名/IMAP host/port/SMTP host/port/用户名/授权码（不回显）/预设下拉/「测试连接」
- 无构建静态 HTML/JS（codegraph 模式）；PanelChannel：`callService` 交互、`getTheme` 主题跟随、`getContext` 上下文
- 列表数据流：打开 → `mails.list`（缓存秒开）→ 后台 `refresh` 增量；未读数角标
- panel 附件区仅展示清单（沙箱 iframe 无文件系统能力；存工作区走 agent 工具 `save_attachment`，与「专业 agent」定位自洽）

## 9. skill 与 agent

### 9.1 skill（`email-ops/SKILL.md`）

工具语义速查（7 工具参数/返回）；操作方法论（`list_accounts` 定账号 → `list_folders` 定文件夹 → 过滤分页拉列表 → 按需 `read_mail`，忌全量读）；摘要策略（按发件人/主题线索分组、未读与回复链优先、时限词提取）；起草规范（称谓/引用原文/落款）；**发送契约**（draft → 会话展示全文 → 用户明确确认 → `send_draft`，禁止跳步；发送后如实报告）；错误处置表（认证失败→提示检查授权码；文件夹不存在→先 `list_folders`；附件超限→告知用户）。

### 9.2 agent（`agents/email-assistant.yaml`）

- 定位：邮件助手——读邮析信、生成摘要、按要求起草并发送
- `defaultTools`：`plugin:email/*` 七工具全量；`defaultSkills`：`email-ops`
- 模型绑定：宿主 `manifest-parser` 硬性要求 `spec.declarative.model` 块（provider 仅 openai/anthropic），该块仅作「建议位」（解析后 `modelProviderId` 为 null）；真正绑定由 agent-sync 的 `resolveModelBinding` 走全局默认聊天模型（装完即用；无全局默认时 spawn 报错指路资源库配置）。`defaultTools` / `defaultSkills` 必须写在 **spec 层**（parser 与 cross-ref 校验的唯一读取位置）
- system prompt 承载 §7 发送行为契约

## 10. 错误处理

| 场景 | 处置 |
|---|---|
| 账号认证失败 | 账号 state=error（panel 红点 + 原因）；工具返回结构化错误 + 中文指引（授权码过期 / IMAP 服务未开启） |
| 单账号拉取失败 | `list_mails` 聚合时单失败不拖全局：成功账号正常返回 + 失败账号带原因 |
| 网络超时 | IMAP 操作 30s 超时；工具返回超时语义；缓存仍可读（降级体验） |
| 缓存 JSON 损坏 | 丢弃重建（缓存非真相源） |
| 附件超限 | 工具参数校验 + service 双守门（save ≤10MB / 发送总量 ≤25MB），超限明确报错不静默 |
| 发送失败 | 草稿保留不删；SMTP 错误原样透出（退信线索）；panel 显示原因可重试 |
| 正文超大 | `read_mail` 200KB 截断 + 标注「已截断」 |

## 11. 安全清单

- 授权码仅 keytar（`ctx.secrets`）；`accounts.json` / 日志 / 工具返回值全程无明文凭据
- 邮件 HTML 渲染：嵌套 `sandbox=""` 全惰性 iframe + CSP 禁远程资源（防脚本注入与跟踪像素）
- 加密强制：仅 TLS / STARTTLS 连接，明文模式拒绝（双守门，见 §5.3）
- `send_draft` 仅接受已有 draft_id；外发审计完整
- 工具审计沿用平台 `logToolCall`（source='plugin'）

## 12. 测试策略

**momo-plugin 仓库**（vitest 已配）：
- service 单测：账号 CRUD / 缓存有界淘汰 / RFC822 生成 / 草稿状态机与 24h 过期 / 错误映射（mock imapflow/nodemailer/mailparser）
- 工具模块单测：defs schema 合法性 / `save_attachment` 的 wsFs + recordFileChange 调用链 / 附件超限拒绝 / `send_draft` 仅认 draft_id
- manifest cross-ref 通过性（tools 文件名 = 工具短名；defaultSkills 指向存在子目录）

**moo-studio 仓库**：
- `PluginServiceCtx.secrets` 扩展单测（service-manager.test.ts 增例：set/get/delete + 卸载前缀清理）

**验收**（真邮箱手工 + momo-acceptance App 级验收）：
- QQ/163 真账号：加账号（测试连接）→ 列表 → 读信 → 会话摘要 → 起草 → 会话确认发送 → panel 验证 Sent 同步；附件收（存工作区）发（挂工作区文件）各一条

## 13. 交付物与实施边界

| 仓库 | 交付物 |
|---|---|
| `momo-plugin` | `plugins/email/` 全套（manifest + vendor + service + 7 tools + skill + agent + panel）+ 单测 |
| `moo-studio` | `PluginServiceCtx.secrets` 扩展（~100 行 + 单测）+ 本 spec |

不改动：插件系统组件契约、PanelChannel 协议、config schema 机制、权限/授权卡机制。

## 14. 未来工作（v2 候选，均不进本期）

- 定时自动摘要推送（需扩 panel 事件白名单或系统通知面）
- IMAP IDLE 实时新邮件
- OAuth2（Gmail/Outlook 原生认证：provider 应用注册 + token 刷新管理）
- 发送物理硬门禁（平台授权卡机制扩展至插件工具级 HITL）
- panel 附件直接保存到工作区（需平台 panel→workspace 文件通道）
- 正文缓存落盘 / 全文本地检索
