# Spec #8 Windows 全平台化 — 代码层硬化与打包就绪

**版本**：v0.1（brainstorming 后落地）
**日期**：2026-09-12
**状态**：spec approved → plan → SDD
**系列**：原始对比分析 spec #8（Windows 全平台化）；v2.0 起 README 标注「Windows 是 v2 任务」，v2.4 已铺 Windows shell/sandbox 分支，本 spec 补路径/spawn/打包三层

## 0. 背景与动机

Momo 的 Windows 支持处于「代码有分支、从未真机跑过」状态：v2.4 铺了 shell 工具的 win32 路径（PowerShell plain + taskkill 树杀）与 sandbox 三平台决策；electron-builder win/nsis 配置存在；原生模块（better-sqlite3/keytar/jieba）理论有 prebuilds。但三块硬伤未处理：

1. **路径语义**：多处 `startsWith(root + path.sep)` 手工比对在 win32 下有盘符大小写假阴性；`split(path.sep).join('/')` POSIX 归一会破坏字面反斜杠文件名；UNC 工作区路径未验证
2. **spawn 裸命令**：Node 在 win32 无 shell 时 `spawn('npx')` 直接 ENOENT——MCP spawner（用户标配 `npx` 启动）在 Windows 必挂
3. **打包/安装体验**：无单实例锁（双开 → SQLite WAL 锁冲突）；NSIS 无 icon/签名说明（SmartScreen 警告无指引）

**验证策略（关键裁定）**：容器是 Linux——本 spec 用 **`vi.mock('node:path', → path.win32)` 在 Linux 上模拟 Windows 路径语义**锁住纯路径逻辑；spawn 层用 mock platform 断言分支；真机验收（安装/运行/SmartScreen）落 README 主机清单。CI Windows runner 是独立基建 spec，不在此列。

## 1. 目标与非目标

### 1.1 目标（In Scope）

| ID | 描述 |
|---|---|
| G1 | 新建 `electron/src/main/platform/paths.ts`：`isInsideDir(root, child)`（win32 盘符大小写不敏感 + UNC 感知 + 分隔符归一）+ `toPosixRelPath(root, absPath)`（POSIX 归一并保护字面反斜杠文件名）——全仓唯一目录边界判定入口 |
| G2 | 五模块采用 helper：workspace-fs / journal revert / journal detector / git-tools（v2.9 toPosixRel 搬家共享）/ browser policy——每模块配 `*.win32.test.ts`（path.win32 mock 模板：C:\ 大小写 / UNC / 反斜杠文件名 / `..` 边界） |
| G3 | spawn 裸命令审计：MCP spawner win32 加 `shell` 分支 + 注入防御（引号转义审查）；git/node/自身 spawn 点逐一确认豁免理由 |
| G4 | 单实例锁：`requestSingleInstanceLock` + `second-instance` 聚焦既有窗口（含最小化恢复） |
| G5 | NSIS 加固：`build/icon.ico` 占位 / 签名配置注释模板 / `perMachine: false` 显式 / README SmartScreen 指引 |
| G6 | README 平台声明改写 + engineering.md「v2.10 Windows 规则」+ 主机验收清单 |

### 1.2 非目标（Out of Scope）

- ❌ auto-updater（`publish: null` 无服务端，接入即死代码）
- ❌ 代码签名实际接入（无证书；只留 NSIS 注释模板 + SmartScreen 文档）
- ❌ CI Windows runner（独立基建 spec）
- ❌ 长路径 `\\?\` 前缀工程（README 已知边界：git 需 `core.longpaths=true`）
- ❌ 便携版（portable target）/ per-machine 安装模式
- ❌ v1.x 旧库在 Windows 的迁移路径特判（升级机制本身平台无关）

## 2. 架构

### 2.1 分层验证面

```
Linux 容器可验证                          真机（主机验收清单）
─────────────────────                    ─────────────────────
① 路径语义：vi.mock path.win32            安装（NSIS + SmartScreen）
② spawn 分支：mock platform               首启（ExecutionPolicy 卡）
③ 打包配置：静态审查 + build 门禁          MCP npx server 实启
④ 单实例锁：mock app 两分支               双开聚焦 / UNC 工作区
```

### 2.2 关键不变量

1. **isInsideDir 是唯一边界判定入口**——五模块手工 startsWith 全部替换；新代码禁手写目录包含比对（engineering.md 规则）
2. **posix 路径零回归**——helper 在 Linux 语义下与被替换的手工比对逐字节等价（既有测试全绿即证）
3. **toPosixRelPath 保护反斜杠文件名**——`'a\\b.txt'` 在 win32 下归一为 `a/b.txt` 仍是 git 语义正确形态（POSIX 是 git/账本的对账口径）；「保护」指不因 split/join 破坏**多个连续**分隔符或把字面 `\` 当分隔符拆散的 edge（实现以 win32 语义正确解析后归一）
4. **spawn win32 分支不改变 Linux 行为**——`shell: process.platform === 'win32'` 三态条件注入
5. **单实例锁只在缺锁时 quit**——有锁路径行为零变化（second-instance 仅 Windows/macOS 用户双击场景可达）

## 3. 组件

### 3.1 `electron/src/main/platform/paths.ts`（新建）

```typescript
/** 目录包含判定（全仓唯一入口）。
 *  - 分隔符归一（win32 接受 / 与 \）
 *  - win32 盘符与路径段大小写不敏感比对（C:\WS ≡ c:\ws）
 *  - UNC 根（\\srv\share）与盘符根等价处理
 *  - 纯函数：不触 fs */
export function isInsideDir(root: string, child: string): boolean;

/** POSIX 相对化（git/journal 对账口径）。
 *  以当前平台 path 语义 resolve 后 relative，再统一 '/'。
 *  字面反斜杠文件名：win32 下无法与分隔符区分——语义上作为分隔符处理
 *  （与 git 在 Windows 的行为一致），文档明示该边界。 */
export function toPosixRelPath(root: string, absPath: string): string;
```

实现要点：`isInsideDir` 用 `path.resolve` 归一两侧 → win32 下 `toLowerCase()` 比较前缀（含 `path.sep` 边界，`..foo.txt` 不误伤）；`child === root` 返回 true（自身包含）。

### 3.2 五模块采用

| 模块 | 改动 |
|---|---|
| `workspace-fs.ts` assertInWorkspace | 越界判定换 isInsideDir（realpath 反逃逸链保持） |
| `journal/revert.ts:95` | 同上 |
| `journal/detector.ts:144` | `split(path.sep).join('/')` 换 toPosixRelPath |
| `git-tools.ts` | v2.9 toPosixRel 删除改 import 共享（纯搬家） |
| `browser/policy.ts:157,170` | `..${path.sep}` 与 realpath 锚定换 isInsideDir |

### 3.3 win32 模拟测试模板

```typescript
// <module>.win32.test.ts 头部（每模块同款，落 engineering.md 模板节）
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, default: actual.win32 };
});
// 用例构造：'C:\\WS\\proj' vs 'c:\\ws\\proj\\a.txt'（大小写命中）
// '\\\\srv\\share\\ws'（UNC 根内）/'C:\\other\\x'（异盘拒）
// '..foo.txt' 不误伤 / 'C:\\ws' 自身命中
```

纯路径逻辑直测；fs 依赖用例不 mock path（Linux fs 与比对逻辑解耦）。

### 3.4 spawn 审计

| 调用点 | 裁定 |
|---|---|
| MCP spawner（用户命令如 `npx -y @mcp/server`） | **修**：`shell: process.platform === 'win32'`；win32 shell 模式下 args 引号转义（含空格/`&`/`^` 的参数包裹）+ 专项测试（mock platform 双态断言 shell 旗标与转义形态） |
| journal detector `defaultGitRunner`（spawn 'git'） | 豁免：git.exe 是真 PE（非 .cmd shim），PATH 直寻；win32 语义与 Linux 同——注释记录豁免理由 |
| agent-runner / WarmPool（spawn node 自身） | 豁免：绝对路径 spawn（process.execPath 系），不查 PATH——注释记录 |
| sandbox/probe | 豁免：win32 分支本就不执行 bwrap/sandbox-exec——既有平台门即证 |
| `scripts/dev.mjs` | 审计修正：win32 下 `&&` 命令链与路径拼接（仅影响开发体验，非产品面） |

### 3.5 单实例锁（`index.ts`）

```typescript
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 聚焦既有窗口：存在则 show + focus（最小化恢复）
  });
  // …既有 boot 链不变
}
```

单测（mock app）：无锁 → quit 被调且 boot 链不执行；有锁 → second-instance 注册 + 回调聚焦窗口。

### 3.6 NSIS 加固（`electron/package.json` build 段）

- `build/icon.ico`：从现有 buildResources 生成占位（无则 electron-builder 默认；补一个 256x256 ico 占位文件）
- win 段补注释模板：
```jsonc
// "signingDetails": { "certificateFile": "...", "certificatePassword": "..." }
// ↑ 采购证书后取消注释（当前未签名 → SmartScreen 警告，README 有指引）
```
（JSON 不支持注释——实际落地为 `electron-builder.yml` 迁移或 README 打包节文档说明；实现时择一，倾向后者）
- `perMachine: false` 显式声明（默认 per-user 免管理员）
- README 安装节：SmartScreen「更多信息 → 仍要运行」步骤 + 「实验性 Windows 支持」声明

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| isInsideDir 非法输入（空串/undefined） | 纯函数返回 false（防御，不抛） |
| MCP 命令 win32 shell 注入可疑字符 | 转义包裹；无法安全转义的字符（`"` 内嵌）拒绝启动 + 中文错误 |
| 双开第二实例 | 静默 quit（聚焦第一实例） |
| UNC 工作区根 | isInsideDir 等价处理；workspace 创建时的目录选择对话框返回 UNC 属正常路径 |

## 5. 测试策略

| 类别 | 用例 |
|---|---|
| paths.ts 纯函数（双平台） | posix 原生语义零回归 + win32 mock（大小写/UNC/异盘/`..foo`/自身） |
| 五模块 win32 测试 | 每模块 `*.win32.test.ts`（模板统一）：越界拒/大小写命中/UNC 命中/POSIX 归一正确 |
| 五模块 posix 回归 | 既有测试全绿（零语义漂移证明） |
| MCP spawner | mock platform 双态：win32 → shell:true + 转义断言；linux → shell 缺省不变 |
| 单实例锁 | mock app 两分支 |
| 接线锁 | 摘 isInsideDir 的 win32 lowerCase → 大小写用例必红；摘 MCP shell 分支 → win32 断言必红 |

## 6. 验收标准（DoD）

| # | 验收项 | 类型 |
|---|---|---|
| 1 | paths.ts 双平台单测（含 win32 mock 全场景） | 单测 |
| 2 | 五模块采用 + 各自 win32 测试 + posix 零回归 | 单测 |
| 3 | MCP spawner win32 shell 分支 + 转义 + 双态测试 | 单测 |
| 4 | spawn 豁免清单（git/node/sandbox/dev）注释+文档记录 | docs |
| 5 | 单实例锁两分支 | 单测 |
| 6 | NSIS icon/签名文档/perMachine | 配置+docs |
| 7 | README 平台声明 + SmartScreen 指引 + engineering.md v2.10 规则 | docs |
| 8 | 四门（typecheck 双 Done / electron / renderer / build） | 门禁 |
| 9 | 主机验收：安装→首启→MCP npx 实启→双开→UNC 工作区 | Windows 真机 |

## 7. 已知边界（明示）

- 字面反斜杠文件名在 win32 与分隔符语义不可区分——按分隔符处理（与 git 行为一致），文档明示
- 长路径 >260：Node/Electron 常规路径可过，git 操作需 `core.longpaths=true`（README 边界）
- 未签名 SmartScreen 警告为常态（有证书前）
- 真机验收未完成前 README 标「实验性」
- PowerShell ExecutionPolicy 卡为 v2.4 既有（未真机验证）

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| path.win32 mock 与真 win32 行为有缝（fs 层） | helper 纯函数化（不触 fs）；真机验收兜底 |
| MCP shell:true 引入注入面 | 引号转义 + 危险字符拒绝清单 + 专项测试 |
| 五模块替换引入 posix 回归 | 既有测试全绿硬门 + helper posix 语义等价单测 |
| icon.ico 转制失真 | 占位即可（后续设计资源独立替换） |

## 9. 参考

- v2.4 sandbox spec（win32 分支先例）：`docs/specs/2026-09-10-shell-tools-os-sandbox-design.md`
- v2.9 多仓 git（toPosixRel 搬家源）：`docs/specs/2026-09-12-multi-repo-git-design.md`
- Node path.win32 文档（模拟测试语义基准）
