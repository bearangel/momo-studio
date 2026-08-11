# Task 7 实施报告：skill zip 上传 + listInstalled + deleteCustom IPC

## 实施摘要

Phase 2 最后一个 task。实现自定义 Skill zip 上传、列出三类已安装 skill、删除自定义 skill 三个 IPC 通道，完成 v1.6 能力管理的 Skill 侧闭环。

### 新建文件

| 文件 | 作用 |
|---|---|
| `electron/src/main/skill/zip-uploader.ts` | uploadSkillZip + listInstalled + deleteCustomSkill + InstalledSkill 类型 |
| `electron/src/main/skill/ipc.handlers.ts` | 注册 skill:listInstalled / skill:uploadZip / skill:deleteCustom 三个 IPC |
| `electron/tests/skill/upload-zip.test.ts` | 7 个测试用例（合法 zip / 幂等 / 覆盖 / 缺 SKILL.md / 多根目录 / listInstalled / delete） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `electron/src/main/ipc/index.ts` | import + 调用 registerSkillHandlers() |
| `electron/src/preload/index.ts` | 新增 skill 命名空间（3 个绑定）+ InstalledSkill import |
| `renderer/src/ipc/types.d.ts` | 新增 InstalledSkill 接口 + ApiSurface.skill 命名空间 |
| `electron/package.json` | adm-zip + @types/adm-zip 依赖 |
| `pnpm-lock.yaml` | lockfile 更新 |

## 依赖安装输出

```
npx pnpm@9.0.0 --filter momo-studio-electron add adm-zip
→ +1 added (adm-zip)

npx pnpm@9.0.0 --filter momo-studio-electron add -D @types/adm-zip
→ devDependencies @types/adm-zip added
```

## TDD 步骤输出

### Step 1：安装依赖 ✓

adm-zip（运行时）+ @types/adm-zip（开发时）均安装成功。

### Step 2：写失败测试（RED）

测试文件 `electron/tests/skill/upload-zip.test.ts`，7 个测试用例。

**测试隔离策略调整**：brief 原文用 `vi.spyOn(require(...), 'getSkillsDir').mockReturnValue(skillsDir)` 来 mock skills 目录。但 vitest 在 CJS 环境下对同模块导出函数的 spy 无法拦截内部直接调用（编译后内部引用是 local binding 而非 export binding）。

改用仓库既定模式（与 mcp-list-registered.test.ts 等 T1-T6 全部测试一致）：
- `process.env.AP_USER_DATA_DIR` 指向临时目录
- `runMigrations()` 建 skill_definitions 表（listInstalled 读 marketplace 用）
- `closeDb()` afterEach 复位单例

这样 `resolveSkillsDir()` 自动返回 `<tmpRoot>/skills/`，无需 spy。测试断言用 `skillsDir = path.join(tmpRoot, 'skills')` 路径。

### Step 3：确认 RED ✓

```
FAIL  tests/skill/upload-zip.test.ts
Error: Failed to load url ../../src/main/skill/zip-uploader ... Does the file exist?
Tests  0  (模块不存在)
```

### Step 4：实现 zip-uploader.ts ✓

**uploadSkillZip 核心逻辑**：
1. AdmZip 解析 buffer
2. 找全部 SKILL.md entry（`endsWith('/SKILL.md')` 或 `=== 'SKILL.md'`）
3. 0 个 → 抛 "未找到 SKILL.md"；>1 个 → 抛 "根目录包含多个子目录"
4. 从 SKILL.md 路径提取 slug（`<slug>/SKILL.md` → slug；`SKILL.md` → 'unnamed'）
5. 路径防御：slug 含 `..`、`/`、`\` 拒绝
6. js-yaml 解析 frontmatter 取 description
7. SHA256(buffer) 幂等检查：读 `<targetDir>/.sha256`，匹配则直接返回
8. 覆盖：旧目录 rename 到 `.bak.<timestamp>` 后立即 rmSync 清理
9. 解压：每个 entry 剥离 `<slug>/` 前缀，三层路径防御（entryName `..` + rel `..` + resolved path 沙箱检查）
10. 写 `<targetDir>/.sha256` 标记

**listInstalled 三源合并**：
1. **builtin**：扫描 `resolveBuiltinSkillsDir()`（dev=`<repo>/electron/resources/skills/`，packaged=`process.resourcesPath/skills`）下有 SKILL.md 的子目录。当前无此目录 → 返回空。
2. **marketplace**：从 `skill_definitions` 表读。try/catch 包裹——DB 未初始化或表不存在时返回空（不阻断 listInstalled）。
3. **custom**：扫描 `<skillsDir>/` 下有 `.sha256` 标记文件的子目录。

**deleteCustomSkill**：
- slug 路径防御（`..`、`/`、`\`、空串拒绝）
- 检查 `<targetDir>/.sha256` 存在——不存在说明不是 custom 上传，抛错
- rmSync 删除整个 targetDir

### Step 5：IPC handler 注册 ✓

新建 `electron/src/main/skill/ipc.handlers.ts`，在 `ipc/index.ts` 注册。

### Step 6：renderer 绑定 ✓

- `renderer/src/ipc/types.d.ts`：InstalledSkill 接口 + ApiSurface.skill 命名空间
- `electron/src/preload/index.ts`：skill 命名空间（listInstalled / uploadZip / deleteCustom）

### Step 7：测试 + typecheck ✓

```
electron vitest: 80 files / 526 tests — ALL PASSED
renderer vitest: 26 files / 244 tests — ALL PASSED
typecheck (双 workspace): clean
```

## Self-Review

### 1. listInstalled 三类来源如何区分？

| 来源 | 数据源 | 判定方式 |
|---|---|---|
| **builtin** | `<resources>/skills/*/SKILL.md` | 扫描内置目录（应用打包自带） |
| **marketplace** | `skill_definitions` 表 | DB 查询（市场安装时 installer.ts 写入此表） |
| **custom** | `<userData>/skills/*/` | 子目录内存在 `.sha256` 标记文件 |

**custom 靠 `.sha256` 标记区分**：uploadSkillZip 写此文件，marketplace installer 不写（installer 写 `skill_definitions` 表 + cache_path 在别处）。即使 marketplace 安装的 cache_path 恰好在 `<userData>/skills/` 下（当前不会），没有 `.sha256` 文件就不会被误判为 custom。

### 2. SHA256 文件位置（`<targetDir>/.sha256`）是否合理？

**合理**。理由：
- 不污染 SKILL.md 目录结构：`.sha256` 是隐藏文件（dot 前缀），SkillRegistry 的 `register()` 只找 `SKILL.md`，不读 `.sha256`
- 自包含：删除 custom skill 时 rmSync 整个 targetDir，.sha256 一并清理，无孤儿
- 区分标记：listInstalled 和 deleteCustomSkill 都通过 `.sha256` 存在性判断 source=custom

### 3. 路径防御（`..` 检测）是否覆盖所有 entry？

**三层防御**：
1. **entryName 层**：`entry.entryName.includes('..')` → 跳过
2. **rel 层**（剥离 slug 前缀后）：`rel.includes('..')` → 跳过
3. **resolved path 沙箱层**：`path.resolve(dest)` 必须等于或在 `path.resolve(targetDir) + path.sep` 之下 → 否则跳过

slug 自身也检查：`slug.includes('..') || slug.includes('/') || slug.includes('\\')` → 抛错。

deleteCustomSkill 的 slug 同样做 `..` + 分隔符 + 空串检查。

### 4. preload 是否需要新绑定？

**是**。新增 3 个：
- `skill.listInstalled()` → `skill:listInstalled`
- `skill.uploadZip(buffer, filename)` → `skill:uploadZip`（注意 ArrayBuffer → Buffer.from 转换）
- `skill.deleteCustom(slug)` → `skill:deleteCustom`

ApiSurface 类型同步扩展，typecheck 双 workspace clean。

### 5. vi.spyOn 调整说明

brief 原文用 `vi.spyOn` mock `getSkillsDir`。实测在 vitest CJS 环境下同模块导出函数的 spy 无法拦截内部直接调用。改用 `process.env.AP_USER_DATA_DIR` 环境变量隔离模式（仓库 T1-T6 全部测试的标准做法），`getSkillsDir()` 仍导出（内部调用 `resolveSkillsDir()` 读环境变量）。功能完全等价，测试隔离更干净。

## 测试摘要

| 测试 | 结果 |
|---|---|
| upload-zip.test.ts (7 cases) | ✓ ALL PASS |
| electron 全套 (80 files / 526 tests) | ✓ ALL PASS |
| renderer 全套 (26 files / 244 tests) | ✓ ALL PASS |
| typecheck (electron + renderer) | ✓ clean |
