# 插件平台「工作空间维度」补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件 config 支持声明式工作空间作用域（service 按工作区多实例）、面板支持 page 主区形态、agent 支持插件工具门控——根治「dape 工作空间索引挂错」类问题。

**Architecture:** manifest config 属性级 `scope: workspace|global`（默认 global，存量零影响）驱动双轨存储（`config.json` / `config.<wsId>.json`）与 service 多实例（running key `pluginId@workspaceId`）；面板放置沿用 panel.json 既有 `location` 字段扩 `page` 白名单（对 spec §6.1 的简化修订：声明位从 manifest components.panel 对象改为 panel.json 每面板 location——字段已存在，仅扩枚举）；agent 级工具门控走 `agent_definitions.denied_tools` 列 → AGENT_CONFIG → 既有 `assertToolAllowed` 强制点（运行时零改动）。

**Tech Stack:** Electron 主进程（CJS + better-sqlite3）+ React renderer（zustand）+ vitest 双 workspace。

**Spec:** `docs/specs/2026-10-17-plugin-workspace-dimension-design.md`（本计划从 spec 出发，执行者须同时读两者）

## Global Constraints

- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- 所有代码注释中文；标识符英文
- 测试位置铁律：主进程单测集中 `electron/tests/`（子目录镜像 src），renderer 贴源 colocated（`Foo.test.tsx` 同目录）——放错位置不执行
- electron DB 重度测试跑 `--pool=forks`；Node 20（`source ~/.nvm/nvm.sh && nvm use 20`）
- 提交：Conventional Commits + `GIT_MASTER=1 git` + Sisyphus trailer；特性 commit 不动版本号
- IPC 契约改动两 workspace 都要 typecheck（preload 三层 `../../../` 引 renderer types.d.ts）
- 改 IPC/跨模块面须遵守 momo-boundary-rules（ID 单点生成、生产者先行、契约两端同 commit）

## Review Focus（五类最可能咬人的输入/失效模式，测试钉在所属任务）

1. **存量无 scope 插件行为逐字节不变**——`normalizeConfigSchema` 不加 scope 时所有旧路径（config.json 单文件、单例 service key、旧 IPC 三参调用）结果与改造前一致。钉在 Task 1/2 的回归用例（旧测试全数不改动须通过）。
2. **多实例 key 前缀误伤**——`stopPluginService('a')` 不得停掉 `ab@ws`（前缀碰撞）；`pluginId@` 分隔符精确匹配。钉在 Task 2 专项用例。
3. **workspace 删除后的实例与配置残留**——删工作区须停其多实例 + 清 `config.<wsId>.json`；孤儿文件寻址天然跳过（不存在的 wsId 读不到即可）。钉在 Task 3 专项用例。
4. **lazy start 不半活**——多实例 lazy 启动失败不落 running（单实例语义保持）；start 失败后再次调用可重试。钉在 Task 2。
5. **deniedTools 模式串跨域误伤**——deny `plugin:codegraph/*` 不影响 builtin 工具；deny `read_file` 不影响 `plugin:codegraph/explore`；`plugin:a/*` 不匹配 `plugin:ab/x`。钉在 Task 4 permission 专项用例。

---

### Task 1: config-store 声明式作用域 + 双轨存储

**Files:**
- Modify: `electron/src/main/plugin/config-store.ts`
- Test: `electron/tests/plugin/config-store.test.ts`（追加，不动旧用例）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `ConfigPropertyDecl.scope?: 'workspace' | 'global'`
  - `readPluginConfigJson(pluginId: string, workspaceId?: string): Record<string, unknown>`
  - `writePluginConfig(pluginId, schema, values, workspaceId?): Promise<void>`
  - `getPluginConfigView(pluginId, schema, workspaceId?): { values; sensitiveConfigured; scopes: Record<string, 'workspace' | 'global'> }`（新增 `scopes` 供 renderer 徽标）
  - `resolvePluginConfig(pluginId, schema, workspaceId?): Promise<Record<string, unknown>>`
  - `deleteWorkspacePluginConfig(workspaceId: string): void`（遍历 listPlugins 删各插件 `config.<wsId>.json`）

- [ ] **Step 1: 写失败测试（schema 校验 + 分轨读写）**

追加到 `electron/tests/plugin/config-store.test.ts`（沿用该文件既有的临时 dataDir 注入手法）：

```typescript
describe('config 声明式作用域（工作空间维度 v1.1）', () => {
  const wsSchema = normalizeConfigSchema({
    type: 'object',
    properties: {
      root: { type: 'string', scope: 'workspace' },
      cmd: { type: 'string' },
    },
    required: ['root'],
  });

  it('scope 字段校验：合法值归一、缺省 global、非法值拒绝', () => {
    expect(wsSchema.properties.root?.scope).toBe('workspace');
    expect(wsSchema.properties.cmd?.scope).toBeUndefined();
    expect(() =>
      normalizeConfigSchema({ type: 'object', properties: { a: { type: 'string', scope: 'ws' } } }),
    ).toThrow(/scope/);
  });

  it('sensitive + workspace 组合拒绝（v1 非目标）', () => {
    expect(() =>
      normalizeConfigSchema({
        type: 'object',
        properties: { a: { type: 'string', sensitive: true, scope: 'workspace' } },
      }),
    ).toThrow(/sensitive.*workspace|workspace.*sensitive/);
  });

  it('workspace-scope 键写读落 config.<wsId>.json，global 键仍落 config.json', async () => {
    await writePluginConfig('p1', wsSchema, { root: '/ws-a', cmd: 'ls' }, 'ws-a');
    // 分文件断言
    expect(existsSync(join(dataDirOf('p1'), 'config.ws-a.json'))).toBe(true);
    expect(existsSync(join(dataDirOf('p1'), 'config.json'))).toBe(true);
    const view = getPluginConfigView('p1', wsSchema, 'ws-a');
    expect(view.values).toEqual({ cmd: 'ls', root: '/ws-a' });
    expect(view.scopes).toEqual({ root: 'workspace', cmd: 'global' });
  });

  it('不传 workspaceId：workspace-scope 键不写不校验，global 键照常', async () => {
    await writePluginConfig('p1', wsSchema, { cmd: 'ls' });
    expect(readPluginConfigJson('p1')).toEqual({ cmd: 'ls' });
    expect(readPluginConfigJson('p1', 'ws-a')).toEqual({});
  });

  it('required 校验按作用域分层：workspace 键缺省时无 wsId 写入被拒', async () => {
    await expect(writePluginConfig('p1', wsSchema, { cmd: 'x' }, 'ws-a')).rejects.toThrow(/必填/);
  });

  it('deleteWorkspacePluginConfig 清各插件的该工作区文件', async () => {
    await writePluginConfig('p1', wsSchema, { root: '/r' }, 'ws-a');
    deleteWorkspacePluginConfig('ws-a');
    expect(existsSync(join(dataDirOf('p1'), 'config.ws-a.json'))).toBe(false);
  });
});
```

（`dataDirOf` 用既有测试的 dataDir 注入辅助；registry 的 listPlugins 依赖按该测试文件已有 mock 手法处理。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/config-store.test.ts --pool=forks`
Expected: 新增用例 FAIL（`scope` 类型不存在 / 分文件不落盘）

- [ ] **Step 3: 实现**

`config-store.ts`：

```typescript
// ConfigPropertyDecl 增字段
export interface ConfigPropertyDecl {
  type: 'string' | 'number' | 'boolean';
  title?: string;
  sensitive?: boolean;
  /** 工作空间维度 v1.1：声明式作用域（默认 global；sensitive 组合拒绝） */
  scope?: 'workspace' | 'global';
  enum?: (string | number)[];
}

// normalizeConfigSchema 内 allowed 集合加 'scope'，循环体内追加：
if (d.scope !== undefined) {
  if (d.scope !== 'workspace' && d.scope !== 'global') throw new Error(`config.scope 须为 workspace/global: ${key}`);
  if (d.scope === 'workspace' && d.sensitive === true) {
    throw new Error(`config 组合不支持：sensitive 属性 ${key} 不能声明 scope: workspace`);
  }
  out.scope = d.scope;
}

// workspace 层文件路径（同目录分文件）
function workspaceConfigPath(dataDir: string, workspaceId: string): string {
  // workspaceId 为 UUID 形态（无路径字符）；防御性再校验一层
  if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) throw new Error(`workspaceId 非法: ${workspaceId}`);
  return path.join(dataDir, `config.${workspaceId}.json`);
}

// readPluginConfigJson 增可选参（内部分流，旧调用点零改动）
export function readPluginConfigJson(pluginId: string, workspaceId?: string): Record<string, unknown> {
  const base = resolvePluginDataDir(pluginId);
  const file = workspaceId ? workspaceConfigPath(base, workspaceId) : path.join(base, 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
```

`writePluginConfig`：拆分 `finalPlain`（global 层）与 `finalWs`（workspace 层）——按 `decl.scope` 分桶合并各自现值；required 校验：workspace-scope 键仅在传了 `workspaceId` 时纳入校验（无 wsId 的写入不触碰该层）；两层各自 tmp+rename 原子写（workspace 层仅在非空变更时写）。

`getPluginConfigView`：`values = { ...readPluginConfigJson(id), ...(workspaceId ? readPluginConfigJson(id, workspaceId) : {}) }`；新增 `scopes` 映射（遍历 schema.properties 取 `decl.scope ?? 'global'`）。

`resolvePluginConfig`：`{ ...global, ...(wsId ? ws层 : {}), ...敏感缓存 }`。

`deleteWorkspacePluginConfig`（新导出，文件尾部）：

```typescript
import { listPlugins } from './registry'; // 顶部（registry 不反向依赖本文件，无环）

/** 工作区删除清理：各插件的 config.<wsId>.json（孤儿不参与读取，此处仅物理清理） */
export function deleteWorkspacePluginConfig(workspaceId: string): void {
  for (const rec of listPlugins()) {
    const f = workspaceConfigPath(resolvePluginDataDir(rec.id), workspaceId);
    try { fs.rmSync(f, { force: true }); } catch { /* 清理失败不阻塞删除主流程 */ }
  }
}
```

- [ ] **Step 4: 跑测试通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/config-store.test.ts --pool=forks`
Expected: 全 PASS（含全部旧用例——存量零影响回归）

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/plugin/config-store.ts electron/tests/plugin/config-store.test.ts
GIT_MASTER=1 git commit -m 'feat: 插件 config 声明式作用域——workspace/global 分轨存储与分层校验' 
```

---

### Task 2: service-manager 多实例生命周期

**Files:**
- Modify: `electron/src/main/plugin/service-manager.ts`
- Test: `electron/tests/plugin/service-manager.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `readPluginConfigJson(pluginId, workspaceId?)`
- Produces:
  - `startPluginService(rec: PluginRecord, workspaceId?: string): Promise<boolean>`
  - `callPluginService(pluginId, method, params, workspaceId?: string): Promise<unknown>`（lazy start）
  - `stopPluginService(pluginId: string): Promise<void>`（语义变更：停该插件**全部** key）
  - `onWorkspaceSwitched(nextWorkspaceId: string | null): Promise<void>`（停非当前多实例）
  - `PluginServiceCtx.workspace?: { id: string; directoryPath: string }`
  - `pluginUsesWorkspaceScope(rec: PluginRecord): boolean`（导出供 IPC 层判定，内部用）

- [ ] **Step 1: 写失败测试**

`electron/tests/plugin/service-manager.test.ts` 追加（沿用该文件既有 fake service 模块手法）：

```typescript
describe('service 多实例（工作空间维度 v1.1）', () => {
  it('多实例 key：同插件不同工作区两个实例，getConfig 合并两层', async () => {
    // wsKey 插件（config 含 scope:workspace 的 workspaceRoot）+ 预置两份 ws 配置
    const r1 = await startPluginService(rec, 'ws-a');
    const r2 = await startPluginService(rec, 'ws-b');
    expect(r1 && r2).toBe(true);
    expect(isServiceRunning('codegraph')).toBe(true); // 任一实例在跑
    await callPluginService('codegraph', 'getConfigEcho', null, 'ws-a'); // 各自路由
  });

  it('纯 global 插件保持单例：workspaceId 参数被忽略', async () => { /* fake 插件无 ws-scope 配置 */ });

  it('stopPluginService 前缀精确：停 a 不伤 ab@ws', async () => {
    await startPluginService(recA, 'ws-a'); // a 多实例
    await startPluginService(recAB, 'ws-a'); // ab 多实例
    await stopPluginService('a');
    expect(isServiceRunning('ab')).toBe(true);
  });

  it('callPluginService lazy start：无实例时按 workspaceId 拉起；失败不落注册表可重试', async () => {
    await expect(callPluginService('codegraph', 'x', null, 'ws-a')).resolves.toBeDefined();
    // 坏插件（createService 抛错）：reject 且 isServiceRunning false，再次调用再次尝试
  });

  it('onWorkspaceSwitched 停非当前多实例，单例与当前实例保留', async () => { /* ... */ });

  it('ctx.workspace 注入：directoryPath 来自 workspaces 表', async () => { /* db mock 预置行 */ });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/service-manager.test.ts --pool=forks`
Expected: FAIL（`pluginUsesWorkspaceScope` 等不存在 / 签名不匹配）

- [ ] **Step 3: 实现**

`service-manager.ts` 核心改动（保持既有注释风格）：

```typescript
import { getDb } from '../storage/db';
import { normalizeConfigSchema } from './config-store';

/** manifest config 是否含 workspace-scope 属性（决定多实例形态） */
export function pluginUsesWorkspaceScope(rec: PluginRecord): boolean {
  try {
    const manifest = JSON.parse(rec.manifestJson) as { config?: unknown };
    if (!manifest.config) return false;
    const schema = normalizeConfigSchema(manifest.config);
    return Object.values(schema.properties).some((d) => d.scope === 'workspace');
  } catch {
    return false;
  }
}

/** running key：多实例插件 `pluginId@workspaceId`，纯 global 插件 pluginId */
function serviceKey(pluginId: string, workspaceId: string | undefined, multi: boolean): string {
  return multi && workspaceId ? `${pluginId}@${workspaceId}` : pluginId;
}

function workspaceDirOf(workspaceId: string): string | null {
  try {
    const row = getDb().prepare('SELECT directory_path FROM workspaces WHERE id = ?').get(workspaceId) as { directory_path?: string } | undefined;
    return row?.directory_path ?? null;
  } catch { return null; }
}
```

`startPluginService(rec, workspaceId?)`：`const multi = pluginUsesWorkspaceScope(rec);` 若 `multi && !workspaceId` 直接 `return false`（无可索引上下文，lazy 兜底）；key 换 `serviceKey(...)`；`getConfig` 改 `() => ({ ...readPluginConfigJson(rec.id), ...(multi ? readPluginConfigJson(rec.id, workspaceId) : {}), ...sensitiveOverlaySync(rec.id) })`；ctx 增：

```typescript
const wsDir = workspaceId ? workspaceDirOf(workspaceId) : null;
// ctx 内：
workspace: multi && workspaceId && wsDir ? { id: workspaceId, directoryPath: wsDir } : undefined,
```

`stopPluginService(pluginId)`：改为前缀精确匹配（`k === pluginId || k.startsWith(pluginId + '@')`）逐个停。

`callPluginService(pluginId, method, params, workspaceId?)`：

```typescript
export async function callPluginService(
  pluginId: string, method: string, params: unknown, workspaceId?: string,
): Promise<unknown> {
  const rec = getPluginRecordSafe(pluginId); // registry.getPlugin 懒导入（防环：registry 不依赖本文件）
  const multi = rec ? pluginUsesWorkspaceScope(rec) : false;
  const key = serviceKey(pluginId, workspaceId, multi);
  let instance = running.get(key) ?? (multi ? undefined : running.get(pluginId));
  if (!instance) {
    // lazy start（spec §5.2）：失败原样抛（不半活语义保持），下次调用可重试
    if (!rec) throw new Error(`插件 ${pluginId} 的 service 未运行`);
    const ok = await startPluginService(rec, workspaceId);
    if (!ok) throw new Error(`插件 ${pluginId} 的 service 未运行`);
    instance = running.get(key);
    if (!instance) throw new Error(`插件 ${pluginId} 的 service 未运行`);
  }
  return instance.handle(method, params);
}

/** 工作区切换（workspace:switch 链路调用）：停非当前工作区的多实例；单例不动 */
export async function onWorkspaceSwitched(next: string | null): Promise<void> {
  const keys = [...running.keys()].filter((k) => k.includes('@') && k.split('@')[1] !== next);
  await Promise.allSettled(keys.map((k) => stopPluginService(k.split('@')[0]!, { onlyKey: k })));
}
```

（`stopPluginService` 增可选第二参 `{ onlyKey?: string }` 精确停单 key——默认停全部前缀 key；`@` 不会出现在 pluginId（slug 白名单）与 UUID workspaceId 中，split 安全。`isServiceRunning(pluginId)` 改为任一前缀 key 存在即 true。`stopAllPluginServices` 现状遍历全部 key 已天然兼容。）

- [ ] **Step 4: 跑测试通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/service-manager.test.ts --pool=forks`
Expected: 全 PASS（旧用例零改动通过——无 workspaceId 的调用路径行为不变）

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/plugin/service-manager.ts electron/tests/plugin/service-manager.test.ts
GIT_MASTER=1 git commit -m 'feat: 插件 service 工作区多实例——lazy 启动/切换停非当前/禁用前缀齐停'
```

---

### Task 3: IPC 契约 + 桥接 + 活动工作区单点 + 工作区删除清理

**Files:**
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（getConfig/setConfig/callService 增 workspaceId 参；新增 listAssembledTools 在 Task 6）
- Modify: `electron/src/main/workspace/ipc.handlers.ts`（switch 处记录活动工作区 + 删除时清理插件面）
- Modify: `electron/src/main/agent/plugin-hook-bridge.ts`（消息增 workspaceId）
- Modify: `electron/src/main/agent/runtime-spawner.ts`（~:360 plugin: 分发处透传 workspaceId）
- Modify: `electron/src/main/agent/tools/plugin-tools.ts`（PluginToolCtx 增 workspace）
- Modify: `electron/src/main/agent/runtime-config.ts`（PluginToolRef 增 workspace 字段）
- Modify: `electron/src/main/plugin/assembly.ts`（buildPluginToolRefs 填 workspace）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`（契约同步）
- Test: `electron/tests/plugin/ipc-handlers.test.ts`、`electron/tests/agent/tools/plugin-tools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `writePluginConfig/getPluginConfigView`（带 wsId）、Task 2 `startPluginService/callPluginService/onWorkspaceSwitched`
- Produces:
  - `getActiveWorkspaceId(): string | null`（workspace/ipc.handlers.ts 导出，main 进程活动工作区单点）
  - IPC 通道签名变更：`plugin:getConfig (pluginId, workspaceId?)` / `plugin:setConfig (pluginId, values, workspaceId?)` / `plugin:callService (pluginId, method, params, workspaceId?)`
  - `PluginToolRef.workspace?: { id: string; directoryPath: string }`（AGENT_CONFIG 内 JSON 序列化随快照透传）
  - `PluginToolCtx.workspace?: { id: string; directoryPath: string }`

- [ ] **Step 1: 写失败测试**

`electron/tests/plugin/ipc-handlers.test.ts` 追加：

```typescript
it('plugin:setConfig 传 workspaceId：workspace 层落盘 + 仅重启该工作区实例', async () => { /* mock db + fake service */ });
it('plugin:getConfig 带 workspaceId 返回合并视图与 scopes', async () => { /* ... */ });
it('workspace:delete 后调用清理：config.<wsId>.json 消失 + 该 ws 实例停止', async () => { /* ... */ });
```

`electron/tests/agent/tools/plugin-tools.test.ts` 追加：

```typescript
it('PluginToolCtx 注入 workspace（ref.workspace 透传）', () => {
  // refs 带 workspace: { id: 'ws-a', directoryPath: '/tmp/ws-a' } → ctx.workspace 同值
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/ipc-handlers.test.ts tests/agent/tools/plugin-tools.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现**

`workspace/ipc.handlers.ts`：

```typescript
// 模块级活动工作区单点（renderer boot 的 load()→switch 通知 + 用户切换共灌此值）
let currentActiveWorkspaceId: string | null = null;
export function getActiveWorkspaceId(): string | null { return currentActiveWorkspaceId; }

// 'workspace:switch' handler 内追加：
currentActiveWorkspaceId = id;
void onWorkspaceSwitched(id).catch(() => undefined); // 插件多实例切换停（fire-and-forget）

// 'workspace:delete' handler 内（删除事务成功后）追加：
deleteWorkspacePluginConfig(id);
await stopAllWorkspaceInstances(id).catch(() => undefined); // service-manager 新导出：停该 ws 全部多实例
```

（`stopAllWorkspaceInstances(workspaceId)`：Task 2 文件内新增导出——遍历 running key 中 `@${workspaceId}` 后缀者停之。）

`ipc.handlers.ts`（plugin）：

```typescript
ipcMain.handle('plugin:getConfig', async (_evt, pluginId: string, workspaceId?: string) => {
  // ...既有逻辑，getPluginConfigView(pluginId, schema, workspaceId) 透传 + 回包加 scopes
});
ipcMain.handle('plugin:setConfig', async (_evt, pluginId, values, workspaceId?) => {
  await writePluginConfig(pluginId, schema, values, workspaceId);
  // service 重启语义（多实例版）：multi && workspaceId → 仅 stop/start 该 ws 实例；
  // 否则维持既有「stop 全部 + stillEnabled 门 start」——start 目标改为 getActiveWorkspaceId()
  //（无活动 ws 时跳过 start，lazy 兜底）
});
ipcMain.handle('plugin:callService', (_evt, pluginId: string, method: string, params: unknown, workspaceId?: string) =>
  callPluginService(pluginId, method, params ?? null, workspaceId));
```

`runtime-config.ts` `PluginToolRef` 增字段 `workspace?: { id: string; directoryPath: string }`（注释：装配定型快照，§3.3 冻结语义）。

`assembly.ts` `buildPluginToolRefs`：

```typescript
import { getDb } from '../storage/db';
// enabledPlugins 内或 flatMap 前：
const wsRow = getDb().prepare('SELECT id, directory_path FROM workspaces WHERE id = ?').get(workspaceId) as { id: string; directory_path: string } | undefined;
const ws = wsRow ? { id: wsRow.id, directoryPath: wsRow.directory_path } : undefined;
// ref 增：workspace: ws,
```

`plugin-tools.ts`：`PluginToolCtx` 增 `workspace?: { id: string; directoryPath: string }`；组装处 `workspace: ref.workspace`；`callService` 调用改 `requestPluginCallService(ref.pluginId, method, params, ref.workspace?.id)`。

`plugin-hook-bridge.ts`：`requestPluginCallService(pluginId, method, params, workspaceId?)`——出站消息增 `workspaceId` 字段（沿用既有消息形状与 requestId 语义；缺省不带——旧子进程消息向后兼容，主进程侧 `m.workspaceId` 为 undefined 走单例/懒启动回退）。

`runtime-spawner.ts` plugin 分发处（~:360）：`callPluginService(m.pluginId, m.method, m.params, m.workspaceId)`（字段名以桥两端实际协议为准——**两端同 commit**，momo-boundary-rules）。

renderer `types.d.ts`：

```typescript
// plugin 域接口变更（同形同步 preload）：
getConfig(pluginId: string, workspaceId?: string): Promise<PluginConfigView | null>;
setConfig(pluginId: string, values: Record<string, string | number | boolean | null>, workspaceId?: string): Promise<PluginConfigView>;
callService(pluginId: string, method: string, params: unknown, workspaceId?: string): Promise<unknown>;
// PluginConfigView 增 scopes: Record<string, 'workspace' | 'global'>；PluginPanelInfo 增 placement（Task 5 一并）
```

`preload/index.ts` plugin 段参数透传对齐。

- [ ] **Step 4: 确认通过 + 双 workspace typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/ipc-handlers.test.ts tests/agent/tools/plugin-tools.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / tc=0

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 插件面工作空间上下文贯通——IPC 三通道 wsId 参 + 活动工作区单点 + 工具 ref/service ctx 注入 + 工作区删除清理'
```

---

### Task 4: denied_tools 迁移 + agent 域存储与装配

**Files:**
- Create: `electron/src/main/storage/migrations/061_agent_denied_tools.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（登记 061）
- Modify: `electron/src/main/agent/crud.ts`（createCustom/updateDefinition/行映射 deniedTools）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（读列 → AGENT_CONFIG）
- Modify: `electron/src/main/agent/runtime-config.ts`（AGENT_CONFIG 序列化/解析含 deniedTools——parse 面若为显式字段清单则补字段）
- Modify: `renderer/src/ipc/types.d.ts`（AgentDefinition 增 deniedTools: string[]）
- Test: `electron/tests/storage/migrations.test.ts`（或迁移测试惯例位）、`electron/tests/agent/runtime-config.test.ts`、`electron/src/main/agent/tools/shared/permission` 对应测试文件追加 plugin 前缀用例

**Interfaces:**
- Produces: `AgentDefinition.deniedTools: string[]`（JSON 数组，默认 []）；AGENT_CONFIG 增 `deniedTools: string[]`（运行时接口已有该字段——本任务打通主进程写入与解析）

- [ ] **Step 1: 写失败测试**

```typescript
// 迁移测试（按既有迁移测试惯例）：
it('061: agent_definitions 增 denied_tools 列，默认 []', () => { /* 升级后 PRAGMA table_info 含列且 default '[]' */ });

// runtime-config 测试：
it('AGENT_CONFIG 带 deniedTools 解析保真（含 plugin:codegraph/* 模式串）', () => { /* 序列化→parse 往返 */ });

// permission 测试（tools/shared/permission 对应测试文件）：
it('deny plugin:codegraph/* 命中 explore/status，不伤 builtin 与 plugin:codegraph2/*', () => {
  const cfg = { allowedTools: [], deniedTools: ['plugin:codegraph/*'] };
  expect(isDenied('plugin:codegraph/explore', cfg)).toBe(true);
  expect(isDenied('read_file', cfg)).toBe(false);
  expect(isDenied('plugin:codegraph2/x', cfg)).toBe(false);
});
it('deny 精确名 read_file 不影响 plugin 工具', () => { /* ... */ });
```

（`isDenied`/既有导出名以 permission.ts 实际为准——matchToolPattern 语义用例化。）

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-config.test.ts tests/agent/tools --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现**

`061_agent_denied_tools.ts`（照抄 060 文件骨架）：

```typescript
// 插件工作空间维度 v1.1（spec 2026-10-17 §7.1）：agent 级工具门控存储。
// 模式串语法复用 tools/shared/permission.ts matchToolPattern（plugin:<id>/* 前缀 + 精确名）。
export const migration061 = {
  version: 61,
  up: `ALTER TABLE agent_definitions ADD COLUMN denied_tools TEXT NOT NULL DEFAULT '[]';`,
};
```

`index.ts` 登记（import + MIGRATIONS 尾追加，照 060 惯例）。

`crud.ts`：`createCustom`/`updateDefinition` 输入增 `deniedTools?: string[]`（校验：string 数组、每项 `^[a-zA-Z0-9_:/*-]+$`）；INSERT/UPDATE 落 `JSON.stringify(deniedTools ?? [])`；定义行映射 parse（坏 JSON → [] 容错）。`AgentDefinition` 主进程类型同步增字段。

`spawn-helpers.ts`（buildSpawnOpts 组装处，pluginTools 注入附近）：

```typescript
// 插件工作空间维度 v1.1：agent 级工具门控（spec §7.2）——def 列 → AGENT_CONFIG，
// 强制点 doExecuteTool→assertToolAllowed 现成（plugin:* 天然覆盖）
deniedTools: parseDeniedTools(def.deniedTools),
```

`runtime-config.ts`：AGENT_CONFIG 的 serialize/parse 显式字段清单（若存在）补 `deniedTools: string[]`（默认 []——旧消息缺字段容错）。

- [ ] **Step 4: 确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent tests/storage --pool=forks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: agent 级插件工具门控——denied_tools 列 + AGENT_CONFIG 透传 + permission 前缀用例'
```

---

### Task 5: 面板 page 形态（panel.json location 扩白名单 + 主区视图）

**Files:**
- Modify: `electron/src/main/plugin/panel-sync.ts`（ALLOWED_LOCATIONS + PluginPanelInfo.placement）
- Modify: `renderer/src/ipc/types.d.ts`（PluginPanelInfo.placement）
- Modify: `renderer/src/stores/ui.store.ts`（ViewKey 增 'plugin'）
- Modify: `renderer/src/stores/plugin-panels.store.ts`（activate 分流辅助）
- Modify: `renderer/src/components/layout/ActivityBar.tsx`（page 面板点击 → setActiveView('plugin')）
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（activeView==='plugin' → 全宽 PanelHost）
- Modify: `renderer/src/components/layout/ViewSidebar.tsx`（sidebar 面板模式跳过 page 面板）
- Create: `renderer/src/components/plugins/PanelPageView.tsx`（全宽外壳，复用 PanelHost）
- Modify: `plugins/codegraph/panel/panel.json`（location: 'page'）
- Modify: `docs/specs/2026-10-17-plugin-workspace-dimension-design.md`（§6.1 一行修订：声明位 = panel.json location 字段）
- Test: `electron/tests/plugin/panel-sync.test.ts`、`renderer/src/components/layout/ViewSidebar.test.tsx`、`renderer/src/stores/plugin-panels.store.test.ts`（追加）

**Interfaces:**
- Produces: `PluginPanelInfo.placement: 'sidebar' | 'page'`（缺省 'sidebar'——renderer 侧对旧数据容错）；`ViewKey` 含 `'plugin'`

- [ ] **Step 1: 写失败测试**

```typescript
// panel-sync.test.ts：
it('panel.json location: page 合法并透传 placement', () => { /* validatePanelsAtRoot + listPluginPanels */ });
it('location 非法值仍拒绝（sidebar|page 外）', () => { /* ... */ });

// plugin-panels.store.test.ts：
it('page 面板激活走 activeView=plugin，sidebar 面板维持 activeKey 侧栏模式', () => { /* ... */ });
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/panel-sync.test.ts --pool=forks && cd ../renderer && npx pnpm@9.0.0 vitest run src/stores/plugin-panels.store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`panel-sync.ts`：

```typescript
export interface PanelDecl { id: string; title: string; icon: string; location: 'sidebar' | 'page'; entry: string; }
export interface PluginPanelInfo { /* 既有字段 */ placement: 'sidebar' | 'page'; }
const ALLOWED_LOCATIONS = ['sidebar', 'page'] as const;
// 校验分支改：p.location ∈ ALLOWED_LOCATIONS；out.location = p.location ?? 'sidebar'
// listPluginPanels 输出增：placement: d.location
```

`ui.store.ts`：`export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings' | 'tasks' | 'plugin';`（注释：plugin = 插件主区页面态，具体面板由 plugin-panels.store.activeKey 决定）

`ActivityBar.tsx` 面板按钮 onClick：

```tsx
onClick={() => {
  if (active) { deactivatePanel(); if (p.placement === 'page') setActiveView('im'); return; }
  activatePanel(key);
  if (p.placement === 'page') setActiveView('plugin');
}}
```

`MiddlePanel.tsx`：既有视图分发顶部加：

```tsx
{activeView === 'plugin' && <PanelPageView />}
```

`PanelPageView.tsx`（新，注释中文，样式全 token）：

```tsx
// 插件主区页面（工作空间维度 v1.1 spec §6.2）：page 面板的全宽宿主。
// 复用 PanelHost（iframe 沙箱 + PanelChannel 五消息全量）；退出 = deactivate + 回会话视图。
import { useUiStore } from '../../stores/ui.store';
import { usePluginPanelsStore, panelKeyOf } from '../../stores/plugin-panels.store';
import { PanelHost } from './PanelHost';

export function PanelPageView() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const panels = usePluginPanelsStore((s) => s.panels);
  const activeKey = usePluginPanelsStore((s) => s.activeKey);
  const deactivate = usePluginPanelsStore((s) => s.deactivate);
  const panel = activeKey === null ? null : (panels.find((p) => panelKeyOf(p) === activeKey) ?? null);
  const pagePanel = panel?.placement === 'page' ? panel : null;
  if (!pagePanel) return null; // 悬空防御：activeKey 失效/属 sidebar 面板时不渲染
  const exit = (): void => { deactivate(); setActiveView('im'); };
  return (
    <div className="h-full w-full bg-canvas">
      <PanelHost panel={pagePanel} onExit={exit} />
    </div>
  );
}
```

`ViewSidebar.tsx` 面板模式分支：`const activePanel = ...?.placement === 'sidebar' ? x : null`（page 面板不占侧栏槽）。

`plugins/codegraph/panel/panel.json`：面板项增 `"location": "page"`。

spec §6.1 修订一行（保持单一真相）：「声明位为 panel.json 每面板 `location` 字段（既有字段扩枚举），非 manifest components.panel 对象形态」。

- [ ] **Step 4: 确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/panel-sync.test.ts --pool=forks && cd ../renderer && npx pnpm@9.0.0 vitest run src/components/layout src/stores/plugin-panels.store.test.ts && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / tc=0

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 插件面板 page 主区形态——panel.json location 扩枚举 + 活动栏分流 + PanelPageView 全宽宿主'
```

---

### Task 6: 插件工具目录 IPC + DefinitionEditor 门控 UI + 设置页作用域徽标

**Files:**
- Create: `electron/src/main/plugin/tool-catalog.ts`（listAssembledToolDefs + 缓存）
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（plugin:listAssembledTools 通道）
- Modify: `electron/src/main/plugin/reload.ts` / `installer.ts`（卸载/重载时失效缓存）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`
- Create: `renderer/src/lib/usePluginTools.ts`（镜像 useToolCatalog 手法）
- Modify: `renderer/src/components/agent/DefinitionEditor.tsx`（插件工具分组 + deniedTools 状态与提交）
- Modify: `renderer/src/components/settings/PluginSettings.tsx`（workspace 徽标 + 一次性迁移提示 banner）
- Test: `electron/tests/plugin/tool-catalog.test.ts`（新）、`renderer/src/components/agent/DefinitionEditor.test.tsx`、`renderer/src/components/settings/PluginSettings.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 3 `PluginToolRef.workspace`、Task 4 `AgentDefinition.deniedTools`
- Produces:
  - IPC `plugin:listAssembledTools(workspaceId): Promise<Array<{ pluginId: string; pluginName: string; toolName: string; fullName: string; description: string }>>`（fullName = `plugin:<id>/<短名>`）
  - `usePluginTools(workspaceId | null): { data: PluginToolInfo[] | null; error: string | null }`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/plugin/tool-catalog.test.ts（新，fake 插件目录手法照 service-manager 测试）：
it('列出启用插件的工具名——createTools 实例化取 name/description', () => { /* ... */ });
it('禁用插件不列出；坏模块进 failures 不拖垮', () => { /* ... */ });
it('缓存失效：reload/uninstall 后重列', () => { /* ... */ });

// DefinitionEditor.test.tsx 追加：
it('插件工具分组渲染：组头开关写 plugin:id/*，单工具开关写精确名；组内部分启用时展开为精确名集合', () => { /* ... */ });
it('保存携带 deniedTools（create 与 edit 两路）', () => { /* ... */ });
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/tool-catalog.test.ts --pool=forks && cd ../renderer && npx pnpm@9.0.0 vitest run src/components/agent/DefinitionEditor.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`tool-catalog.ts`（新；加载手法照 service-manager 的 createRequire + 模块缓存失效）：

```typescript
// 插件工具目录（工作空间维度 v1.1 spec §7.3）：主进程实例化启用插件的工具模块，
// 取静态 name/description 供 agent 配置 UI 渲染。装了即信模型下主进程持模块可接受
// （与 service 同权限级）；缓存按插件失效（reload/uninstall 调 invalidatePluginToolCatalog）。
import { createRequire } from 'node:module';
import { buildPluginToolRefs } from './assembly';
import type { PluginToolCtx } from '../agent/tools/plugin-tools';

export interface PluginToolInfo { pluginId: string; pluginName: string; toolName: string; fullName: string; description: string; }

const stubCtx: PluginToolCtx = {
  getConfig: () => ({}),
  getDataDir: () => '',
  logger: { warn: () => undefined, info: () => undefined },
  callService: () => Promise.reject(new Error('目录探测不可调用 service')),
};

export function listAssembledToolDefs(workspaceId: string): PluginToolInfo[] { /* buildPluginToolRefs → 逐 module createRequire require → createTools(stubCtx) → 收集 */ }
export function invalidatePluginToolCatalog(): void { /* require 缓存清理 */ }
```

`ipc.handlers.ts`：`ipcMain.handle('plugin:listAssembledTools', (_evt, workspaceId: string) => listAssembledToolDefs(workspaceId));`

`reload.ts`/`installer.ts`：reload 成功与 uninstall 时调 `invalidatePluginToolCatalog()`（紧邻既有 `notifyPanelsChanged()` 调用点）。

`usePluginTools.ts`（照 useToolCatalog 的请求/错误态手法）+ types.d.ts/preload 契约。

`DefinitionEditor.tsx`：

```tsx
// 状态：const [deniedTools, setDeniedTools] = useState<string[]>(def?.deniedTools ?? []);
// 数据：const { data: pluginTools } = usePluginTools(mode === 'create' ? null : activeWorkspaceId);
// 能力配置区下方新增分组（isBuiltin 只读展示）：
//   每插件一个 fieldset：组头 Switch（全开=无该插件任何模式串；全关=plugin:<id>/*）
//   组内每工具 Switch（精确名 plugin:<id>/<name>）
// 开关换算纯函数（导出供测试）：
export function computeDeniedTools(
  current: string[], pluginId: string, toolFullNames: string[], changed: string, on: boolean,
): string[] {
  const group = `plugin:${pluginId}/*`;
  if (!on) {
    const base = current.filter((p) => p !== group); // 摘组模式，展开为精确集
    const others = toolFullNames.filter((n) => n !== changed && !current.includes(n) && current.includes(group));
    return [...base, changed, ...others];
  }
  return current.filter((p) => p !== changed && p !== group);
}
// 提交：createCustom/updateDefinition 输入增 deniedTools
```

`PluginSettings.tsx`：workspace-scope 字段标题旁 `按工作空间` Badge（`info` tone）；组件顶部一次性提示（`localStorage['momo.pluginWsConfigHint.v1']` 未置时渲染，关闭即置位）：「按工作空间的配置项独立保存于每个工作空间，留空时部分插件将使用工作空间目录默认值」。

- [ ] **Step 4: 确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin --pool=forks && cd ../renderer && npx pnpm@9.0.0 vitest run src/components/agent/DefinitionEditor.test.tsx src/components/settings && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / tc=0

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: agent 配置插件工具门控 UI——listAssembledTools 目录 + DefinitionEditor 分组开关 + 设置页作用域徽标'
```

---

### Task 7: codegraph 插件适配（默认跟随 + page 声明）

**Files:**
- Modify: `plugins/codegraph/momo-plugin.json`（workspaceRoot: scope workspace + 出 required；panel location 已在 Task 5 改）
- Modify: `plugins/codegraph/service/index.js`（root = cfg.workspaceRoot ?? ctx.workspace.directoryPath）
- Modify: `plugins/codegraph/tools/explore.js` / `status.js`（同款默认跟随——经 ctx.workspace）
- Test: `electron/tests/plugin/codegraph-service.test.ts`、`electron/tests/plugin/codegraph-tools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 `ctx.workspace`、Task 3 `PluginToolCtx.workspace`

- [ ] **Step 1: 写失败测试**

```typescript
// codegraph-service.test.ts：
it('workspaceRoot 留空默认跟随 ctx.workspace.directoryPath（dape 案回归锁 A2）', async () => {
  // ctx.workspace = { id: 'ws-a', directoryPath: '/tmp/fake-ws' }，config 无 workspaceRoot
  // start 后 status 返回 files>0（索引了 /tmp/fake-ws 下样本文件）
});
it('显式 workspaceRoot 优先生效', () => { /* ... */ });

// codegraph-tools.test.ts：
it('explore 无 workspaceRoot 配置时用 ctx.workspace.directoryPath 定位', () => { /* ... */ });
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/codegraph-service.test.ts tests/plugin/codegraph-tools.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现**

`momo-plugin.json`：

```json
"config": {
  "type": "object",
  "properties": {
    "workspaceRoot": { "type": "string", "title": "索引根目录（留空=当前工作空间目录）", "scope": "workspace" },
    "indexCommand": { "type": "string", "title": "自定义索引命令（可选，留空用内置引擎）" },
    "maxFiles": { "type": "number", "title": "最大索引文件数" }
  }
}
```

（required 移除——留空合法。）

`service/index.js`（createService 内 root 解析处）：

```javascript
// 工作空间维度 v1.1：留空默认跟随工作区目录（spec §4.4）
const root = (cfg.workspaceRoot && String(cfg.workspaceRoot).trim()) || (ctx.workspace && ctx.workspace.directoryPath);
if (!root) throw new Error('codegraph service：workspaceRoot 未配置且无工作区上下文');
```

`tools/explore.js` / `status.js`：同款 `(cfg.workspaceRoot && String(cfg.workspaceRoot).trim()) || (ctx.workspace && ctx.workspace.directoryPath)`（ctx 形状以 PluginToolCtx 实际注入为准——Task 3 已加 workspace 字段）。

- [ ] **Step 4: 确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin --pool=forks`
Expected: PASS（含全部旧用例）

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add plugins/codegraph && GIT_MASTER=1 git commit -m 'feat: codegraph 工作空间适配——workspaceRoot 按工作空间配置 + 留空默认跟随 + page 面板'
```

---

### Task 8: 全量回归 + 真机验收锚点 + 收尾

**Files:**
- Modify: `CHANGELOG.md`（新条目置于最上）
- 验收产物：`.omo/qa-reports/2026-10-17-plugin-workspace-dimension/`（gitignored）

- [ ] **Step 1: 全量回归**

```bash
source ~/.nvm/nvm.sh && nvm use 20
cd /Users/stbearangel/dev/AiProject/moo-studio
npx pnpm@9.0.0 typecheck          # 期望 tc=0
npx pnpm@9.0.0 --filter momo-studio-electron test   # 全绿
npx pnpm@9.0.0 --filter momo-studio-renderer test   # 全绿
# vitest 非正常退出后孤儿检查（AGENTS.md 陷阱表）
```

- [ ] **Step 2: 真机验收（momo-acceptance 技能，隔离实例 + CDP）**

按 spec §9.2 四锚点出报告：
- A1 双工作区索引互不串：建 ws-a/ws-b 两工作区（各自目录放不同样本符号）→ 两边会话各自 explore 返回各自符号
- A2 留空默认跟随：codegraph 全空配置 → dape 场景（或等价第二工作区）查询返回其目录符号
- A3 page 面板：代码图谱按钮 → 主区全宽渲染；禁用 → 按钮+视图消失；复启复活
- A4 工具门控：某 agent 关闭 codegraph 整插件 → 该 agent 会话调用被拒（审计可见）；另一 agent 不受影响

- [ ] **Step 3: CHANGELOG + 提交**

```markdown
## [未发布] — 插件平台工作空间维度补全

config 声明式作用域（scope: workspace/global 分轨存储）+ service 工作区多实例（lazy 启动/切换停/禁用齐停）+ 面板 page 主区形态（panel.json location 扩枚举，codegraph 迁移）+ agent 级插件工具门控（denied_tools + 配置 UI 分组开关）+ codegraph 留空默认跟随工作区目录（dape 索引挂错案根治）。验收锚点 A1-A4 全过（真机 CDP）。
```

```bash
GIT_MASTER=1 git add CHANGELOG.md && GIT_MASTER=1 git commit -m 'docs: 工作空间维度补全 CHANGELOG 条目'
```

- [ ] **Step 4: 推送 + 任务收口**

```bash
GIT_MASTER=1 git push origin main
```

（推送前征得用户确认；验收报告路径与 keychain 残留披露照 momo-acceptance 惯例。）

---

## 自审记录（写完计划后过检）

1. **Spec 覆盖**：§4（Task 1/3）、§5（Task 2/3）、§6（Task 5 + spec 一行修订）、§7（Task 4/6）、§8（Task 5 manifest 变更 + Task 6 banner + Task 7）、§9（各任务测试 + Task 8 A1-A4）、§10（无新攻击面——设计约束在实现中保持）✓
2. **占位符**：测试骨架中 `/* ... */` 处为「沿用既有 mock 手法」的既定模式引用（对应文件已有同类用例），非未设计逻辑；核心逻辑（computeDeniedTools、serviceKey、默认跟随）均给出完整代码 ✓
3. **类型一致**：`PluginToolRef.workspace` / `PluginToolCtx.workspace` / `PluginServiceCtx.workspace` 三处同形 `{ id, directoryPath }`；`scopes` 映射只在 getPluginConfigView 产出、PluginSettings 消费 ✓
4. **Review Focus 落位**：#1→Task 1/2 旧用例回归；#2→Task 2 前缀用例；#3→Task 3 删除清理用例；#4→Task 2 lazy 用例；#5→Task 4 permission 用例 ✓
