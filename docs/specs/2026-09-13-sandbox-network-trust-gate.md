# 沙箱网络出站信任门（三态策略 + 阻塞式询问）设计

日期：2026-09-13 ｜ 状态：已裁定（用户选 A 阻塞式）｜ 前置：v2.4.x 沙箱七连修（e74fc30..ad14e2f）

## 1. 背景

现行网络开关是布尔量（`SandboxInfo.networkEnabled`，kv `sandboxNetwork`，默认 false）：关 = agent 命令被 seatbelt/bwrap 拒绝后自诊报告（net-off tag + 一次性 netOff 通知卡），开 = `(allow network*)` 全放行。用户裁定：升级为浏览器工具同款信任级别模型，且采用**阻塞式**（方案 A）——命令命中网络拒绝后，agent 环路阻塞等待用户裁定，允许后同任务内无缝继续。

## 2. 目标

| 级别 | 行为 |
|---|---|
| **每次询问**（`ask`，默认） | profile 按 net-off 生成；命令完成时命中「net-off tag + 网络拒绝签名」→ 弹信任卡阻塞（≤180s）→ 三选一 |
| **永久允许**（`allow`） | 全部 spawn net-on，毸不询问 |
| **拒绝**（`deny`） | 全部 net-off；保留现有一次性 netOff 信息卡，不升级询问 |

信任卡三按钮（镜像浏览器 `answerTrust` 语义）：
- **允许本次任务**（`session`）：该 streamSessionId 后续 spawn net-on；任务结束即失效
- **永久允许**（`always`）：持久化 kv + 本任务即刻生效
- **保持拒绝**（`deny`）：本任务内不再询问（等效 deny 级）；不持久化

## 3. 非目标

- 域名白名单（seatbelt/bwrap 皆 syscall 级，做不了；需代理层，另立 spec）
- 允许后**不自动重跑**已失败命令（副作用安全：防 POST 双发等）；在失败结果尾部追加提示让 LLM 自行重试
- 跨任务记忆 session 授权（session 严格随 streamSessionId 生命周期）

## 4. 数据模型与迁移

`electron/src/main/sandbox/settings.ts`：

```ts
networkPolicy: 'deny' | 'ask' | 'allow'   // 取代 networkEnabled
```

- kv 迁移：读旧键 `sandboxNetwork`（true→`allow`，false/缺省→`ask`）→ 写新键 `sandboxNetworkPolicy`，旧键留存不删（回滚安全）
- 写入路径：设置面板三态控件 → IPC；`always` 点击亦走同一持久化
- `SandboxInfo`（`sandbox:getState` 产物）暴露 `networkPolicy` 供渲染端分支

## 5. 主进程策略与执行钩子

**有效策略解析**（spawn 时逐条求值，单点函数）：

```
effectiveNetwork(taskKey) = sessionGrants.get(taskKey) ?? settings.networkPolicy
// 'granted' → net-on；'denied' → net-off；无 → 落到 settings 三态
```

- `sessionGrants: Map<streamSessionId, 'granted' | 'denied'>`，由 agent-runner 活跃任务表生命周期注册/清理（任务终态即删）
- `resolveShellSpawn`（`agent/tools/shell-tools.ts`，netTag 生产者）读 effective 策略决定 profile 与 tag——**唯一改动点**，各平台 profile builder 继续收布尔值

**阻塞询问钩子**（命令完成路径，同文件）：

触发条件（全部满足）：策略解析为 `ask` 且无 session grant；结果 tag 为 net-off；输出命中网络拒绝签名（主进程侧复刻 `renderer/src/stores/stream.store.ts:30` 双条件判定——tag 正则 + 网络失败签名，实现时对齐其正则）。

协议（复用浏览器信任门 Fix 5 全部语义，参照 `browser/policy.ts` resolveTrustWait）：
1. 单飞：同 streamSessionId 并发命中只发一张卡，后续命令同样阻塞挂起等同一裁决
2. 推送 prompt → renderer 弹卡；agent 环路 `await`（`NETWORK_TRUST_TIMEOUT_MS = 180_000`，时钟可注入）
3. `session`/`always` → grants 置 `granted`（`always` 另持久化）；**在已失败命令的 tool result 尾部追加提示**：「沙箱网络已获用户批准，本任务后续命令可用网络，可重试」；唤醒全部挂起者
4. `deny` → grants 置 `denied`，失败结果原样返回（LLM 自诊）
5. 超时 → 等效 `deny`（置 `denied`，失败结果原样返回，任务继续跑）
6. 迟到点击对齐浏览器语义（真机教训 2026-09-13 修订：原「整体丢弃」在真机上翻车——窗口后台化致 renderer 倒计时停摆、卡片滞留，用户补点「永久允许」被静默吞掉，后续会话永久 net-off 且不再询问）：迟到应答不整体丢弃，只收窄副作用边界——`always` 迟到 → **持久化照做**（下一任务起 net-on；本任务已按超时 deny 收敛不复活——已失败命令不重跑、无「用户批准」追加提示）；`deny` 迟到 → 无操作（超时已等效 deny）；`session` 迟到 → 无操作（无法追认已收敛的等待）。全路径记 in-time/late × answer 诊断日志。渲染端卡片消散由其自身点击成功 / 倒计时归零路径处理，无需主进程回推撤卡。与浏览器信任门（`browser/policy.ts` 迟到点击 = 为下一次调用授权）语义对齐。

IPC：`sandbox:answerNetworkTrust(answer: 'session'|'always'|'deny')`（镜像 `browser:answerTrust`），prompt 推送通道镜像浏览器信任卡通道。

## 6. 渲染端

- **SandboxSettingsPanel**：布尔开关 → 三态分段控件（拒绝/每次询问/永久允许），语义 token，说明文案区分三态
- **NetworkTrustCard**：镜像浏览器信任卡组件结构；三按钮 + 倒计时语义（180s 超时自动按拒绝收敛，UI 文案体现）
- **协调**（防双弹）：策略 `ask` 时网络失败由信任卡负责，`stream.store` 的 netOff 信息卡（SandboxNotice kind=netOff）在信任卡已出现/已裁决的本任务内不再弹（netBlockedSeen 由信任卡路径一并置位）；策略 `deny` 时保留现有一次性信息卡不变

## 7. 平台矩阵

| 平台 | profile 消费 | 说明 |
|---|---|---|
| macOS seatbelt | `(allow network*)` 有无 | 现行 |
| Linux bwrap | `--unshare-net` 有无 | tag `bwrap/net-off` 同链路 |
| Windows | winpolicy 现行网络处理 | 实现时核实其布尔消费点，一并接 effective 策略 |

## 8. 测试策略（momo-test-rules）

- 主进程：迁移三分支；effectiveNetwork 矩阵（settings × grants）；钩子触发条件矩阵（不触发：allow 策略/已有 grant/无签名）；等待协议（单飞/三值唤醒/超时=deny/迟到 always 仍持久化、迟到 deny/session no-op——时钟注入，勿真睡）；结果追加提示断言；agent-runner 全终态路径 grants 清理（ephemeral end / task-end / destroy / **child exit 崩溃与关机保态**——resume 复用 breakpointSsId 防 stale denied 传导）；新 streamSessionId 不继承旧会话 grant
- 渲染端：面板三态读写；卡片三按钮 → IPC 调用；netOff 信息卡协调（ask 下不双弹 / deny 下保留）
- 接线锁：resolveShellSpawn 读 effective（策略翻转后下一条 spawn tag 变化）；agent-runner grants 注册/清理
- 门禁：typecheck 双 Done / electron+renderer 全套零回归 / 根 lint 0

## 9. 验收

1. 默认（ask）：任务内首条网络命令失败 → 卡弹出且 agent 停住 → 允许本次 → 同轮内 agent 收到提示并重试成功（tag 转 net-on）
2. 永久允许：重启后不再询问
3. 保持拒绝：本任务后续网络命令直接失败无卡；新任务再询问
4. 超时：180s 无操作自动按拒绝继续
5. 设置切 deny：回退现行行为（信息卡一次性）
