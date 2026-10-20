# codegraph 引擎整合实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codegraph 插件 v2.0.0——vendor 内置 colbymchenry/codegraph 引擎（30+ 语言），声明式 MCP 集成，per-ws 多实例；同步修复插件系统 config 合并面 scope 泄漏。

**Architecture:** 引擎以压缩 tarball 形态随插件 zip 分发（按平台变体），安装链解压到插件 engine/ 目录；mcp.json 以模板态注册（占位符不预展开），host-manager spawn 时按 workspace 展开配置并拉起 `serve --mcp`；自研 indexer/tools/hooks 退役，service 薄化为 fs 状态卡。

**Tech Stack:** Electron 44 / Node 24.22 / TypeScript strict / vitest 3.2.7 / better-sqlite3 12（迁移内联 SQL）/ 系统 `tar`（三平台自带）

**Spec:** `docs/specs/2026-10-20-codegraph-engine-integration-design.md`（本计划从 spec 出发，执行者两者都读）

## Global Constraints

- Node 24 LTS 工具链：所有测试/构建命令先 `source ~/.nvm/nvm.sh && nvm use 24`；根 `.nvmrc` 已钉 24
- TypeScript strict：禁 `any`/`@ts-ignore`/`as any`；ESLint `no-explicit-any: error`
- 所有代码注释中文；commit 走 Conventional Commits（`feat:`/`fix:`/`test:`/`docs:`）+ GIT_MASTER=1 + Sisyphus trailer
- 单测落位：主进程集中 `electron/tests/`（镜像 src 结构）；跑 DB 重度目录显式 `--pool=forks`
- 版本号纪律：特性 commit 不动版本号（插件自身版本除外——momo-plugin.json 的 version 是插件自己的）
- 系统级 monorepo 验证：`npx pnpm@9.0.0 typecheck` 双 workspace 零错误

## Review Focus（spec 隐含、任务测试未覆盖时最可能咬人的输入）

1. **池实例 stale root**：用户改 `workspaceRoot` 后，同 ws 池键不变的旧引擎进程仍索引旧 root——T3 测试必须锁定「展开后 args 与池内实例不同 → 旧实例先回收」
2. **workspaceRoot 留空且 ws.directoryPath 为空的展开**：`--path ""` 引擎行为未定义——展开函数对空值 throw 明确错误（T3 测试）
3. **vendor tarball 平台装错**（zip 内 tarball 与本机 target 不符）：解压后无 `bin/`——T4 安装后探针 `engine/bin` 存在性，缺失拒装（T4 测试）
4. **engine/ 被用户/杀毒删除**：spawn ENOENT 错误信息须含 engine 路径与「重装插件」提示（T3 测试：engineBin 不存在时的错误文案）
5. **migration 064 主键冲突**：成员已有 `mcp|remove|codegraph` 行时 INSERT 冲突——用 `INSERT OR IGNORE`（T6 测试）

---

### Task 1: config 合并面 scope 过滤 + boot 残留检测

**Files:**
- Modify: `electron/src/main/plugin/config-store.ts`（getPluginConfigView / resolvePluginConfig，约 210-260 行）
- Modify: `electron/src/main/plugin/boot.ts`（boot 扫描段，约 20 行处）
- Test: `electron/tests/plugin/config-store-scope.test.ts`

**Interfaces:**
- Consumes: 现有 `readPluginConfigJson(pluginId, workspaceId?)`、`normalizeConfigSchema(raw)`、`sensitiveCache`
- Produces: `getPluginConfigView(pluginId, schema, workspaceId?)` 与 `resolvePluginConfig(...)` 签名不变；行为变更——`scope=workspace` 键只从 per-ws 层取值。新增导出 `findGlobalLayerWorkspaceSpills(): Array<{pluginId: string; keys: string[]}>`（boot warn 用）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/plugin/config-store-scope.test.ts
// 覆盖：① workspace 键不吃全局层残留 ② global 键仍吃全局层 ③ per-ws 值覆盖
// ④ 无 wsId 视角 workspace 键为 undefined ⑤ boot spill 检测
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/paths', () => ({
  resolvePluginsDir: () => path.join(tmpDir, 'plugins'),
  resolvePluginDataDir: (id: string) => path.join(tmpDir, 'plugins', 'data', id),
}));

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-')); });

const SCHEMA = {
  type: 'object',
  properties: {
    workspaceRoot: { type: 'string', scope: 'workspace' },
    apiKey: { type: 'string' },           // global（缺省 scope）
  },
  required: [],
} as const;

// 用例骨架（对 getPluginConfigView / resolvePluginConfig 同参数各断言一遍）：
// 1. 写全局层 {workspaceRoot: '/legacy/root', apiKey: 'k1'}，不写 per-ws
//    → view(api, SCHEMA, 'ws-1').values = {apiKey: 'k1'}  // workspaceRoot 不出现
// 2. 写全局层 {workspaceRoot: '/legacy'} + per-ws {workspaceRoot: '/right'}
//    → view(..., 'ws-1').values.workspaceRoot === '/right'
// 3. view(api, SCHEMA)（无 wsId）→ values = {apiKey: 'k1'}，workspaceRoot 不出现
// 4. findGlobalLayerWorkspaceSpills() 返回 [{pluginId: 'test-plugin', keys: ['workspaceRoot']}]
//    （per-ws 层同时有值时也 spill——全局层本不该持有 workspace 键）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && cd electron && npx pnpm@9.0.0 vitest run tests/plugin/config-store-scope.test.ts --pool=forks`
Expected: FAIL（当前实现把全局层 workspaceRoot 并入 values）

- [ ] **Step 3: 实现过滤**

```typescript
// config-store.ts —— 新增内部 helper（两处合并共用）
function mergeScoped(
  pluginId: string,
  schema: NormalizedConfigSchema,
  workspaceId?: string,
): Record<string, unknown> {
  const globalLayer = readPluginConfigJson(pluginId);
  const wsLayer = workspaceId ? readPluginConfigJson(pluginId, workspaceId) : {};
  const out: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(schema.properties)) {
    if ((decl.scope ?? 'global') === 'workspace') {
      if (key in wsLayer) out[key] = wsLayer[key];
    } else if (key in globalLayer) {
      out[key] = globalLayer[key];
    }
  }
  return out;
}
// getPluginConfigView：values = mergeScoped(...)（原 {...global, ...ws} 替换；scopes/sensitive 面不变）
// resolvePluginConfig：同替换（敏感 overlay 仍后置合并）

/** boot 残留检测：全局层持有 workspace-scope 键（历史写入路径产物） */
export function findGlobalLayerWorkspaceSpills(): Array<{ pluginId: string; keys: string[] }> {
  // 遍历 plugins 表 id（getDb().prepare('SELECT id FROM plugins')），
  // 对每个插件读 manifest config → normalizeConfigSchema → 逐键判 scope==='workspace'
  // 且键 in readPluginConfigJson(pluginId) → 收集；schema 解析失败的插件跳过
}
```

boot.ts 既有 warmPluginConfigCache 循环后追加：

```typescript
for (const spill of findGlobalLayerWorkspaceSpills()) {
  logger.warn('插件全局层残留 workspace 作用域键（历史污染，已忽略读取）', spill);
}
```

- [ ] **Step 4: 跑测试过 + 既有 config-store 测试回归**

Run: 同 Step 2 加 `tests/plugin/config-store.test.ts`（如存在则跑，不存在跳过）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'fix: config 合并面 scope 过滤——workspace 键不再从全局层 fallback，boot 检测残留告警'
```

---

### Task 2: mcp 模板态注册（去预展开）

**Files:**
- Modify: `electron/src/main/plugin/mcp-sync.ts`（toConfig 约 60-100 行 + syncPluginMcps）
- Test: `electron/tests/plugin/mcp-template.test.ts`

**Interfaces:**
- Consumes: Task 1 的 config-store（不再于注册期读取 per-ws 无关的展开值）
- Produces: `syncPluginMcps(rec)` 写入 mcp_definitions 的 args/env 为**模板原文**（含 `${config.*}`/`${engineBin}`）；`toConfig` 对 command 为 `${...}` 占位符形态跳过 `isValidNpmPackageName` 校验

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/plugin/mcp-template.test.ts
// 覆盖：① 注册后 mcp_definitions.args 含原文 ${config.workspaceRoot}
// ② command='${engineBin}' 通过校验入库 ③ 普通 npx 命令仍走 npm 名校验（坏名拒收）
// ④ env 值同样保留模板原文
// 做法：内存库（getDb 用 :memory: 或 temp 文件）+ 构造 PluginRecord + manifest.config，
// 调 syncPluginMcps，然后 SELECT command/args_json/env_json FROM mcp_definitions WHERE source='plugin'
```

- [ ] **Step 2: 跑测试确认失败**（当前实现注册期展开，`${config.*}` 会被替换或保留字面量、`${engineBin}` 被 npm 名校验拒收）

Run: `source ~/.nvm/nvm.sh && nvm use 24 && cd electron && npx pnpm@9.0.0 vitest run tests/plugin/mcp-template.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现**

```typescript
// mcp-sync.ts toConfig：
const PLACEHOLDER_RE = /^\$\{[a-zA-Z][a-zA-Z0-9._]*\}$/;
// stdio 分支：command 匹配 PLACEHOLDER_RE 时跳过 npm 名校验（spawn 期展开后仍会校验产物非空）；
// args/env 的 .map(a => substituteConfigTemplate(a, config, pluginId)) 全部删除——存原文。
// syncPluginMcps 里 readPluginConfigJson(rec.id) 的 config 组装保留（占位符缺失 warn 逻辑
// 移到 spawn 期），注册期不再需要 config 视图——但 manifest 校验等其他逻辑不动。
```

- [ ] **Step 4: 既有 mcp-sync 测试回归**（`tests/plugin/mcp-sync.test.ts` 若断言了展开后 args——按模板态语义更新断言，属预期行为变更）

- [ ] **Step 5: Commit** `test+feat: 插件 MCP 注册转模板态（spawn 期展开），占位符命令放行`

---

### Task 3: host-manager spawn 期模板展开 + 池失效

**Files:**
- Create: `electron/src/main/mcp/template-expand.ts`
- Modify: `electron/src/main/mcp/host-manager.ts`（getOrStartMcp，约 139-175 行）
- Test: `electron/tests/mcp/template-expand.test.ts`

**Interfaces:**
- Consumes: Task 2 的模板态 mcp_definitions 行（McpServerConfig 含 `source:'plugin'`、`pluginId`）；config-store 的 `resolvePluginConfig(pluginId, schema, workspaceId)`；`resolvePluginRoot(rec)`（plugin/assembly）
- Produces:

```typescript
// template-expand.ts
export interface ExpandedMcpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
/** spawn 期展开。configSource: workspaceRoot 无值时用于 fallback 的 ws 目录（可空）。 */
export async function expandMcpTemplate(
  config: McpServerConfig,
  workspaceId: string,
): Promise<ExpandedMcpConfig>;
/** 引擎探针：展开产物 command 文件不存在 → throw（文案含 engine 路径与重装提示） */
```

- [ ] **Step 1: 写失败测试**（纯函数 + mock DB，不真 spawn）

```typescript
// 覆盖：
// ① ${config.workspaceRoot} 展开为 per-ws 值（两个 ws 各自展开各自 root）
// ② workspaceRoot 无值 → fallback ws.directoryPath
// ③ 两者皆空 → throw（Review Focus #2）
// ④ ${engineBin} → resolvePluginRoot + /engine/bin/codegraph；文件不存在 →
//    throw /engine 目录缺失，请重装插件/（Review Focus #4）
// ⑤ 非 plugin source（无 pluginId）或无占位符 → 原样返回（存量 MCP 零影响）
// ⑥ args 数组内多个占位符与混合文本展开
```

- [ ] **Step 2: 确认失败** Run: `... vitest run tests/mcp/template-expand.test.ts --pool=forks` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// template-expand.ts 核心：
// 1. 无 pluginId / 全串无 '${' → 直接返回 {command, args, env}
// 2. 读插件记录（getDb plugins 表）→ normalizeConfigSchema(manifest.config)
//    → resolvePluginConfig(pluginId, schema, workspaceId)
// 3. workspaceRoot 特殊语义：值空串/undefined → 查 workspaces 表 directoryPath；仍空 → throw
// 4. ${engineBin} → path.join(resolvePluginRoot(rec), 'engine', 'bin', 'codegraph')
//    （win32 下为 engine\bin\codegraph.exe）；fs.existsSync 探针，缺失 throw 明确文案
// 5. 逐串 replace；产物 command 为空 → throw
```

host-manager `getOrStartMcp` in-flight Promise 内、构造 `McpClient` 前插入：

```typescript
// 模板态插件 MCP：spawn 期按 ws 展开
if (config.source === 'plugin' && config.pluginId && hasPlaceholder(config)) {
  const expanded = await expandMcpTemplate(config, workspaceId);
  // 池失效（Review Focus #1）：已连接实例若展开参数变化 → 先回收旧实例
  const prev = pool.get(key);
  if (prev) { try { (await prev).stop?.(); } catch { /* 已死 */ } pool.delete(key); }
  config = { ...config, ...expanded };
}
```

（`hasPlaceholder`：command/args/env 任一含 `${`；`PooledMcpClient` 若无 stop 方法，用现有断开路径——执行时按实际接口适配，语义：断开旧进程）

- [ ] **Step 4: 测试过 + host-manager 既有测试回归**

- [ ] **Step 5: Commit** `feat: MCP spawn 期按工作空间展开模板（per-ws 引擎实例 + 池参数变化失效）`

---

### Task 4: installer vendor 解压 + 守卫

**Files:**
- Modify: `electron/src/main/plugin/installer.ts`（installPluginZip 解压完成点之后）
- Test: `electron/tests/plugin/installer-vendor.test.ts`

**Interfaces:**
- Consumes: `momo-plugin.json` 新增可选声明：

```json
"vendor": {
  "archives": [{ "file": "vendor/codegraph-darwin-arm64.tar.gz",
                 "sha256": "<hex>", "maxUnpackedMB": 512, "maxEntries": 20000 }],
  "probe": "engine/bin/codegraph"
}
```

- Produces: 安装产物 `<installedDir>/engine/`（tarball 解压产物）；manifest 校验段接受 vendor 块（manifest.ts 的 allowed 字段扩展）

- [ ] **Step 1: 写失败测试**

```typescript
// 覆盖：① 合法 tarball（测试现场用 tar -czf 造一个含 engine/bin/codegraph 假文件的小包）
//   → 解压到 installedDir/engine + sha256 校验通过
// ② sha256 不符 → 拒装抛错且不落 engine/
// ③ tarball 条目数 > maxEntries → 拒装（造 3 文件包，maxEntries=2）
// ④ 解压后 probe 路径不存在（平台装错模拟）→ 拒装（Review Focus #3）
// ⑤ 无 vendor 声明的插件 → 行为与现状完全一致（存量零影响）
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现**

```typescript
// installer.ts：解压 zip 完成后、写 plugins 表前：
// for (const arc of manifest.vendor?.archives ?? []) {
//   const buf = fs.readFileSync(path.join(dest, arc.file));
//   if (sha256(buf) !== arc.sha256) throw new Error(`vendor 包校验失败: ${arc.file}`);
//   // 条目守卫：child_process.execFileSync('tar', ['-tzf', file]) 行数 > maxEntries → throw
//   // 解压：execFileSync('tar', ['-xzf', file, '-C', dest])（产物即 engine/ 等顶层目录）
//   // wait——tarball 内部布局含 engine/ 前缀与否由打包脚本保证（T8 脚本统一加 --transform 前缀）
// }
// probe：vendor.probe 存在时 fs.existsSync(path.join(dest, vendor.probe)) → 否则 throw
// 拒装路径统一走现有安装回滚（安装失败清 dest 目录的既有逻辑）
```

（manifest.ts 同步：momo-plugin.json 顶层 allowed 键加 `vendor`，形状校验同族风格；三平台系统 tar：macOS/Linux 自带，Windows 10+ 自带 tar.exe——execFile('tar') 全平台一致）

- [ ] **Step 4: 既有 installer 测试回归**（`tests/plugin/installer*.test.ts`）

- [ ] **Step 5: Commit** `feat: 插件安装链支持 vendor 引擎包（sha256 + 条目/体积守卫 + 平台探针）`

---

### Task 5: marketplace 平台变体

**Files:**
- Modify: `resources/marketplace/catalog.json`（codegraph 条目）、`electron/src/main/marketplace/types.ts`、安装器下载选变体处
- Test: `electron/tests/marketplace/platform-variant.test.ts`

**Interfaces:**
- Consumes: catalog item 新增可选 `variants: Array<{ platform: string; downloadUrl: string; checksum: string; sizeBytes: number }>`
- Produces: `pickVariant(item, platform, arch): Variant | null`（`platform: 'darwin'|'linux'|'win32'`，`arch: 'arm64'|'x64'`；`${platform}-${arch}` 精确匹配，无匹配回退 downloadUrl 主条目并 warn）

- [ ] **Step 1: 失败测试**：① darwin/arm64 命中对应变体 ② 无 variants 字段回退主条目 ③ 变体列表无匹配 → null + 安装器报「本平台无可用包」
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** pickVariant + 安装链在取 downloadUrl 前调用；catalog.json codegraph 条目补 6 变体（downloadUrl 留 CI 产物占位为空串=不可下载，`verificationStatus: 'official'`）
- [ ] **Step 4: marketplace 既有测试回归**
- [ ] **Step 5: Commit** `feat: marketplace 平台变体（pickVariant）+ codegraph 目录 6 变体`

---

### Task 6: migration 064（plugin_tool → mcp 门控迁移）

**Files:**
- Create: `electron/src/main/storage/migrations/064_codegraph_plugin_tool_to_mcp.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（注册）
- Test: `electron/tests/storage/migration-064.test.ts`

**Interfaces:**
- Produces: migration 064 `up`（参照 v26 表重建先例风格，本迁移无 DDL，纯 DML）：

```sql
INSERT OR IGNORE INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref)
  SELECT assignment_id, 'mcp', 'remove', 'codegraph'
  FROM agent_assignment_capabilities
  WHERE capability_type='plugin_tool' AND mode='remove' AND ref='plugin:codegraph/*';
DELETE FROM agent_assignment_capabilities
  WHERE capability_type='plugin_tool' AND ref LIKE 'plugin:codegraph/%';
```

- [ ] **Step 1: 失败测试**：① 存量 remove 行 → 迁移后变为 `mcp|remove|codegraph` ② 已有同主键 mcp 行 → INSERT OR IGNORE 不炸（Review Focus #5）③ 其他插件的 plugin_tool 行不动 ④ down：反向删除 codegraph mcp remove 行（保守，不重建 plugin_tool 行——语义已在 v2.0 改变）
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现 + 注册 index.ts**
- [ ] **Step 4: 跑 `tests/storage/db.test.ts` + migration-064 全绿**
- [ ] **Step 5: Commit** `feat: 迁移 064——codegraph 插件工具门控迁移至 MCP server 级`

---

### Task 7: plugins/codegraph 插件本体重构

**Files:**
- Delete: `plugins/codegraph/lib/`、`plugins/codegraph/tools/`、`plugins/codegraph/hooks/`
- Create: `plugins/codegraph/mcp/mcp.json`、`scripts/fetch-codegraph-engine.sh`
- Modify: `plugins/codegraph/momo-plugin.json`（v2.0.0 + vendor 声明 + components 收敛 mcp/panel/service）、`plugins/codegraph/service/index.js`（薄化）、`plugins/codegraph/panel/`（状态卡改版）、`.gitignore`（`plugins/codegraph/engine/`）

**Interfaces:**
- Consumes: Task 2-4 的系统侧能力
- Produces: dev 形态可用插件（engine/ 由脚本获取，gitignore）

- [ ] **Step 1: fetch 脚本**

```bash
# scripts/fetch-codegraph-engine.sh
# 用法: ./scripts/fetch-codegraph-engine.sh [darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64|win32-arm64]
# 默认按本机 uname -s/-m 推导 target
# 行为: 从 GitHub Releases 拉 codegraph-v<VER>-<target>.tar.gz（VER 读 plugins/codegraph/momo-plugin.json
#   的 codegraph.engineVersion 字段）→ 解压到 plugins/codegraph/engine/（tarball 顶层即 bin/ lib/）
# 校验: Releases 的 SHA256SUMS 下载比对；失败重试一次后退出码 1
```

- [ ] **Step 2: manifest v2.0.0**

```json
{
  "id": "codegraph",
  "name": "Codegraph 代码图谱",
  "version": "2.0.0",
  "codegraph": { "engineVersion": "1.6.2" },
  "components": { "mcp": "./mcp", "panel": "./panel", "service": "./service" },
  "vendor": {
    "archives": [{ "file": "vendor/codegraph-<target>.tar.gz",
                   "sha256": "<发布时回填>", "maxUnpackedMB": 512, "maxEntries": 20000 }],
    "probe": "engine/bin/codegraph"
  },
  "config": {
    "type": "object",
    "properties": {
      "workspaceRoot": { "type": "string", "title": "索引根目录（留空 = 当前工作空间目录）", "scope": "workspace" }
    }
  }
}
```

（indexCommand/maxFiles 删除——病灶 3 收口；dev 形态不走 zip，vendor 块在 dev reload 时跳过——installer 才消费）

- [ ] **Step 3: mcp.json（spec §4.3 原文）**

```json
{ "servers": { "codegraph": {
    "command": "${engineBin}",
    "args": ["serve", "--mcp", "--path", "${config.workspaceRoot}"],
    "env": { "CODEGRAPH_NO_DOWNLOAD": "1", "CODEGRAPH_DIR": ".momo-codegraph" }
}}}
```

- [ ] **Step 4: service 薄化**（`service/index.js` 全量替换为 ~40 行：`handle('stats')` → 读 `path.join(cfgRoot(), '.momo-codegraph')` 的 existsSync + 目录大小（递归 stat 求和，上限遍历 5000 条防慢）+ engineVersion；start/stop 空实现。cfgRoot 逻辑保留现状两行。spec 的「stats 走 MCP」在此调整为 fs 统计——理由：service→mcp 模块反向依赖不成立，fs 统计零依赖且足够）
- [ ] **Step 5: panel 改版**（panel/ 内现有页面改状态卡：workspaceRoot / 索引目录大小 / 引擎版本 / 「索引数据位于项目 .momo-codegraph/」提示；保留 callService('stats') 调用链）
- [ ] **Step 6: 手动接线验证**（dev 机）：

```bash
./scripts/fetch-codegraph-engine.sh          # 拉 darwin-arm64 引擎到 plugins/codegraph/engine/
# 真库 plugins 表 codegraph 记录重载（或 App 内重载插件）→ 查库:
sqlite3 ~/.momo-studio/state.db "SELECT name, command, args_json FROM mcp_definitions WHERE source='plugin';"
# 预期: command='${engineBin}', args 含原文 ${config.workspaceRoot}
```

- [ ] **Step 7: Commit** `feat: codegraph 插件 v2.0.0——引擎 vendor + 声明式 MCP，自研 indexer/tools/hooks 退役`

---

### Task 8: L2 双 ws 双语言 harness + 收尾

**Files:**
- Test: `electron/tests/plugin/codegraph-engine-harness.test.ts`（`describe.skipIf(!fs.existsSync('.../plugins/codegraph/engine/bin/codegraph'))`）
- Test: `electron/tests/plugin/codegraph-e2e.test.ts`（假 MCP server 脚本版，CI 可跑）

**Interfaces:**
- Consumes: Task 3 expandMcpTemplate + Task 7 引擎
- Produces: 验收锚点证据

- [ ] **Step 1: CI 版（假 server）**：用 node 脚本冒充 stdio MCP server（读 env 里注入的标记回显）——验证「两个 ws 经 getOrStartMcp 拉起两个进程实例、各自展开各自 workspaceRoot、参数变化后旧实例回收」（Review Focus #1 的集成级锁定）
- [ ] **Step 2: 真引擎版（skipIf 无引擎）**：

```typescript
// ① 临时 ws A（放 TS 样例 2 文件）/ ws B（放 Java 样例 2 文件，class + method 调用形态）
// ② 各自 getOrStartMcp → callTool('codegraph_explore', {symbol: ...})
// ③ 断言: A 命中 TS 符号且文件路径在 ws A root 内；B 命中 Java 符号（InitGuideApplicationServiceImpl
//    同款形态）——Java 命中即 dap-e_server 惨案回归锁
// ④ 断言: 两个 ws 的 .momo-codegraph/ 各自落各自项目根下
```

- [ ] **Step 3: mono typecheck + 触碰面回归**

```bash
npx pnpm@9.0.0 typecheck
cd electron && npx pnpm@9.0.0 vitest run tests/plugin/ tests/mcp/ tests/storage/ --pool=forks
cd ../renderer && npx pnpm@9.0.0 vitest run src/
```

- [ ] **Step 4: 真库残留清理（用户数据，备份先行）**

```bash
cp ~/.momo-studio/plugins/data/codegraph/config.json{,.bak-20261020}
# 全局层 workspace 键清空（per-ws 层保留）：写 {}（若 per-ws 无值且用户依赖旧全局值，
# 由 Task 3 的 fallback(directoryPath) 兜底——语义更正确）
```

- [ ] **Step 5: Commit** `test: 双 ws 双语言引擎 harness（Java 命中=回归锁）+ 收尾清理`

---

## 验收段（计划外，L3 真机——momo-acceptance 技能）

App 内（dev 实例重启后）：dape 工作空间新建会话问「`InitGuideApplicationServiceImpl.getOverview` 被哪些方法调用」→ agent 应一次 `codegraph_explore` 命中（不再 grep 自救、不再「仅 11 个文件」）。产出 `.omo/qa-reports/` 报告。
