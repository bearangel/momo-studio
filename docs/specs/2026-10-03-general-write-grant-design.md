# 通用工作空间外写授权（目录白名单）设计

- 日期：2026-10-03
- 状态：已实施（2026-10-03，docs/plans/2026-10-03-general-write-grant.md 9 任务执行完毕）
- 取代：`docs/specs/2026-10-01-sandbox-toolchain-grant.md` 的 grant 模型（§4 会话 grant 表 / §10 引导卡一次性 flag）；该 spec 的目录展开（expandToolchainDirs）、预置清单语义继续有效
- 分支：feat/sandbox-toolchain-grant 延续（未合入主线）

## 1. 背景与动机

v2.5 工具链写授权（sandbox-toolchain-grant）经多轮 GUI 验收暴露三类结构性问题：

1. **三层全靠猜**：预置清单猜 agent 要写哪里（写不进清单的场景弹死循环）；错误签名猜命令语义（cargo 错误打 stdout 曾整链漏检）；grant 一刀切放行**整个清单**（授权 ~/.cargo 顺带放了 ~/go）。
2. **信号链脆弱**（2026-10-03 实证 bug）：卡信号 = 子进程错误文本签名 → 主进程 append 提示段 → 事件落库 → IPC 批量推送 → renderer 批次扫描固定子串 → zustand 置标志 → 卡显示。六环任何一环哑火整链失效——「再测试会话」提示段落库 5 次、KV 未置位、policy=deny、静态链全通，卡仍不弹（renderer 运行时断点未能事后取证）。
3. **生命周期错配已修两次仍有残余**：dismissed 永久 flag vs grant 会话级；X 关闭语义与用户期望错位。

用户验收结论（本 spec 的直接输入）：做成**通用目录白名单**——agent 任何工作空间外写被拦时弹授权卡，卡显示**具体目录路径**，三按钮：**拒绝 / 本会话允许（单个聊天会话维度、重启有效）/ 本工作空间始终允许（持久）**。

## 2. 目标 / 非目标

**目标**

- 通用化：不限于工具链安装——任何沙箱内工作空间外写失败都可触发授权
- 最小授权面：按**具体目录**授权，不再整清单放行
- 信号链收敛：卡信号 = 主进程单点检测 + 1 个 IPC 事件（根治 1.2 不弹 bug）
- 授权三档清晰：预置（永不弹卡）/ 会话（单聊天会话、持久）/ 工作空间（持久）
- 可撤销：设置页可见、可逐条删除（产品红线）

**非目标**

- 不做事前预检/阻塞问询（bash 写目标静态分析不可靠；阻塞等待必超时——修订 B 教训，不重蹈）
- 不做 100% 路径提取（Seatbelt/bwrap 内核层拒绝不报告被拒路径；提取失败退化显示命令）
- 不改网络信任门（net-trust-op 的 netOn 语义不动）

## 3. 概念模型：三层合成

```
有效可写目录(extraDirs) = 预置清单(settings.toolchainDirs 展开)
                       ∪ 会话授权(session KV)
                       ∪ 工作空间授权(workspace KV)
```

| 层 | 存储 | 生命周期 | 触发方式 |
|---|---|---|---|
| 预置清单 | global_settings JSON（现状不动） | 持久，用户编辑 | 永不弹卡（先验） |
| 会话授权 | KV `sandbox_write_grant_session_{sessionId}` = JSON 目录数组 | **单个聊天会话**；会话删除时清理；app 重启保留（会话持久） | 卡「本会话允许」 |
| 工作空间授权 | KV `sandbox_write_grant_ws_{workspaceId}` = JSON 目录数组 | workspace 生命周期；设置页可撤销 | 卡「本工作空间始终允许」 |

- `sandboxToolchainPolicy: 'allow'`（永久全放行预置清单）语义保留为快捷开关。
- **现状 `grants: Set<string>`（workspace 级内存布尔）整体下线**，被本模型取代。

## 4. 数据模型

```
kv_store:
  sandbox_write_grant_session_{sessionId} → '["~/.cargo","/usr/local/lib"]'（归一后绝对路径）
  sandbox_write_grant_ws_{workspaceId}    → 同上
```

- 值为归一化绝对路径数组（写入时即展开归一，读取零处理）。
- 无表迁移（复用 kv_store）；键名风格与既有 `sandbox_net_prompt_dismissed` 一致（下划线）。
- 清理：`deleteSession`（storage/sessions/repo.ts）追加删除对应 session KV 键；workspace 删除同理（找到既有删除点挂接）。
- 撤销 IPC：`sandbox:revokeWrite {scope:'session'|'workspace', key, dir}`——从数组移除单条。

## 5. 检测与信号链

### 5.1 双检分工（各答各的用户）

| 层 | 位置 | 输入 | 产出 | 消费者 |
|---|---|---|---|---|
| agent 提示 | runtime 子进程 close 回调（现状保留） | command + stdout + stderr | 结果尾部 append 通用版提示段 | agent（转述「等用户授权卡」） |
| **卡信号（新，唯一权威）** | **主进程 stream-relay onFlush**（`session:message_event_batch` 推送 renderer 前） | 同批次 `tool_call_result` 事件 | 推 `sandbox:writeBlocked` 事件（见 5.3） | renderer 订阅 → 直弹卡 |

### 5.2 检测函数（纯函数，双端复用）

现 `detectHomeWriteBlocked` 升级为 `detectWriteBlocked(tag, command, stderr, stdout)`：

- **签名库通用化**：EPERM / Operation not permitted / Read-only file system / Read-only filesystem（保留现四签名，HOME 特征从必要条件降级为提取辅助）。
- **路径提取器 `extractBlockedPaths(command, stderr, stdout)`**：
  - 错误文本路径 regex：`failed to open/create <path>`、`<path>: ... not permitted`、cargo `Caused by` 段路径等（用实录错误样本建单测语料）。
  - 命令参数启发：token 以 `/`、`~/` 开头的写命令参数（install/cp/mv/tee 重定向等）。
  - 输出候选绝对路径列表（去重、上限 3）。
- **目录归一规则（显示即所授）**：HOME 下路径归并到 HOME 第一级（`~/.cargo/registry/cache/x` → `~/.cargo`）；非 HOME 路径取最近存在祖先（realpath 失败 resolve 兜底）；提取失败 → 空 dirs（卡降级，见 §7）。

### 5.3 writeBlocked 事件（主进程 → renderer）

```
webContents.send('sandbox:writeBlocked', {
  sessionId: string        // 经 messages 表 stream_session_id → session_id 映射解析
  workspaceId: string      // 事件行/消息行携带
  dirs: string[]           // 归一后（可能为空=未定位）
  command: string          // 截断 200
})
```

- sessionId 解析在主进程单点：`getMessageByStreamSessionId(streamSessionId)` 映射（含 `#roll` 后缀行——对齐 `listMessagesByStreamSessionId` 的前缀匹配语义）。子进程零改动。
- command 提取：主进程 onFlush 处维护 callId → command 小型环形缓存（tool_call_start 到达时记录，result 命中时关联）。
- 去重：同 dirs 的重复事件 renderer 侧覆盖不重弹（agent 重试场景 5 连命中只一张卡）。

### 5.4 renderer 旧链废除

- stream.store 的 `TOOLCHAIN_WRITE_BLOCKED_SNIPPET` 扫描、`toolchainWriteBlockedSeen`、`lastToolchainBlockedCommand`、`markToolchainWriteBlockedSeen` **全部删除**（netBlocked 链保留不动——断网卡不在本次范围）。
- 回归锁：renderer 测试断言源码不再含该子串扫描（防复活）。

## 6. 线协议与 IPC 契约（momo-boundary-rules：只加字段/只加通道）

1. **net-trust-op effective 应答**：`{netOn, toolchainOn}` → **新增 `extraDirs: string[]`**（三层合成、展开归一后回传）。请求载荷**零改动**（sessionId 由主进程从 streamSessionId 映射，见 5.3）。`toolchainOn` 旧字段含义不变（= 预置清单授权态），旧子进程消费不破坏。
2. **子进程 `resolveShellSpawn`**：opts 新增 `extraDirs?: string[]`，与预置清单并集进 `buildPolicy`（每次 shell 调用独立 spawn → 授权后下一次调用立即生效）。`ShellSandboxPolicy.toolchainDirs` 更名 `extraWriteDirs`（语义泛化，主进程内部类型 + 两侧 builder 同步）。
3. **新增 IPC**：
   - `sandbox:grantWrite {scope:'session'|'workspace', key: string, dirs: string[]}`——写 KV（展开归一后存）。校验 scope/key/dirs 非空防串写。
   - `sandbox:revokeWrite {scope, key, dir}`。
   - 推送通道 `sandbox:writeBlocked`（5.3）。
4. **SandboxInfo 收缩**：删 `toolchainPromptDismissed` 字段（事件驱动卡不再用一次性 KV flag）；`sandbox_toolchain_prompt_dismissed` 旧键停读（存量行无害残留）。`netPromptDismissed` 等其余字段不动。preload + renderer 类型同步（IPC 契约变更双 workspace typecheck 门禁）。
5. **WRITE_BLOCKED_HINT 文本更新**（通用版）：不再点名「工具链/依赖安装」，改为「工作空间外路径写入被沙箱拦截。请暂停并告知用户：用户会看到授权卡（选择本会话/本工作空间放行该目录），完成后重试同一命令。不要用临时目录或缓存重定向绕过。」（前缀句「非工作空间路径写入被沙箱拦截」改为「工作空间外路径写入被沙箱拦截」——旧子串锁随之退役，检测已不依赖它。）

## 7. 授权卡 UX

```
┌ agent 请求写入工作空间外的目录 ──────────────┐
│ 命令：cargo build（截断预览，mono）          │
│ 目录：~/.cargo（归一后，逐行展示 ≤3）        │
│                                              │
│ [拒绝]  [本会话允许]  [本工作空间始终允许]    │
└──────────────────────────────────────────────┘
```

- **拒绝**：关卡 + renderer 内存记忆（同会话同 dirs 不再弹；重启自然遗忘可再询）；agent 已从提示段得知等待用户。
- **本会话允许**：`grantWrite {scope:'session', key: sessionId, dirs}` → 卡消失。
- **本工作空间始终允许**：`grantWrite {scope:'workspace', key: workspaceId, dirs}` → 卡消失。
- **空 dirs 降级**（路径提取失败）：卡显示命令 + 「未能定位具体目录」；两授权按钮禁用；仅留「去设置」（手动加预置清单）。
- 无 sessionId/workspaceId 边界：按钮禁用（对齐现 grantNow 防 null 串写先例）。
- 现卡的工具链文案/「恢复默认清单并允许」路径**退役**（空清单场景由通用卡自然覆盖：授权具体目录，不再需要恢复清单的复合动作）。

## 8. 设置页与可撤销

安全沙箱分类新增「已授权目录」小节：

- 按工作空间分组列出 workspace 授权目录 + 每条「删除」（revokeWrite）。
- 会话授权不在此展示（会话维度分散，随会话删除自动清理）。
- 预置清单编辑（现状）保留。

## 9. 兼容与迁移

- 存量 `sandbox_toolchain_prompt_dismissed` KV 行：停读不迁移（无害残留）。
- 旧子进程（若打包混跑）：net-trust-op 应答多 `extraDirs` 字段——旧消费方忽略未知字段，安全。
- `hasToolchainGrant` / `grantToolchainWorkspace` / `__clearToolchainGrantsForTest` / `sandbox:grantToolchain` IPC：下线，测试同步改造。
- sandbox-write-hint 双端逐字锁测试：随提示段文本更新重写（主进程锁新文案；renderer 子串锁删除）。

## 10. 测试策略

- **提取器单测**：cargo 实录（stdout EPERM 带路径）、cp/mv（stderr 带路径）、无路径错误（空 dirs）、非 HOME 路径最近祖先归一、HOME 一级归并。
- **三层合成单测**：session ∪ ws ∪ 预置 去重；KV 读写形状。
- **线协议**：旧载荷（无 sessionId 场景）兼容；extraDirs 透传 resolveShellSpawn → buildPolicy；toolchainOn 不变量。
- **主进程检测端到端**：模拟事件批次（start+result）→ writeBlocked 事件发出（dirs+command 正确）。
- **卡交互**：三按钮各自 IPC 断言、拒绝记忆、空 dirs 降级、无 key 边界禁用。
- **回归锁**：renderer 无子串扫描（§5.4）；grant KV 键清理挂接 deleteSession。

## 11. 风险与开放问题

- **路径提取覆盖率**：少数工具错误不带路径 → 空 dirs 降级路径（可用，体验打折）。语料随验收积累。
- **归一规则边缘**：`~/Library/Python/...` 归并到 `~/Library` 偏宽——卡上「显示即所授」保证用户知情，可拒绝改走设置。验收若高频出现再细化归并档位。
- **会话授权滥用面**：会话内 agent 可引导用户反复授权新目录——每目录一张卡、用户逐次确认，风险与现状持平。
- **writeBlocked 事件风暴**：agent 重试连发——renderer 覆盖式单卡 + 同 dirs 去重已覆盖；极端不同 dirs 轮换场景验收观察。

## 12. 有界阻塞等待（GUI 验收第五轮增补，2026-10-03 深夜）

浏览器等待模式的移植（DEFAULT_AGENT_WAIT_MS=120s 先例）：**在场 = 无缝续跑；不在场 = 优雅回退**。

- **等待循环（子进程 bash-write-wait.ts）**：bash 结果检测命中 → 上报 `{type:'write-blocked-report', streamSessionId, workspaceId, dirs, command}`（fire-and-forget，照 proc-group:register 形态）→ 等待总预算 `BASH_WRITE_WAIT_MS=120s`、tick 2s、监听 `ctx.abortSignal`（types.ts 既有约定）。
- **覆盖判定**：每 tick 经 net-trust 桥查 effective——`toolchainOn || dirs.some(d => extraDirs.includes(d))`（授权目录即归一产物，等值匹配）。
- **重执行**：covered 后同一命令重新 spawn（extraDirs 每次查询自动生效）→ 新结果再检测：仍 blocked 且预算未尽 → 继续等待（多目录安装单预算内收敛）；成功/预算尽 → 返回最终结果（超时路径 = 原被拦结果 + 提示段，即 §5.1 既有行为）。
- **卡触发时机迁移**：主信号 = 等待开始时的子进程上报（runtime-spawner messageHandler 新分支 → 解析 sessionId → 推 sandbox:writeBlocked）；stream-relay 的 inspectEventBatch 降级为迟到兜底（超时返回的被拦结果事件）。
- **与注入唤醒的分工**：等待命中 = 同一工具调用内续跑（agent 无感）；超时后迟到的授权 = §11 唤醒注入（回合外拉起）。两者共用 KV 与卡。
- **abort**：等待中被中止 → 立即返回「已中断」（abortSignal 监听，不占满预算）。
