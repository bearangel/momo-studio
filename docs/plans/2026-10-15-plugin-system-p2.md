# 插件系统 P2 实施计划：工具扩展点 + 声明式组件激活 + reload

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地插件系统 P2（spec §4/§10）——插件 ToolModule 进程内加载（`plugin:<id>/<tool>` 命名空间 + spawn 快照冻结）、声明式组件激活（skills 零复制 / agents 落库 source='plugin' / mcp 注册级联）、审计 source 标记、`plugin:reload` 通道 + runtime 重建链。「用得上：agent 能调插件工具」。

**Architecture:** 关键事实（P2 探索实证）：electron 为纯 `tsc` CJS 编译无 bundle——runtime 子进程 `require(绝对路径)` 原生可行；`AGENT_CONFIG` 只传名字与 ref（defs 子进程重派生）；WarmPool 一 task 一进程（子进程 require cache 无失效需求）；reload 失效面 = `runtime-registry` spawn 闭包旧 opts（stop→start 重建链即失效原语）。装配单点 = `buildSpawnOpts`（spawn 时定型，天然继承 spec §3.3 快照冻结）。

**Tech Stack:** 同 P1。无新依赖。

**Spec:** `docs/specs/2026-10-15-plugin-system-design.md` §4（工具扩展点）/§3.3（生效语义）/§5（组件激活范围 P2 边界）/§2.4 步骤 5（交叉引用）

## Global Constraints

- 同 P1（Node 20 / TS strict 禁 any / 中文注释与错误 / Conventional Commits / IPC 三层同改双 ws typecheck / momo-test-rules 测试保真 / electron 测试集中 tests/ 镜像结构）
- **runtime 子进程代码无 electron API**（P1 ToolContext 语义延续）——plugin-tools loader 写在子进程可达层，不得 import electron
- 插件 JS = 信任模型「装了即信」（spec §7.3）；加载失败降级单组件（plugin 卡红字），不拖垮 runtime 启动
- UI 变更（reload 按钮）为 P2 小改（单组件、确切位置详情面板动作行）——按 momo-ui-preview-rules 属 P2 三条件豁免，事后截图验收
- 每任务 TDD：失败测试先行，见证 RED 再 GREEN

## Review Focus

1. **冒充内置工具名**（插件 `getDefs` 返回 `read_file` 等裸名）→ T2 测试：加载时拒绝该模块
2. **插件模块 require 抛错 / 导出形状错**（无 createTools / 返回非对象）→ T2 测试：降级不崩，错误可观测
3. **workspace 级隔离**：ws1 禁用、ws2 启用 → 各自 spawn 的 AGENT_CONFIG 只含 ws2 的 pluginTools → T3 测试
4. **reload 后旧 spawn 闭包失效**：reload → 池 stop→start → 新 task 用新 manifest/工具集 → T8 测试（mock 重建链调用形状）
5. **卸载级联**：插件卸载 → source='plugin' 的 agent 行 / mcp 定义清理，agent 引用不悬空 → T6/T7 测试

---

### Task 1: 迁移 058（tool_calls.source 列）

**Files:**
- Create: `electron/src/main/storage/migrations/058_tool_call_source.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/storage/migration-058-tool-call-source.test.ts`

**Interfaces:**
- Produces: `tool_calls.source TEXT NOT NULL DEFAULT 'builtin'`（audit 透传链终点）；migration058 模块（version 58, up/down）

- [ ] **Step 1: RED**——照 057 范式：建 workspace/user 前置行 → 插一条 tool_calls（缺 source 走 DEFAULT 'builtin'）→ `ALTER` 后显式插 `source='plugin'` 断言可写；schema_migrations version 58 注册锁
- [ ] **Step 2: 跑失败** `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-058-tool-call-source.test.ts`（Expected: FAIL 无此迁移）
- [ ] **Step 3: GREEN**——058 模块 `up: "ALTER TABLE tool_calls ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';"` + index.ts 注册（照 057）
- [ ] **Step 4: 跑通过 + tests/storage/ 回归**（预存失败域除外，参照 P1 备案）
- [ ] **Step 5: Commit** `feat: 迁移 058 tool_calls.source（插件审计溯源列，spec §4.3）`

---

### Task 2: 子进程侧 plugin-tools loader（命名空间强制 + 降级）

**Files:**
- Create: `electron/src/main/agent/tools/plugin-tools.ts`
- Test: `electron/tests/agent/tools/plugin-tools.test.ts`

**Interfaces:**
- Consumes: `PluginToolRef`（T3 定义于 `runtime-config.ts`，形状见下）
- Produces:
  - `loadPluginToolModules(refs: PluginToolRef[], log: (msg: string, meta?: unknown) => void): { modules: ToolModule[]; failures: Array<{ pluginId: string; modulePath: string; error: string }> }`
  - `PLUGIN_TOOL_PREFIX = 'plugin:'`；包装层：`getDefs()` 返回名强制改写为 `plugin:<id>/<shortName>`（冒充内置名即拒载该模块）；`execute` 注入 pluginCtx `{ getConfig(), getDataDir(), logger }`；审计 source='plugin' 由 T5 包装（本任务在 wrapper 上预留 `pluginSource: 'plugin'` 元数据字段供 executeToolModule 读取）

`PluginToolRef` 形状（T3 落地）：

```ts
/** 启用插件的工具装配快照（buildSpawnOpts 定型；子进程据此 require 外部模块） */
export interface PluginToolRef {
  pluginId: string;
  /** 插件根目录（zip=installed/<id>/<version>/；dev=源目录） */
  rootDir: string;
  /** components.tools 下待加载模块的绝对路径 */
  modulePaths: string[];
  /** 跨更新持久数据目录（pluginCtx.getDataDir()） */
  dataDir: string;
  /** manifest.config 的当前值（dataDir/config.json 解析；缺省 {}） */
  config: Record<string, unknown>;
}
```

- [ ] **Step 1: RED**——测试用真实 tmpdir 写假插件模块（CJS `module.exports.createTools = function (pluginCtx) {...}`，ts 测试里用 fs.writeFileSync 写 .js）：
  1. 合法模块 → modules[0] 的 `handles('plugin:cg/explore')` true；`getDefs()[0].name === 'plugin:cg/explore'`；execute 收到的第二参 ToolContext 之外通过闭包拿到 pluginCtx（getConfig 返回 ref.config、getDataDir 返回 ref.dataDir）
  2. **冒充内置**（getDefs 返回 `{name:'read_file'}`）→ 该模块进 failures、modules 不含它（Review Focus #1）
  3. require 抛错（模块内容 `throw new Error('boom')`）→ failures 带 error 消息、不抛出（Review Focus #2）
  4. 导出无 createTools / createTools 返回 null → failures
  5. 多模块多 ref 合并；pluginCtx.logger 可调
- [ ] **Step 2: 跑失败**（模块不存在）
- [ ] **Step 3: GREEN**——实现 `plugin-tools.ts`：

```ts
// electron/src/main/agent/tools/plugin-tools.ts
// 子进程侧插件工具加载器（spec §4.1/§4.2）。纯 CJS require——electron 为 tsc
// 编译无 bundle，子进程按绝对路径加载原生可行；本模块不得 import electron。
import path from 'node:path';
import type { ToolModule, ToolContext } from './types';
import type { PluginToolRef } from '../runtime-config';

export interface PluginToolCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  logger: { warn(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void };
}

export interface PluginToolModule extends ToolModule {
  /** 审计溯源标记（executeToolModule 据此在 logToolCall 打 source:'plugin'） */
  pluginSource: 'plugin';
  pluginId: string;
}

export interface PluginToolLoadResult {
  modules: PluginToolModule[];
  failures: Array<{ pluginId: string; modulePath: string; error: string }>;
}

const BUILTIN_NAME_RE = /^[a-z][a-z0-9_]*$/; // 内置工具名形如 read_file——无斜杠无冒号

export function loadPluginToolModules(
  refs: PluginToolRef[],
  log: (msg: string, meta?: unknown) => void,
): PluginToolLoadResult {
  const modules: PluginToolModule[] = [];
  const failures: PluginToolLoadResult['failures'] = [];
  for (const ref of refs) {
    for (const modulePath of ref.modulePaths) {
      try {
        // require 缓存失效无需处理：一 task 一进程（WarmPool release=kill）
        const mod = require(modulePath) as {
          createTools?: (ctx: PluginToolCtx) => unknown;
        };
        if (typeof mod.createTools !== 'function') {
          throw new Error('模块未导出 createTools 函数');
        }
        const pluginCtx: PluginToolCtx = {
          getConfig: () => ref.config,
          getDataDir: () => ref.dataDir,
          logger: {
            warn: (msg, meta) => log(`[plugin:${ref.pluginId}] ${msg}`, meta),
            info: (msg, meta) => log(`[plugin:${ref.pluginId}] ${msg}`, meta),
          },
        };
        const created = mod.createTools(pluginCtx);
        if (created === null || typeof created !== 'object') {
          throw new Error('createTools 返回值不是对象');
        }
        const inner = created as ToolModule;
        // 命名空间强制：短名 → plugin:<id>/<short>；冒充内置名（无斜杠的裸名
        // 改写后仍可能撞）在此逐条拒绝
        const namespaced = namespaceDefs(ref.pluginId, inner);
        if (namespaced === null) {
          throw new Error('getDefs 含冒充内置工具的裸名（无斜杠命名）');
        }
        modules.push({
          pluginId: ref.pluginId,
          pluginSource: 'plugin',
          getDefs: () => namespaced,
          getCatalog: () =>
            (inner.getCatalog?.() ?? []).map((c) => ({ ...c, name: `plugin:${ref.pluginId}/${c.name}`, source: 'plugin' as const })),
          handles: (name) => inner.handles(stripPrefix(ref.pluginId, name)),
          execute: async (name, args, ctx: ToolContext) =>
            inner.execute(stripPrefix(ref.pluginId, name), args, ctx),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ pluginId: ref.pluginId, modulePath: path.basename(modulePath), error });
        log(`插件工具模块加载失败`, { pluginId: ref.pluginId, modulePath, error });
      }
    }
  }
  return { modules, failures };
}

function namespaceDefs(pluginId: string, inner: ToolModule): ToolModule['getDefs'] | null {
  const defs = inner.getDefs();
  const out = defs.map((d) => {
    if (!d.name.includes('/')) {
      if (BUILTIN_NAME_RE.test(d.name)) return null; // 冒充内置
      return d; // 已带其他命名空间前缀——原样放行（如未来 plugin: 直标）
    }
    return { ...d, name: `plugin:${pluginId}/${d.name}` };
  });
  if (out.some((d) => d === null)) return null;
  return out as ToolModule['getDefs'];
}

function stripPrefix(pluginId: string, name: string): string {
  const prefix = `plugin:${pluginId}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
```

（实现以测试为准修正细节——如 getCatalog 的 entry 形状对齐 `ToolCatalogEntry` 现有字段。）

- [ ] **Step 4: GREEN + Commit** `feat: 子进程插件工具加载器（命名空间强制/降级/pluginCtx，spec §4.1）`

---

### Task 3: AGENT_CONFIG 装配（pluginTools/skills/mcp 三面 + workspace 过滤）

**Files:**
- Modify: `electron/src/main/agent/runtime-config.ts`（`PluginToolRef` 类型 + `AgentRuntimeOpts.pluginTools?: PluginToolRef[]` + parseConfig 透传）
- Create: `electron/src/main/plugin/assembly.ts`（装配计算：enabled 插件 → refs）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（buildSpawnOpts 内消费）
- Test: `electron/tests/plugin/assembly.test.ts`

**Interfaces:**
- Consumes: `listPlugins` / `isPluginEnabled`（P1 registry）、`resolvePluginInstalledDir` / `resolvePluginDataDir`（paths）、manifest 解析
- Produces:
  - `resolvePluginRoot(rec: PluginRecord): string | null`——zip=installed dir / dev=sourcePath（missing 态返回 null 跳过）
  - `buildPluginToolRefs(workspaceId: string): PluginToolRef[]`——启用插件的 tools 模块路径（`<root>/<components.tools>/*.js` 顶层、非递归）+ config（读 `<dataDir>/config.json`，坏 JSON 降级 {}）
  - `buildPluginSkillRefs(workspaceId: string): Array<{ slug: string; cachePath: string }>`——启用插件 skills 子目录（含 SKILL.md 的目录）
  - `buildPluginMcpNames(workspaceId: string): string[]` + `filterDisabledPluginMcps(names, workspaceId)`——贡献名集合与禁用过滤
- buildSpawnOpts 消费点（spawn-helpers.ts:394-401 区域）：
  ```ts
  allowedTools: [...merged.tools, ...buildPluginToolRefs(workspaceId).map(r => `plugin:${r.pluginId}/…`)]  // 名单由 defs 侧约定：直接并 plugin 前缀通配不可行——见下裁定
  ```
  **裁定（Ruling 预埋）**：allowedTools 是精确名白名单——主进程不知道插件工具短名（defs 子进程才派生）。采用「前缀放行」：`allowedTools` 保持 merged.tools；子进程侧 plugin 工具**不进 allowed/denied 过滤**，由「pluginTools ref 存在即装配 + defs 并入可见集」等效控制（可见性=装配面，与 spec §4.2「启用→装配→目录出现」语义一致）。deniedTools 若含 `plugin:<id>/*` 前缀模式则在该插件级禁用（P2 简化：整插件禁用）。

- [ ] **Step 1: RED**——assembly.test.ts（真实 tmpdir 插件树 + 两 workspace 启停矩阵）：
  1. zip 启用 → refs 含 rootDir/modulePaths/dataDir/config
  2. ws1 禁用 ws2 启用 → buildPluginToolRefs('ws1') 空、('ws2') 非空（Review Focus #3）
  3. dev missing（目录删）→ 跳过不抛
  4. config.json 坏 JSON → config={}
  5. skills refs 形状 `<root>/<components.skills>/<slug>` 含 SKILL.md；mcp 贡献名/过滤矩阵
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: 插件装配计算 + AGENT_CONFIG.pluginTools 通道（workspace 级过滤，spec §4.2）`
- parseConfig 单测并入（runtime-config 既有测试文件补透传断言）

---

### Task 4: runtime-entry 集成（defs 并入 + 执行路由 + 降级可见）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（buildRuntimeContext：`loadPluginToolModules(config.pluginTools ?? [], childLog)` → modules 并入 ctx.toolModules；failures 进启动日志）
- Test: `electron/tests/agent/runtime-plugin-integration.test.ts`（策略：不 fork 真进程——直接测 buildRuntimeContext 导出面若为私有，则测「config.pluginTools → toolModules 含 plugin 模块」的最小抽取函数；若 buildRuntimeContext 不可单测，抽 `assembleToolModules(config, ctx)` 纯函数出来测）

**Interfaces:**
- Consumes: T2 loader + T3 config 字段
- Produces: 子进程 defs 并集含 `plugin:<id>/<tool>`；`doExecuteTool` 的 `m.handles()` 路由天然命中（无需改）；plugin 模块 execute 收到与内置同款 ToolContext（治理等价，spec §4.3）

- [ ] **Step 1: RED**——assembleToolModules：无 pluginTools → 仅内置；带 1 ref（假模块）→ modules 尾部含 plugin 模块且 handles('plugin:x/t') true；loader failures 不进 modules 但函数返回值携带（供启动日志断言）
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: runtime 工具注册中心并入插件模块（治理等价路由，spec §4.3）`

---

### Task 5: 审计 source 透传链（四点）

**Files:**
- Modify: `electron/src/main/agent/tools/shared/audit.ts`（`ToolCallAudit.source?: 'builtin' | 'plugin'`，logToolCall 载荷加字段）
- Modify: `electron/src/main/agent/tools/index.ts`（executeToolModule：命中 `PluginToolModule` → source='plugin'）
- Modify: `electron/src/main/agent/runtime-spawner.ts`（AuditToolCallChildMsg + insert 调用透传）
- Modify: `electron/src/main/audit/insert.ts`（InsertToolCallInput.source + INSERT 列）
- Test: `electron/tests/audit/tool-call-source.test.ts`（insert 层：source 落库断言）+ executeToolModule 层（fake plugin module → logToolCall 载荷含 source:'plugin'——mock process.send）

- [ ] **Step 1: RED**（两层各一用例）
- [ ] **Step 2-4: RED→GREEN→ 回归 tests/audit/ → Commit** `feat: 工具审计 source 透传（plugin 溯源落 tool_calls，spec §4.3）`

---

### Task 6: skills + agents 激活（零复制 refs + source='plugin' 落库）

**Files:**
- Modify: `electron/src/main/agent/spawn-helpers.ts`（resolveSkillSlugs 产物后追加 buildPluginSkillRefs）
- Create: `electron/src/main/plugin/agent-sync.ts`（registerPluginAgents(rec)：解析 `<root>/<components.agents>/*.yaml` → agent_definitions 幂等行，id 约定 `plugin:<pluginId>:<slug>`、source='plugin'；removePluginAgents(pluginId)：删行前先清 workspace_agent_members 成员行）
- Modify: `electron/src/main/plugin/installer.ts`（安装/卸载钩子调 agent-sync）
- Modify: `electron/src/main/resource/custom.ts`（source 白名单注释与相关过滤确认——plugin 行不进 custom 列表）
- Test: `electron/tests/plugin/agent-sync.test.ts`

**Interfaces:**
- Consumes: agent YAML 解析（复用 builtin.ts 的 parse 路径——抽用或同构调用）、`agent_definitions` 表
- Produces: `registerPluginAgents(rec: PluginRecord): number`（写入数）、`removePluginAgents(pluginId: string): void`（级联清成员行，Review Focus #5）

- [ ] **Step 1: RED**——假插件树（agents/code-navigator.yaml 最小合法 manifest）：注册后行存在 source='plugin' id='plugin:cg:code-navigator'；重复注册幂等（不重复行）；remove 后行与成员行均无
- [ ] **Step 2-4: RED→GREEN→ installer 挂钩（install 成功后 register、uninstall 前 remove）→ Commit** `feat: 插件 skills 零复制激活 + agents source='plugin' 落库与卸载级联（spec §10 P2）`

---

### Task 7: MCP 激活（source='plugin' 注册 + 禁用过滤 + 卸载级联）

**Files:**
- Modify: `electron/src/main/mcp/types.ts`（source 联合加 'plugin'）
- Modify: `electron/src/main/plugin/installer.ts`（install 后按 manifest.components.mcp 组 McpServerConfig 逐条 registerMcpDefinition，source='plugin'；uninstall 前删该 source+前缀名的定义）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（filterEnabledMcps 后追加 filterDisabledPluginMcps）
- Create: `electron/src/main/plugin/mcp-sync.ts`（上两行的实现体）
- Test: `electron/tests/plugin/mcp-sync.test.ts`

**Interfaces:**
- Consumes: `registerMcpDefinition`（host-manager）、`isValidNpmPackageName`（npx command 校验）
- Produces: `syncPluginMcps(rec): { registered: string[] }`（坏条目逐条跳过带日志——如 command 不合法）、`removePluginMcps(pluginId): void`（定义删除 + agent 引用清理复用 removeMcpRefsFromAgents 同构逻辑）

- [ ] **Step 1: RED**——mcp.json（两条：合法 npx + 非法 command）→ 合法者注册 source='plugin'，非法者跳过；remove 后定义无、引用清
- [ ] **Step 2-4: RED→GREEN→ Commit** `feat: 插件 MCP 注册/卸载级联 + spawn 禁用过滤（spec §10 P2）`

---

### Task 8: manifest 步骤 5 交叉引用校验 + plugin:reload + UI 按钮

**Files:**
- Modify: `electron/src/main/plugin/manifest.ts`（validateManifest 追加：components.agents 存在时解析各 YAML，defaultTools 里 `plugin:` 前缀 ref 与 defaultSkills 引用须在「本插件 tools 短名 + skills 子目录 slug」集合内；YAML 解析坏 → issue）
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（`plugin:reload`：重读 manifest（dev 直读源目录 / zip 重验安装目录）→ registry upsert → agent-sync/mcp-sync 重跑 → 受影响 workspace 的 runtime stop→start 重建）
- Create: `electron/src/main/plugin/reload.ts`（重建链：listPlugins 关联 workspace → stopAgentRuntime(instanceId) → startAgentRuntime(新 opts)——从 runtime-registry 导入）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`（PluginApiSurface.reload(id): Promise<void>）
- Modify: `renderer/src/components/resource-library/ResourceDetail.tsx`（plugin 详情动作行加「重载」按钮，RotateCw 图标 16px/1.75；调 ipc.plugin.reload 后横幅）
- Test: `electron/tests/plugin/manifest-crossref.test.ts` + `electron/tests/plugin/reload.test.ts`（mock runtime-registry 断言 stop/start 调用形状与 workspace 过滤）+ ResourceDetail colocated 补按钮断言

- [ ] **Step 1: RED**（三个测试文件）
- [ ] **Step 2-4: RED→GREEN→ 双 ws typecheck → Commit** `feat: manifest 交叉引用校验 + plugin:reload 通道与 runtime 重建链（spec §2.4-5/§3.3）`

---

### Task 9: 收官——全量守护 + 冒烟 + 账本 + alpha 17

- [ ] typecheck 双 ws + 插件域/agent/audit 全绿 + renderer 全量（预存域除外，对照 P1 备案基线）
- [ ] dev 冒烟（macOS host，electron-rebuild 后）：fixture 插件升级为带真工具（echo 工具 `plugin:sample-echo/echo`）→ 注册 → 会话让 agent 调用 → 审计流水 source='plugin' → 改模块代码 → 「重载」→ 新会话新行为 → 禁用/卸载级联走查；截图留档（对照 P2 豁免验收）
- [ ] CHANGELOG P2 条目 + 三处 alpha 16→17
- [ ] Commit `chore: 插件系统 P2 收官（CHANGELOG + alpha 17）`

---

## P2 边界（执行者须知）

- **pluginCtx.callService 不在 P2**（service 组件属 P3——本计划 pluginCtx 只有 getConfig/getDataDir/logger，类型上预留）
- **config 敏感值 keytar 通道不在 P2**（config 只读 `<dataDir>/config.json`；设置页表单 P4 随面板协议交付）
- **allowed/denied 对插件工具的前缀模式匹配**仅实现「`plugin:<id>/*` 整插件禁用」一档；精细 per-tool deny 留生态阶段
- **plugin agents 的启用流**复用现有 workspace 成员制（资源库插件卡不新增「启用 agent」按钮——agent 管理视图按 source='plugin' 行正常出现在成员添加列表）

## Self-Review 记录

- **Spec 覆盖**：§4.1 加载器与命名空间（T2）✓ §4.2 装配时机与快照（T3/T4）✓ §4.3 治理等价与审计标记（T4/T5）✓ §2.4 步骤 5（T8）✓ §3.3 reload 语义（T8）✓ 声明式激活三面（T6/T7）✓
- **占位符**：T2/T3 代码块完整；T4 的 assembleToolModules 抽取策略给了两条路径（以可测性裁定）
- **类型一致性**：PluginToolRef 在 T2/T3 双处引用同一来源（runtime-config.ts）；PluginToolModule.pluginSource 为 T5 消费点
- **Review Focus 落位**：五项分别钉 T2（#1/#2）、T3（#3）、T8（#4）、T6/T7（#5）
