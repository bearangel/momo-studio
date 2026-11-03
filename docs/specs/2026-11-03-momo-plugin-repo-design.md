# momo-plugin 独立仓库设计（codegraph 首迁）

- 日期：2026-11-03
- 状态：已批准（用户 2026-11-03 逐项确认：范围 / 测试策略 / 仓库创建方式 / 五节设计全文）
- 类型：仓库拆分（新仓库 + 既有插件迁移 + 宿主测试夹具化收尾）
- 关联：`docs/specs/2026-10-15-plugin-system-design.md`（插件系统宿主设计，本次**不动**）

## 1. 背景与目标

### 1.1 意图

为 momo-studio 研发的插件本体集中到独立仓库 **momo-plugin**，与核心仓库解耦：核心仓库收敛为平台宿主，插件以独立版本节奏研发。**插件系统（宿主侧 `electron/src/main/plugin/**`）不在迁移范围**——registry / installer / hook-bus / panel 协议等全部留在 momo-studio。

### 1.2 裁定记录（用户逐项确认）

| 裁定项 | 结论 |
|---|---|
| 迁移范围 | codegraph（已完成）现在迁；office-pro（任务进行中）完工后再迁，当前**任何文件不动** |
| 测试策略 | 方案 A：宿主测试夹具化自包含；codegraph 本体测试随迁新仓库 |
| 仓库位置 | sibling 目录 `../momo-plugin`（与 momo-studio 平级） |
| 远端 | GitHub 公开仓库 |
| git 历史 | 不迁移，全新开始（旧历史留在 momo-studio 可溯） |
| LICENSE | 同宿主双授权（AGPL-3.0 + 商业授权） |
| codegraph 版本号 | manifest `2.0.1` 不动 |

### 1.3 关键现状事实（设计依据，已逐项核实）

1. **git 只跟踪 8 个文本文件**：`momo-plugin.json`、`agents/code-navigator.yaml`、`bin/boot.js`、`mcp/mcp.json`、`panel/index.html`、`panel/panel.json`、`service/index.js`、`skills/codegraph-usage/SKILL.md`
2. **二进制是本机产物**：`engine/`（283MB 解包引擎）与 `vendor/`（56MB darwin-arm64 tarball）均在 `.gitignore`（L16-17）——公开仓推送无 GitHub 100MB 单文件限制问题
3. **宿主源码零耦合**：`electron/src/main/paths.ts` 只管 `<userData>/plugins`；renderer / Playwright e2e（`tests/`）无任何 codegraph 引用
4. **测试引用面**（迁出后异常评估结论）：

| # | 位置 | 迁出后行为 | 处置 |
|---|---|---|---|
| 1 | `electron/tests/plugin/agent-sync.test.ts` L208-231 | 🔴 必红（`sourcePath` 硬指仓库目录，注册 0 条定义） | 改自建 tmp 夹具（同文件 L198 前半已是该模式） |
| 2 | `electron/tests/plugin/codegraph-engine-harness.test.ts`（192 行） | 🟡 永久 skip（`skipIf(!existsSync(引擎))` 恒真）假绿 | 随迁新仓库 |
| 3 | `electron/tests/resource/library.test.ts` L57 注释 | ✅ 不受影响（已 mock `listPluginResourceRows`） | 更新过时注释 |
| 4 | 其余 6 个含 codegraph 字样测试 | ✅ 不受影响（全部自建 tmp 夹具或 mock 行） | 留守当宿主回归锁 |

## 2. momo-plugin 仓库结构

```
momo-plugin/                      # ../momo-plugin · GitHub 公开 · 全新 git
├── README.md                     # 定位 / dev 安装工作流 / 测试运行约定
├── LICENSE                       # AGPL-3.0 + 商业授权（同宿主）
├── LICENSE-COMMERCIAL.md         # 同宿主双授权安排
├── .gitignore                    # engine/ vendor/ node_modules 等本地产物
├── vitest.config.ts              # 最小配置（tests/ 下 harness 用例）
├── package.json                  # 私有包，devDependencies 仅 vitest
├── tests/
│   └── codegraph-engine-harness.test.ts   # 自 momo-studio 随迁（改造见 §4）
└── plugins/
    └── codegraph/                # 8 个跟踪文件原样迁入，内容不动
        ├── momo-plugin.json
        ├── agents/ bin/ mcp/ panel/ service/ skills/
        ├── (engine/  — gitignored，本机解包产物随 mv 迁入)
        └── (vendor/  — gitignored，本机 tarball 随 mv 迁入)
```

`plugins/<name>/` 命名空间为多插件预留（office-pro 完工后迁入即 `plugins/office-pro/`）。

**dev 工作流**（零宿主改动）：momo-studio 的 dev 目录安装（`installPluginDevDir`，注册表记绝对路径不拷贝）直接指向 `../momo-plugin/plugins/codegraph`；改码 → 重载动作即生效（宿主既有语义）。hub 发布链同理——dev 源记录绝对路径，发布/版本回写（`writebackPlugin` 对 dev 源改 manifest）对新路径天然兼容。

## 3. 迁移动作

### 3.1 codegraph 本体

1. 新仓建骨架（§2 结构），`git init` + 首次提交
2. 复制 8 个跟踪文件到 `plugins/codegraph/`（逐字节不动）
3. `mv` 本机 `engine/` 与 `vendor/` 目录到新仓对应位置（gitignored，保证本地 dev 环境零中断；纯本机操作，不入库）
4. `.gitignore` 迁入对应条目（`plugins/codegraph/engine/`、`plugins/codegraph/vendor/`）
5. `gh repo create momo-plugin --public --source=../momo-plugin`（名称 `momo-plugin`，公开）

### 3.2 随迁测试改造（engine-harness）

- 文件迁至新仓 `tests/codegraph-engine-harness.test.ts`
- 宿主模块 import 路径经环境变量 `MOMO_STUDIO_ROOT` 解析（默认 `../momo-studio`）
- skipIf 语义扩展：**宿主缺失或引擎缺失 → skip**（复用其既有 `describe.skipIf(!ENGINE_READY)` 模式，条件加一项宿主可达性）
- **宿主模块引入必须延迟化**：静态 import 在 `skipIf` 判定前执行模块解析——宿主缺失时整文件直接红而非 skip。宿主模块（`getOrStartMcp` / db 等）一律改为 skipIf 可达性判定**之后**的动态 `await import()`（判定 = `MOMO_STUDIO_ROOT` 目录存在且其 `electron/node_modules` 在位——宿主内部 bare import 靠宿主自己的 node_modules 解析，须已 `pnpm install`）
- 新仓 vitest 配置最小化：仅跑 `tests/`，不引入宿主依赖链；运行约定 = Node 24（与宿主 ABI 一致）

## 4. momo-studio 侧改动（一次提交）

| 动作 | 位置 | 说明 |
|---|---|---|
| 删插件目录 | `plugins/codegraph/` | `git rm` 8 个跟踪文件（本机 engine/vendor 已随 §3.1-3 mv 走） |
| 删已迁测试 | `electron/tests/plugin/codegraph-engine-harness.test.ts` | 语义归新仓库 |
| 夹具化改造 | `electron/tests/plugin/agent-sync.test.ts` L208-231 | `sourcePath` 改自建 tmp 夹具：内联最小 agents YAML 写入 tmp 目录，断言语义不变（注册数 ≥1、`plugin:cg:code-navigator` 落库 source='plugin'） |
| 注释更新 | `electron/tests/resource/library.test.ts` L57 | 「仓库 plugins/codegraph」表述更新为历史 |
| .gitignore 清理 | L16-17 两行 codegraph 专属条目 | 删除（office-pro 相关结构保留，任务进行中不动） |

**不动清单**：`docs/specs/**`（历史文档）、`docs/plans/2026-11-03-office-pro-plugin.md` 及 office-pro 全部相关文件（任务进行中）、hub 发布链、宿主插件系统源码。

## 5. 非目标（明确不做）

- 不建 CI（自用阶段；README 记录本地跑法，需要时再立项）
- 不做共享工具（manifest 校验 CLI / 打包脚本 / 模板脚手架）——第二个插件迁入时按需提炼
- 不迁移 git 历史（裁定见 §1.2）
- 不动插件系统宿主设计与实现
- 不动 office-pro

## 6. 验证（完成的定义）

1. **momo-studio**：`npx pnpm@9.0.0 typecheck` 通过；`vitest run tests/plugin tests/resource`（受影响面）全绿；全量裸跑 `vitest run` 冒烟无新增失败（存量失败需甄别与本变更无关）
2. **momo-plugin**：本机引擎在位且 `MOMO_STUDIO_ROOT` 可达时 harness 真跑通过；任一缺失时 skip 绿（不红）
3. **dev 链**：momo-studio 中 dev 目录安装指向 `../momo-plugin/plugins/codegraph` → 资源库插件卡出现、manifest 校验过、vendor probe 通过（`engine/bin/codegraph` 可执行）
4. **GitHub**：新仓公开可访问，`git ls-files` 与 §1.3-1 清单一致（8 文件 + 仓库骨架文件）

## 7. 决策记录

- D1 拆分对象 = 插件本体仓（非插件系统仓）——宿主与扩展面各归其位
- D2 测试策略 = 宿主夹具化自包含（方案 A）；插件本体测试随迁，宿主依赖经 `MOMO_STUDIO_ROOT` 环境变量 + skipIf 容忍缺失——跨仓测试依赖显式化且不阻塞任一仓库独立跑绿
- D3 二进制不入库策略延续——engine/vendor 维持 gitignored 本机产物（与 momo-studio 现状同构，公开仓无体积风险）
- D4 全新历史 + LICENSE 双授权随宿主——公开仓首日即有明确法律姿态
- D5 office-pro 迁移时点 = 其任务验收完成后，届时按本 spec §2/§3 同款流程追加（含其测试归属裁定）

## 8. 风险与备注

- **engine-harness 对宿主内部模块的 import**（`getOrStartMcp` / db 等）在新仓无类型/依赖链支持：延迟动态 import + 宿主可达性 skipIf 规避（§3.2）；宿主 bare 依赖（better-sqlite3 等）经宿主自身 node_modules 解析，故要求 sibling 宿主 checkout 已 `pnpm install` 且 Node 24 线一致——README 记录此耦合面与运行前提
- **`gh repo create` 权限**：执行时需 GitHub CLI 已登录且有公开仓创建权；失败则退化为本地仓 + 手动建远端
- **本机 engine/vendor 的 mv 时机**：必须在 momo-studio `git rm` 之前完成（否则本地 dev 安装的 vendor probe 短暂断裂）；顺序在实施计划中固定
