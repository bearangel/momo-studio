# 安全沙箱「全盘可写」开关设计

- 日期：2026-11-05
- 状态：待审（Draft）
- 上游：用户需求「优化安全沙箱：添加一个开关，开启后除操作系统核心目录外，其他目录都允许读写」
- 关联：v2.4 沙箱架构（`docs/specs` 沙箱系列）、2026-10-03 hard-gate 写授权、2026-10-04 v2.5 工具链机制移除

## 1. 背景与动机

真实生产任务（如 oauth2.1 服务构建）中，agent 频繁需要写 workspace 外路径：npm/pip 全局安装、homebrew、
项目外目录、`~/.nvm`/sdkman 工具链等。现行写剖面 = workspace + tmp + 动态授权目录（授权卡 → session/workspace
两层 KV），授权卡一轮轮打断任务，无人值守场景更是结构性卡点。

用户要一个「这台机器我信任，别再问了」的全局开关：开启后除 OS 核心目录外全盘可写。

## 2. 需求定案（三问三答）

| 问题 | 定案 |
|---|---|
| 作用面 | **只放开 OS 级**（bash 工具 + 插件受管执行两条通道）；应用层 `WorkspaceFS`（file: 工具/文件树）维持 workspace 内不动 |
| 粒度 | **全局开关**，挂设置→安全沙箱，与 strict/permissive、网络双态并列；不做 per-workspace 覆盖 |
| 凭据读遮蔽 | **保留**。`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config/gcloud`、`~/.kube`、`~/.docker`、`~/.netrc`、macOS Keychains 的 deny 读与 writeScope 正交，全盘模式下原样生效 |

## 3. 现状基线

| 维度 | 现行语义 |
|---|---|
| 读 | 全盘可读 + 敏感凭据目录 deny（`sensitiveCandidates`） |
| 写 | workspace + tmp + extraWriteDirs（动态授权）；越界 → write-blocked 信号 → 授权卡 |
| 网络 | 双态 deny/allow（默认 allow） |
| 模式 | strict（OS 沙箱不可用则 blocked）/ permissive（plain 直跑） |
| 平台 | macOS Seatbelt / Linux bwrap / Windows plain PowerShell（无 OS 沙箱） |

写剖面渲染：macOS `renderSeatbeltProfile`（deny default + 逐目录 allow file-write* subpath）、
Linux `buildBwrapArgs`（`--ro-bind / /` + workspace/extraDirs `--bind` RW）。

## 4. 设计总览

新增第三个全局策略维度 **写域（writeScope）**：`'confined'`（默认，现行行为）| `'full-disk'`。

```
设置→安全沙箱（新开关）
  └→ GlobalSettings.sandboxWritePolicy (kv JSON)
       └→ sandbox/settings.ts getSandboxSettings() 懒迁移收敛
            └→ sandbox/index.ts resolveShellSpawn / resolveSandboxedSpawn
                 └→ buildPolicy(..., writeScope)
                      └→ ShellSandboxPolicy.writeScope
                           ├→ macos.ts renderSeatbeltProfile：全盘 allow + 核心目录后置 deny + /usr/local re-allow
                           └→ linux.ts buildBwrapArgs：--bind / / + 核心目录后置 ro-bind + /usr/local re-bind
```

与既有维度的关系：**正交**。mode 管「有没有 OS 沙箱包裹」，writeScope 管「沙箱内写域多大」，networkPolicy
管网络。permissive 模式本就无沙箱直跑（等价全盘），writeScope 在 strict 模式下才有实际差异——文档化，
不做互斥逻辑。

## 5. 详细设计

### 5.1 设置层

- `settings/crud.ts`：`GlobalSettings` 增可选键

  ```ts
  /**
   * 沙箱写域策略（2026-11-05 全盘可写开关）：confined=workspace+tmp+动态授权
   * （默认，安全方向）；full-disk=除 OS 核心目录外全盘可写。读侧只在 kv 有行时
   * 透传（缺省 undefined），迁移收敛在 sandbox/settings.ts——与 sandboxNetworkPolicy
   * 同纪律：此处给默认值会被 updateGlobalSettings 读改写合并烤进 JSON，污染迁移判定。
   */
  sandboxWritePolicy?: 'confined' | 'full-disk';
  ```

  `getGlobalSettings` 两处返回对象各加一行透传 `sandboxWritePolicy: parsed.sandboxWritePolicy`
  （无行分支不设该键）。
- `sandbox/settings.ts`：`SandboxSettings` 增 `writePolicy: SandboxWritePolicy`；读取懒迁移
  （照抄 networkPolicy 先例）：值非 `'confined' | 'full-disk'`（缺失/新装/脏值）→ 收敛 `'confined'`
  并 `updateGlobalSettings({ sandboxWritePolicy: 'confined' })` 写回，写失败不阻断读取。
  新类型别名 `export type SandboxWritePolicy = 'confined' | 'full-disk';` 定义在 `sandbox/types.ts`
  （与 `SandboxMode` 同居），settings.ts / 两端 types.d.ts 引用。
- `__setSandboxSettingsForTest` 机制不变，自然携带新字段。

### 5.2 IPC 契约（两端对齐）

- `renderer/src/ipc/types.d.ts`：
  - 新类型 `export type SandboxWritePolicy = 'confined' | 'full-disk';`
  - `SandboxInfo.settings` 增 `writePolicy: SandboxWritePolicy;`
- `sandbox/ipc.handlers.ts`：`buildInfo` 的 settings 组装透传新字段。
- 设置写入**零新 IPC**：走既有 `settings:updateGlobal`（SandboxSettingsPanel 更新网络开关的同路径）。
- `SandboxApiSurface` 零改动。

### 5.3 策略层

- `sandbox/types.ts`：`ShellSandboxPolicy` 增

  ```ts
  /** 写域：confined=workspace+tmp+extraWriteDirs（现行）；full-disk=全盘可写除核心目录 */
  writeScope: 'confined' | 'full-disk';
  ```

- `sandbox/policy.ts`：`buildPolicy(workspaceDir, networkEnabled, extraWriteDirs = [], writeScope: SandboxWritePolicy = 'confined')`
  —— 第 4 参带默认值，既有调用方与单测零改动。
- 核心 deny 清单常量（policy.ts 导出，`sensitiveCandidates` 先例——导出供单测锁形态）：

  ```ts
  /** 全盘可写模式下仍禁写的 OS 核心目录（spec 2026-11-05 §5.3） */
  export const FULL_DISK_WRITE_DENY_DARWIN = [
    '/System', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/Library',
  ] as const;
  export const FULL_DISK_WRITE_DENY_LINUX = [
    '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  ] as const;
  /** 核心目录中的用户工具链例外（后置 re-allow；Intel homebrew / 手装工具的惯常位置） */
  export const FULL_DISK_WRITE_REALLOW = '/usr/local';
  ```

  刻意取舍（清单评审定案，实施不得增删）：
  - `/private/var` **不进** darwin deny——macOS `TMPDIR`（`/var/folders/…`）在其中，deny 会打断 tmp 语义；
  - `/opt/homebrew`、`~/.nvm`、sdkman 等工具链位置**天然可写**（不在清单）——本开关核心价值所在；
  - darwin 同时列 `/etc` 与 `/private/etc`（symlink 双形态，seatbelt 按 VFS 解析后路径评估，双列无害双保险）；
  - 子进程不提权（同 uid），`/System` 等另有 SIP/root 权限两道天然防线——本清单是第三道带，防的是
    「用户有写权限但不应被 agent 顺手改」的系统位面（`/Library`、`/etc` 下用户可写条目等）。

### 5.4 平台渲染

**macos.ts（seatbelt，利用「后匹配优先」规则顺序）**——`full-disk` 分支写剖面：

```
(allow file-write* (subpath "/"))
(deny file-write* (subpath "/System"))
(deny file-write* (subpath "/bin"))
(deny file-write* (subpath "/sbin"))
(deny file-write* (subpath "/usr"))
(deny file-write* (subpath "/etc"))
(deny file-write* (subpath "/private/etc"))
(deny file-write* (subpath "/Library"))
(allow file-write* (subpath "/usr/local"))
(allow file-write* (literal "/dev/null"))
```

- 读剖面（全盘 allow read + sensitiveDirs deny）、process/network/mach 规则**两态共用**，不动；
- full-disk 分支**省略** confined 的 workspace/tmp allow 行（全盘 allow 已覆盖，快照更简洁）；
  `/dev/null` literal allow 保留（literal 与 subpath 语义不同）；
- sensitiveDirs deny 行位置保持在写剖面规则**之前**（读遮蔽与写域无覆盖关系，顺序无副作用，
  维持现有 profile 段落次序）。

**linux.ts（bwrap，后挂载覆盖先挂载）**——`full-disk` 分支 args **全序**（正确性支点，快照必须锁次序）：

```
--bind / /                       # 1. 全盘 RW（取代 confined 的 --ro-bind / /）
<sensitiveDirs 遮盖循环>          # 2. 现行循环原样（tmpfs / ro-bind /dev/null）——在全盘 bind 之后，后置覆盖仍生效
--ro-bind /usr /usr              # 3. 核心目录逐条后置降回只读（存在性过滤，见下）
--ro-bind /etc /etc
--ro-bind /bin /bin  --ro-bind /sbin /sbin  --ro-bind /lib /lib  --ro-bind /lib64 /lib64  --ro-bind /boot /boot
--bind /usr/local /usr/local     # 4. re-allow 殿后（压过 ro-bind /usr）
--bind <workspace> <workspace>   # 5. 现行 workspace/tmp bind（workspace 多在 /Users 或 /home，不在 deny 清单，次序无副作用）
--bind /tmp /tmp
--dev /dev --proc /proc          # 6. 现行尾部（网络开关 / --new-session / --die-with-parent 原样）
```

- 核心目录 ro-bind 前**存在性过滤**（消费点过滤，`extraWriteDirs` 先例）：usr-merge 发行版
  `/lib`、`/sbin` 等可能是 symlink 或不存在——不存在条目跳过（单条幽灵路径不得打挂 spawn）；
  存在的 symlink 条目 ro-bind 跟随解析，无害；
- sensitiveDirs 遮盖（tmpfs / ro-bind /dev/null）**两态共用**——凭据保护不受写域影响。

**Windows**：无 OS 沙箱，plain PowerShell 本就以用户权限跑（用户态权限即天然边界）——开关 no-op，
文档化 + UI 标注（§5.7）。

### 5.5 入口接线

- `sandbox/index.ts`：`resolveShellSpawn` / `resolveSandboxedSpawn` 均读 `settings.writePolicy`
  → 作 `buildPolicy` 第 4 参——bash 与插件 run_js 两条通道同步生效。
- spawn tag：full-disk 时追加 `/fdw` 段，如 `seatbelt/net-on/fdw`、`bwrap/net-off/fdw`；
  confined 不追加（**既有 tag 断言零改动**）。LLM 自诊可辨写域。
- `cacheEnvAdditions` 不变（npm/pip 缓存仍重定向 tmp——全盘下可写用户缓存目录，但保持一致可预测）。

### 5.6 授权卡联动（零改动，行为描述）

- full-disk 下 bash 写不再 EPERM → stream-relay 的 write-blocked 检测自然不再命中 → 授权卡不再弹；
- extraDirs / write-grant KV 机制原样保留：切回 confined 后已授权目录立即复用；
- denyWrite / grantWrite / revokeWrite / listWriteGrants IPC 零改动。

### 5.7 UI（SandboxSettingsPanel）

- 第三开关「全盘可写」，与模式/网络开关同区，语义 token + lucide 图标（设计系统规范）；
- **开启需一次性确认对话框**（Button 原子组件 + 红色警示 `text-status-error`）文案要点：
  「开启后 agent 可改写系统目录之外的任意用户目录（含 ~/Library 等持久化位面）；凭据目录（~/.ssh 等）
  仍受读保护；仅影响 bash 与插件执行，文件工具仍限工作空间内」；
- 说明文字标注：Windows 无 OS 沙箱，开关不生效（win 下开关渲染禁用态 + 说明，避免「找不到开关」困惑）；
- 写入走 `settings:updateGlobal({ sandboxWritePolicy })`，确认对话框取消则不落值；
- UI 门禁：P2 豁免（设置面板内单开关行 + 确认弹窗，行为已定案），事后截图验收。

## 6. 测试计划

| 层 | 用例 |
|---|---|
| `tests/sandbox/settings.test.ts` | writePolicy 懒迁移：缺失/新装 → confined 写回；脏值 → confined 写回；合法值透传不写回；写失败不抛 |
| `tests/sandbox/policy.test.ts` | writeScope 第 4 参默认 confined；full-disk 透传；deny 清单常量形态锁（两平台 + re-allow 常量） |
| `tests/sandbox/macos.test.ts` | **confined 快照字节不变**（回归锁）；full-disk 快照：全盘 allow → 核心 deny 次序 → /usr/local re-allow 殿后；sensitiveDirs 读 deny 共存 |
| `tests/sandbox/linux.test.ts` | confined 快照字节不变；full-disk：`--bind / /` 前置 + 核心 ro-bind + `/usr/local` bind 殿后；不存在核心条目跳过（无磁盘 fixture 用例） |
| `tests/sandbox/index 或 shell-tools 侧` | spawn tag：full-disk 追加 `/fdw`、confined 无后缀（既有断言零改动的反证） |
| `renderer SandboxSettingsPanel.test.tsx` | 开关渲染（含 win 禁用态）；确认对话框开/取消流；确认后 `settings:updateGlobal` 落值 |

单测纪律（momo-test-rules）：快照锁真实渲染产物，不 mock 被测物；错误路径（迁移写失败、脏值）有专项用例。

## 7. 风险与已知边界

1. **全盘可写的固有代价**：用户目录内持久化位面（`~/Library/LaunchAgents` 等）可被 agent 写——这是
   「全盘可写」字面语义的固有面，确认对话框警示文案覆盖，不另做子目录排除（YAGNI，需要时二期加清单）。
2. mach-lookup 全放行的既有已知边界（v2.4 文档化）不变，与本设计无覆盖关系。
3. permissive 模式下开关无行为差异（文档化，UI 不做互斥禁用——strict/permissive 与写域正交）。
4. seatbelt/bwrap 对「后置覆盖」语义的依赖是本设计正确性支点——两平台快照测试必须锁**规则顺序**，
   不仅仅是规则集合。
5. Linux 无磁盘 fixture 场景（CI）下核心目录存在性过滤会跳过全部条目——full-disk bwrap 用例需
   兼容该形态（或测试内自建临时目录伪造核心条目，实施时按 momo-test-rules 选保真度更高的方案）。

## 8. 非目标

- 应用层 `WorkspaceFS` 不动（file: 工具/文件树仍限 workspace；agent 操作外部文件用 bash）；
- 不做 per-workspace / per-session 覆盖；
- 不做核心目录清单的用户自定义；
- Windows 不引入新防线（无 OS 沙箱现状维持）。

## 9. 实施拆分建议（供实施计划展开）

1. 设置层 + IPC 契约（crud.ts / sandbox settings.ts / types 两端 / ipc.handlers buildInfo）
2. 策略层 + 平台渲染（types.ts / policy.ts 清单常量 / macos.ts / linux.ts 两态分支）
3. 入口接线 + spawn tag（index.ts 两 resolve）
4. UI（SandboxSettingsPanel 开关 + 确认对话框）
5. 测试随层落（上表），最后双 workspace typecheck + 全量 vitest + 截图验收
