# Spec 多仓 git 工具 — workspace 内层仓的 agent 可见与可操作

**版本**：v0.1（brainstorming 后落地）
**日期**：2026-09-12
**状态**：spec approved → plan → SDD
**系列**：v2.5 变更账本 brainstorm 时立项（「多仓 git commit 盲区」），探测器地基已预埋（detector 注释明示「后续多仓 git spec 复用」）

## 0. 背景与动机

Momo 的 git 工具（status/diff/log/show/add/commit/branch/checkout/stash 九件）**全部只在 workspace 根仓执行**——`runGit` 固定在 workspaceDir 跑。真实工程里 workspace 常含内层仓（monorepo 子服务、vendored 依赖、嵌套克隆）：agent 能改内层仓的文件（FileTools 按路径工作），却**看不见也管不了这些仓的 git 状态**——无法查 diff、无法提交、无法回滚。v2.5 探测器已为对账发现全部仓（`discoverRepos`，3 层深度 + mtime 缓存），但只服务账本核对，agent 工具面零受益。

本 spec 把多仓能力交到 agent 手上：9 工具参数化 + `git_repos` 发现工具 + 策略均匀继承。

## 1. 目标与非目标

### 1.1 目标（In Scope）

| ID | 描述 |
|---|---|
| G1 | `discoverRepos` 从 `journal/detector.ts` **上提**共享模块 `electron/src/main/git/repos.ts`（纯搬家：函数+缓存+mtime 零改动），detector 与 git-tools 双方引用 |
| G2 | 新增 `git_repos` 工具：列全部仓（相对路径 / 是否根仓 / 当前 branch / dirty 数 `50+` 封顶） |
| G3 | 既有 9 个 git 工具全部加可选 `repo?: string` 参数：缺省根仓（**行为逐字节不变**）；指定时经安全校验后 `git -C <该仓>` 执行 |
| G4 | 安全校验：入参经 `wsFs` 同源校验（拒 `..`/绝对路径/symlink 逃逸）+ 必须命中 `discoverRepos` 结果；未命中报错附可用仓清单 |
| G5 | GitPolicy 均匀继承：三层校验（总开关/分支保护/message pattern）对任何仓一致；分支保护按各仓自己的当前分支名匹配同名规则 |
| G6 | v2.5 账本零改动（记账按 workspace 相对路径天然仓无关；`scanUnjournaled` 本就扫全部仓） |

### 1.2 非目标（Out of Scope）

- ❌ per-repo 策略配置（无需求证据，YAGNI）
- ❌ 跨仓聚合操作（一次 commit 多仓、跨仓 diff）
- ❌ git 子模块（submodule）特判——`.git` **文件**形态（worktree/submodule 挂载点）已天然被 `existsSync(.git)` 命中，不专门解析 `.git` 文件内容
- ❌ UI 变更（账本面板/任务变更区已按路径工作，仓无关）
- ❌ 探测深度可配（沿用常量 3 层；更深场景用 bash，罕见）
- ❌ push/pull/merge/reset（本就不提供的操作，维持「保留给人」）

## 2. 架构

### 2.1 数据流

```
agent tool_use git_status { repo?: "services/api" }
  → git-tools.execute → resolveRepoPath(ctx, args.repo)
      repo 缺省   → workspace 根（零变化路径）
      repo 指定   → wsFs 边界校验 → discoverRepos(workspaceDir) 命中比对
                    命中   → 绝对路径
                    未命中 → 抛 GitRepoNotFoundError（附可用仓清单）
  → runGit([...args], ctx, opts, repoPath)   // -C repoPath 前置
  → GitPolicy（commit 场景，按 repoPath 的当前分支匹配）
```

### 2.2 关键不变量

1. **缺省零变化**：不传 repo 的调用与既有行为逐字节一致（既有 agent/测试零回归）
2. **发现列表是唯一入口**：任何 `-C` 目标必须命中 `discoverRepos`（杜绝任意路径注入）；缓存 mtime 失效保证新克隆仓可被发现（同目录结构变化即失效）
3. **策略单源**：GitPolicy 仍 workspace 级一套，仓无关地均匀适用
4. **账本无关性**：v2.5 记账/撤销/对账不感知「仓」概念，路径即身份
5. **上提纯搬家**：`repos.ts` 与原 detector 实现零语义漂移（迁移测试锁）

## 3. 组件

### 3.1 `electron/src/main/git/repos.ts`（新共享模块）

```typescript
/** 限定深度默认 3 层 */
export const DEFAULT_MAX_DEPTH = 3;
/** 找 workspace 内全部 git 仓根（绝对路径，根仓在前、内层按路径字典序）。
 *  mtime 缓存；跳过 node_modules/隐藏目录/符号链接。纯搬家自 journal/detector。 */
export function discoverRepos(workspaceDir: string, maxDepth?: number): string[];
```

`journal/detector.ts` 改 import（删除本地实现）；`repoCache`/`walkDirs` 随迁（模块私有）。

### 3.2 `git-tools.ts` 扩展

```typescript
/** repo 参数解析：缺省 workspace 根；指定时校验+命中发现列表。
 *  未命中抛错误（含可用仓相对路径清单）。 */
function resolveRepoPath(ctx: ToolContext, repo: unknown): string;

/** runGit 增加第四参 repoPath（缺省 undefined = 既有 workspaceDir 行为）：
 *  repoPath 存在时 args 前置 ['-C', repoPath]。 */
async function runGit(args: string[], ctx: ToolContext, maxOutput?: number, repoPath?: string): Promise<GitResult>;
```

> **勘误（T2 实现勘定）**：`resolveRepoPath` 实际签名为 `(workspaceDir: string, wsFs: WorkspaceFS, repo: unknown): string`，非上文草图的 `(ctx: ToolContext, repo: unknown)`——plan 层为可测性裁定：路径解析是纯函数，解耦 ToolContext 后单测无需构造完整 ctx mock（只注入 workspaceDir + 真实 WorkspaceFS）。语义与本节描述零漂移；工具层由 `resolveRepoArg` 统一入口从 ctx 拆参后内调。

- 9 个工具的 `inputSchema` 加 `repo: { type: 'string', description: '目标仓（相对 workspace 路径，缺省根仓；可用仓见 git_repos）' }`
- `handles` 不变（工具名零变化）
- `git_commit` 的 GitPolicy 分支保护检查改为读 `resolveRepoPath` 产出的仓的当前分支（缺省根仓时与既有逐字节一致）

### 3.3 `git_repos` 工具

```typescript
// 输出（JSON 行格式，与其他 git 工具文本风格一致）：
// root: true  branch: main   dirty: 3     (.)
// root: false branch: feat/x dirty: 50+   services/api
{
  name: 'git_repos',
  description: '列出 workspace 内全部 git 仓（根仓+内层仓，含当前分支与改动数）。改内层仓文件或对其 commit 前，先调用本工具确认可用仓与相对路径。',
  inputSchema: { type: 'object', properties: {} },
}
```

实现：`discoverRepos` → 每仓并发 `git -C <repo> branch --show-current` + `status --porcelain` 行数（复用 runGit 超时/截断；单仓失败该行标 `branch: ?  dirty: ?`，不整体降级）。

### 3.4 工具描述更新

9 个工具描述统一补一句：「多仓 workspace 中可用 `repo` 参数指定内层仓（先 `git_repos` 查询可用仓）」。

## 4. 错误处理

| 错误 | 信息（LLM 可见） |
|---|---|
| repo 未命中发现列表 | `仓 "${repo}" 不在发现列表。可用: [根仓(.), services/api, docs] 。新克隆的仓需待目录缓存失效（约一次目录变更后）或直接重试。` |
| repo 路径越界/非法 | `wsFs` 既有错误（拒 `..`/绝对路径/逃逸） |
| repo 非 string | `参数 "repo" 不是字符串` |
| git_repos 单仓查询失败 | 该行 `branch: ?  dirty: ?`（不降级整体） |
| GitPolicy 拒绝 | 既有文案（仓无关） |

## 5. 测试策略

| 类别 | 用例 |
|---|---|
| 上提搬家 | detector 既有用例迁随全绿 + import 面单测（repos.ts 导出形状） |
| resolveRepoPath | 缺省根 / 命中内层 / 未命中附清单 / `..` 拒 / 绝对路径拒 / symlink 逃逸拒 |
| 9 工具 repo 参数 | 真 tmp 仓（根 + `services/api` 内层）：`-C` 透传（status/diff/log 输出来自内层仓）/ 缺省零变化（对照既有快照） |
| git_repos | 输出形状（root 标记/branch/dirty 计数/50+ 封顶）/ 单仓失败不降级 |
| GitPolicy 跨仓 | 总开关关 → 内层 commit 拒；分支保护同名跨仓生效（根 main 与内层 main 双拒） |
| 接线锁 | 摘 resolveRepoPath 校验（repo 直透 `-C`）必红；摘 git_repos 的 discoverRepos 调用必红 |

真 git 仓 fixture（`git init` + commit + dirty 文件）——git-tools 既有测试模式已有先例可照。

## 6. 验收标准（DoD）

| # | 验收项 | 类型 |
|---|---|---|
| 1 | repos.ts 上提纯搬家（detector 测试迁随零漂移） | 单测 |
| 2 | git_repos 输出形状 + 单仓失败容错 | 单测 |
| 3 | 9 工具 repo 参数 `-C` 透传 + 缺省零变化 | 集成 |
| 4 | resolveRepoPath 六场景（含安全三拒） | 单测 |
| 5 | GitPolicy 跨仓均匀 | 单测 |
| 6 | 接线锁两处红绿变异 | 单测 |
| 7 | typecheck 双 Done / electron 全绿 / renderer 零扰动 / build exit 0 | 门禁 |
| 8 | README 条目 + engineering.md 规则（「发现列表是唯一 -C 入口」） | docs |
| 9 | 主机实测：monorepo workspace 内层仓 commit + 看板对账 | macOS |

## 7. 已知边界（明示）

- 探测深度 3 层；更深目录中的仓不可见（bash 可达，账本探测器同深度一致——对账语义自洽）
- 新克隆仓依赖目录 mtime 失效后可见（父目录条目变化即刻失效，实践中即时）
- 内层仓的 `git checkout` 同根仓语义（仅分支切换）；跨仓 worktree 检测不解析 `.git` 文件内容
- Windows 路径形态的 repo 参数（反斜杠）——统一按 POSIX 相对路径匹配（detector 对账已同口径归一）

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| discoverRepos 上提破坏 detector 对账 | 纯搬家 + 迁移测试锁 + 全套回归 |
| git_repos 并发查询慢（大 workspace） | 仓数 ≤ 探测上限内很小；单仓 10s 超时；并发 Promise.all |
| LLM 传根仓相对路径形态不一致（`./`、尾斜杠） | resolveRepoPath 归一（`path.normalize` 后比对）再命中 |
| 缓存与实际仓漂移（git clone 后未失效窗口） | 未命中报错引导重试；mtime 失效粒度为父目录条目变化 |

## 9. 参考

- v2.5 变更账本 spec（探测器设计 §5.5）：`docs/specs/2026-09-10-change-journal-undo-design.md`
- 实现锚点：`electron/src/main/agent/tools/git-tools.ts` / `electron/src/main/journal/detector.ts`（上提源）
