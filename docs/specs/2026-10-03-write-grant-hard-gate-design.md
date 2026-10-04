# 写授权硬门控（无限等待 + 拒绝即时解除 + 文件工具接入）设计

- 日期：2026-10-03
- 状态：已实施（docs/plans/2026-10-03-write-grant-hard-gate.md 9 任务执行完毕）
- 关联：`docs/specs/2026-10-03-general-write-grant-design.md`（通用写授权；本 spec 是其 §12「有界阻塞等待」的行为修正与范围扩展，取代 §12 的 120s 有界预算与超时回退路径）
- 分支：feat/sandbox-toolchain-grant 延续

## 1. 背景与根因

GUI 验收反馈：授权卡弹出时 agent 不等待用户处置，直接推进工作。对照 Claude Code / OpenCode 的权限语义：问询期间工具调用挂起，用户作答（允许/拒绝）后才继续。

代码审查定位四项缺陷：

1. **覆盖判定短路 bug**（`electron/src/main/agent/tools/shell-tools.ts` `execute` 的 `isCovered`）：
   `eff.toolchainOn || dirs ∈ extraDirs`。`toolchainOn` 仅表示预置清单开关（`sandboxToolchainPolicy === 'allow'`），与被拦目录是否已放行无关。凡开启该开关的机器：任何非预置目录被拦 → 等待循环首个 tick 即判 covered → 零等待烧完 3 轮（`WRITE_WAIT_MAX_ROUNDS`）→ 返回被拦结果，agent 继续。**卡弹了但没等——即用户观测症状。** 根因：前 spec §3 定义 `extraDirs = 预置 ∪ 会话 ∪ 工作空间` 三层合成，但 `handleNetTrustOp`（`network-trust.ts`）只回传 session ∪ ws 两层；`toolchainOn ||` 是对缺失预置层的错误布尔补偿。
2. **拒绝不解除等待**：卡「拒绝」/「X 关闭」仅 renderer 本地记忆（`SandboxNotice.tsx` `denyPending`），等待循环照旧跑满预算，拒绝后仍挂 2 分钟才放行。
3. **120s 有界预算**：超时返回「被拦结果 + 劝导式提示段」，agent 是否暂停全凭 LLM 自觉——实测不可靠。
4. **文件写工具不设防**：`write_file` / `edit_file` / `mkdir` / `rm` / `mv` / `apply_patch` 走 `WorkspaceFS.assertInWorkspace` 直接抛「路径越界」——无卡、无等待，agent 立刻收到错误继续改道。

三项产品裁定（2026-10-03 设计对话批准）：

- 等待预算 → **无限等待**：卡弹出后工具调用一直挂起，用户三选一或停止按钮（abortSignal）是仅有的出口，与 Claude Code 同形
- 拒绝 → **即时解除等待**，并把「用户已拒绝授权」作为工具结果返回给 agent
- 文件写工具 → **一并接入**授权卡 + 等待 + 授权后重执行

## 2. 目标 / 非目标

**目标**

- bash 与文件写工具统一硬门控：越界 → 弹卡 → 挂起等待 → `covered` 原地重执行 / `denied` 即时返回 / `aborted` 随停止按钮终止
- 覆盖判定单点化：`effective.extraDirs` 补全三层合成，等待侧纯成员判定（删除 `toolchainOn ||`）
- 拒绝即时解除：新增 renderer→main IPC + main→child 线协议消息（只加通道，不改既有字段含义）

**非目标**

- `read_file` / `list_files` 越界弹卡（授权模型是写域；授权落地后 extra 根对读自然开放，见 §6/§7）
- OS 沙箱 profile 生成逻辑变更（bash 侧 extraDirs→profile 通道已存在且正确）
- 网络信任门（net-trust-op 的 netOn 语义）变更
- 主进程 `file:*` IPC（用户文件树 UI）行为变更——主进程 WorkspaceFS 实例不设置 extraRootDirs

## 3. 概念模型：等待出口三态 + 覆盖判定单点

```
工具执行命中越界（bash EPERM 签名 / WorkspaceFS 越界异常）
  → 子进程 process.send write-blocked-report（弹卡，既有通道复用）
  → waitForWriteGrant 挂起：
      covered ← 每 2s 轮询 effective：dirs ⊆ extraDirs(三层合成)
      denied  ← 主进程广播 write-grant-denied（用户拒绝/关闭卡）
      aborted ← ctx.abortSignal（停止按钮）
  → covered：刷新 wsFs extraRootDirs / bash 下一轮 spawn 自动生效 → 原地重执行
  → denied：工具返回「用户已拒绝授权…」
  → aborted：抛 AbortError（chat loop 既有约定）
```

覆盖判定唯一真相：`handleNetTrustOp` 回传的 `extraDirs`（三层合成后的归一绝对路径数组）。等待侧不再看 `toolchainOn`。

## 4. 信号链与线协议（momo-boundary-rules：只加通道 / 只加字段）

### 4.1 effective 三层合成（行为修复，字段形状不变）

`network-trust.ts` `handleNetTrustOp`：

```
extraDirs = (toolchainPolicy === 'allow' ? expandToolchainDirs(settings.toolchainDirs, homedir) : [])
          ∪ getGrantedDirs(sessionId, workspaceId)
```

归一去重后回传。`resolveShellSpawn` 侧既有 `presetDirs ∪ extraDirs` 的 Set 并集对多含的预置层幂等，无破坏。

### 4.2 isCovered 纯成员判定（bug ① 修复）

`shell-tools.ts` 等待回调改为：

```ts
return last.dirs.some((d) => eff.extraDirs.includes(d));
```

删除 `toolchainOn ||` 分支（回归锁见 §11）。

### 4.3 新 IPC：`sandbox:denyWrite`（renderer → main）

```
载荷 { sessionId: string | null, dirs: string[] }
行为：日志记录后经 runtime 广播出口转发为 write-grant-denied（§4.4）；幂等无返回值
```

注册在 `sandbox/ipc.handlers.ts`；载荷逐字段校验（sessionId 可 null——卡事件解析失败的降级形态；dirs 数组元素必须 string）。**主进程不维护等待登记表**——广播无状态，匹配在子进程侧做。

### 4.4 新线协议：`write-grant-denied`（main → child，广播）

```
{ type: 'write-grant-denied', dirs: string[] }
```

- 主进程广播出口：`runtime-registry` 新增导出（照 `abortTasksBySessionEverywhere` 遍历 runner），runner 侧照 `notifyTaskReply` 先例向全部活跃流 `child.send`——无匹配等待的子进程收到后 no-op
- 子进程消费点：`runtime-entry.ts` `taskMessageListener` 新增 `m.type === 'write-grant-denied'` 分支 → 调用等待模块的通知器（`net-trust-op:result` 分支同款接线形态）
- **匹配规则**（子进程侧，逐等待方判定）：
  - `deny.dirs` 与等待方 `dirs` 有交集 → 解除为 `denied`
  - 两侧 `dirs` 均为空 → 解除为 `denied`（空对空：降级卡的关闭意图，覆盖同刻多个空 dirs 等待流——罕见且语义一致：该用户已表示拒绝）
  - 其余不匹配（无状态广播的误伤面收敛在空对空一条，§12）

### 4.5 沿用通道（零改动）

- `write-blocked-report`（child → main 弹卡信号）复用于文件工具
- `sandbox:grantWrite` / `sandbox:revokeWrite` / `sandbox:writeBlocked` 推送
- ~~`grantWrite` 的 `resumeSessionId` 唤醒注入~~（**2026-10-04 修订：移除**——硬门控下「等待中授权 → 轮询 covered → 原地重执行」是唯一恢复路径，旧注入与它并发会经 steer 诱发双重重试且污染会话记录；`resumeSessionId` 字段随契约废弃，载荷残留一律忽略。等待被 abort 后的补授权仅落 KV 服务后续写入，用户手动发消息即可继续）

## 5. 等待循环改造（`bash-write-wait.ts` → `write-grant-wait.ts`）

模块语义泛化（bash 与文件工具共用），文件更名、引用点同步（`shell-tools.ts`、测试、§7 helper）：

- **删除预算**：`budgetMs` / `BASH_WRITE_WAIT_MS` / timeout 出口整体下线；循环条件只剩 covered / denied / aborted
- **出口三态**：`{kind:'covered'} | {kind:'denied'} | {kind:'aborted'}`
- **denied 通知器**：模块级订阅表，`notifyWriteGrantDenied(msg)` 按 §4.4 匹配规则唤醒在途等待；waiter 构造时注册、settle 时反注册（防泄漏）
- tick 2s 保留（covered 轮询节拍）
- **非 fork 环境**（`process.send` 缺失）：短路返回 `{kind:'denied'}`——没有主进程就没有卡，等待无人应答，语义等价用户缺席时的拒绝收敛（原 timeout 短路的等价迁移；单测注入替身不受影响，直测用例断言随出口更名同步改写）
- bash 侧 `WRITE_WAIT_MAX_ROUNDS = 3` 保留：多目录安装逐轮弹卡的保护上限不变

## 6. WorkspaceFS extraRootDirs（增量，默认空 = 现行为不变）

`electron/src/main/files/workspace-fs.ts`：

- 新增 `private extraRootDirs: string[] = []` 与 `setExtraRootDirs(dirs: string[])`（存前 realpath 归一去重）
- `assertInWorkspace` 泛化：候选根 = `[rootDir, ...extraRootDirs]`；路径合法 = 落在**任一根**内，逐根做三查：
  1. 字符串边界（`isInsideDir`，既有语义）
  2. 符号链接逃逸（相对**该根**的 realpath 判定，逻辑逐根复用）
  3. `.git` 保护**仅限 workspace 根**——授权目录下 `.git` 开放：与 bash 拿到授权后可写该目录任意内容的行为对齐（越权面文档化见 §12）
- 主进程实例（`file:*` IPC、asset、context-expander 等 72 处）不调用 `setExtraRootDirs` → 行为零变化
- **设置时机**：子进程工具侧 covered 后 `ctx.wsFs.setExtraRootDirs(eff.extraDirs)`；越界发生前不查询（热路径零 IPC 开销）

## 7. 文件工具接入：`runWithWriteGrant(ctx, toolName, pathArg, op)`

新共享 helper（与 §5 改名后的等待模块同域存放），包装 LLM 文件写工具的落盘调用：

```
执行 op
  → 捕获错误：message 匹配 /路径越界: (.+) 不在 workspace 内/ 或 /符号链接逃逸: (.+)/
    （贪婪 `.+` 以固定后缀「 不在 workspace 内」为锚——路径可含空格，`\S+` 会在首个空格截断）
  → dirs = normalizeGrantDirs([提取路径], os.homedir())
  → process.send write-blocked-report { streamSessionId, workspaceId, dirs, command: `${toolName} ${pathArg}` }
  → 等待（§5 三态出口）
      covered → wsFs.setExtraRootDirs(effective.extraDirs) → 重执行 op（轮次上限 3，与 bash
                 WRITE_WAIT_MAX_ROUNDS 同值：mv 双越界路径 / apply_patch 多文件逐根授权场景
                 在单次工具调用内收敛；超限返回最后一次错误文本）
      denied  → 返回「用户已拒绝授权（目录：${dirs.join('、') || '未能定位'}）。请勿重试同一目标；如确需写入请与用户协商其他方案。」
      aborted → 抛 AbortError（穿透）
```

**覆盖工具清单**：`write_file` / `edit_file` / `mkdir` / `rm` / `mv`（src、dst 各自包装）/ `apply_patch`（包装 `executePatch`；越界路径从异常消息提取——WorkspaceFS 错误文案是稳定契约，补文案锁测试防漂移）。

**边界裁定**：

- `exists()` 越界吞错返回 false——非变更操作，维持现状不弹卡
- `read_file` / `list_files` 不包 helper（不触发卡）；授权落地后 extra 根经 §6 自然放行——支撑 `edit_file` 的 read-before-edit 链（先 read 后 edit）
- ReadTracker 照常记录 extra 根的成功读取，链路自洽
- 非 fork 环境：helper 等待短路 denied → 返回拒绝文案（与 §5 短路语义一致；直跑单测注入替身不受影响）

## 8. 授权卡 UX（renderer）

- 「拒绝」按钮与「X 关闭」→ `ipc.sandbox.denyWrite({ sessionId, dirs })`（新 IPC，preload + `renderer/src/ipc/types.d.ts` 同步，双 workspace typecheck 门禁）→ 关卡；renderer 拒绝记忆（同 dirs 不再弹）保留
- 空 dirs 降级卡维持现状（授权按钮禁用 + 「去设置」），关闭即 deny（空对空匹配，§4.4）
- 两个授权按钮路径不变（grantWrite → KV → 等待轮询 covered）

## 9. 提示文本更新

`WRITE_BLOCKED_HINT` 逐字替换为：

```
⚠ 工作空间外路径写入被沙箱拦截。系统已弹出授权卡并暂停等待用户处置：用户放行后本命令会自动重试；用户拒绝时你会收到明确的拒绝结果。请勿用临时目录或缓存重定向绕过，也勿在等待期间尝试其他写入路径。
```

超时回退路径随无限等待消亡，新文案描述三态语义。既有逐字锁测试同步重写。

## 10. 兼容与迁移

- 旧子进程收到 `write-grant-denied`：`taskMessageListener` 无该分支 → 按未知类型记日志 no-op（两端混跑安全）
- effective `extraDirs` 多含预置层：字段形状不变（`string[]`），旧消费方 Set 并集幂等
- 模块更名 `bash-write-wait.ts` → `write-grant-wait.ts`：仓内引用点（shell-tools、测试）同步，无外部消费者
- IPC 契约新增 `denyWrite`：preload + types.d.ts 双端同步，typecheck 门禁
- 无 DB 迁移

## 11. 测试策略（momo-test-rules：仿真真实运行时语义）

| 层 | 用例 |
|---|---|
| network-trust | effective 三层合成：allow×预置∪会话∪工作空间组合矩阵；deny 时不展开预置 |
| shell-tools | **回归锁 bug ①**：toolchainOn=true + 非预置目录被拦 → 不瞬断、等待挂起；covered 后重执行；denied 后返回拒绝文案 |
| write-grant-wait | denied 出口（通知器命中）；无限等待不超时（fake timers 推进远超原 120s 仍挂起）；abort 即时唤醒；dirs 交集 / 空对空匹配矩阵；非 fork 短路 denied |
| 线协议 | runtime-entry `taskMessageListener` 路由 write-grant-denied → 通知器；主进程广播出口遍历 runner（照 notifyTaskReply 测试形态，child.send 断言） |
| workspace-fs | extra 根三查泛化：边界命中 / symlink 相对 extra 根逃逸 / .git 仅 workspace 根拦截 / 默认空零变化；**错误文案锁**（越界/逃逸消息格式，§7 regex 的契约） |
| file-tools / apply-patch | 越界 → report 载荷（command=工具+路径）→ covered → setExtraRootDirs 后重执行成功；denied → 拒绝文案；mv 双路径各自触发；授权后 read_file 放行（edit 链） |
| renderer | 拒绝按钮 / X 关闭 → denyWrite IPC 断言；空 dirs 卡关闭同样触发；关卡与记忆行为 |
| 回归锁 | hint 新文案逐字锁；isCovered 源码不再含 `toolchainOn ||` 子串（防复活，renderer 子串锁先例） |

## 12. 风险与开放问题

- **无人值守无限悬挂**：与 Claude Code 同形（产品裁定）。逃生口 = 停止按钮（abortSignal 即时唤醒）；`dispatch_bg` 链上子 agent 等待会阻塞 gather——gather 超时非错误（返回 pending）语义已有，可 `dispatch_cancel` 止损
- **广播无定向的空对空误伤**：同刻多个空 dirs 等待流被一并解除——罕见（覆盖式单卡），且被解除流的用户同样无法授权（按钮禁用），语义可接受
- **extra 根 `.git` 开放**：用户明示授权该目录的写，与 bash 授权后等权；git 元数据保护仅对 workspace 根生效——文档化越权面，验收观察
- **错误消息 regex 提取路径**：依赖 WorkspaceFS 错误文案稳定（§11 文案锁测试兜底）；文案变更须双端同步
- **迟到授权**：等待被 abort 后用户才授权 → 仅落 KV（2026-10-04 修订：唤醒注入已移除，见 §4.5），用户手动发消息驱动 agent 重试——与「停止是用户显式意图」一致
- **授权写的账本撤销缺口（终审发现）**：extra 根目标的写/删经 toJournalRelPath 产出 `../../..` 游走键，revert 侧 safeResolve 遏制必拒——授权写的条目可记账但不可一键撤销（写本身经用户明示授权，非数据丢失）。跟进项：revert 感知 grant 集或绝对路径记账。
