# v1.7 Task 12 + Task 13 合并实施报告

**BASE**: `41e368a`（T11 已合）
**执行顺序**: T13（调用站点迁移）→ T12（删废弃 IPC），避免中间态破坏

---

## T13 实施摘要 — 调用站点迁移

### 修改文件

#### 1. `renderer/src/components/agent/CapabilityTabs.tsx`（line 26, 52-64, 171-189）

- **import 类型**（line 26）：`RegisteredMcp, InstalledSkill` → `ResourceItem`
- **state 类型**（line 53-54）：`RegisteredMcp[]` / `InstalledSkill[]` → `ResourceItem[]`
- **useEffect 拉取**（line 57-64）：
  - `void ipc.mcp.listRegistered().then(setMcps)` → `void ipc.resource.list({ type: 'mcp' }).then(items => setMcps(items.filter(i => i.installed)))`
  - `void ipc.skill.listInstalled().then(setSkills)` → `void ipc.resource.list({ type: 'skill' }).then(items => setSkills(items.filter(i => i.installed)))`
- **MCP Tab 字段访问**（line 171-189）：
  - `value.mcps.includes(m.name)` → `value.mcps.includes(m.slug)`
  - `key={m.name}` → `key={m.slug}`
  - `aria-label={m.name}` → `aria-label={m.slug}`
  - `toggleItem('mcps', m.name, ...)` → `toggleItem('mcps', m.slug, ...)`
  - 显示文本 `{m.name}` 保留（ResourceItem.name 是展示名，与 Skill Tab `{s.name}` 一致）
- **Skill Tab**：字段访问（`s.slug` / `s.name` / `s.source`）保持不变（ResourceItem 与 InstalledSkill 字段名一致）

#### 2. `renderer/src/components/agent/CapabilityTabs.test.tsx`（mock 重构 + 测试数据形态）

- mock 工厂：`mockListRegistered` + `mockListInstalled` → 单一 `mockResourceList`（按 `filter.type` 分流）
- vi.mock：`{ mcp: { listRegistered }, skill: { listInstalled } }` → `{ resource: { list: mockResourceList } }`
- 测试 #279 / #361 描述更新：`'ipc.mcp.listRegistered 返回的 MCP ...'` → `'ipc.resource.list type=mcp 返回的 MCP ...'`（skill 同理）
- mock 数据形态：`RegisteredMcp` 形态（id/name/command/args/source/installedAt）→ `ResourceItem` 形态（id/type/source/slug/name/description/installed/installable/removable）
- 新增回归测试 #317：`未安装的 MCP 不展示（filter i.installed）` — 验证 `i.installed === false` 被过滤掉

#### 3. AddToWorkspaceDialog / AssignmentCapabilitiesDialog

经 grep 确认：这两个组件本身**不直接调用** `ipc.mcp.listRegistered` / `ipc.skill.listInstalled`，仅通过 `<CapabilityTabs />` 间接拉取。T13 无需改源码文件，但其测试文件需同步更新 mock（见下）。

### T13 测试文件同步更新

- `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx`（line 25-36, 96-108）
- `renderer/src/components/agent/AssignmentCapabilitiesDialog.test.tsx`（line 19-37, 48-62）
- `renderer/src/components/agent/DefinitionEditor.test.tsx`（line 18-39）

三处均把 mockApi 中的 `mcp: { listRegistered }, skill: { listInstalled }` 改为 `resource: { list: resourceList }`，`beforeEach` 中两个 mockReset/mockResolvedValue 合并为单一 `resourceList`。

---

## T12 实施摘要 — 删除废弃 IPC

### 删除的 IPC handler

| 文件 | 删除的通道 | 保留的通道 |
|---|---|---|
| `electron/src/main/mcp/ipc.handlers.ts` | `mcp:listRegistered`、`mcp:deleteRegistered` | `mcp:register`、`mcp:start`、`mcp:listTools`、`mcp:callTool`、`mcp:stop` |
| `electron/src/main/skill/ipc.handlers.ts` | `skill:listInstalled`、`skill:deleteCustom` | `skill:uploadZip` |
| `electron/src/main/marketplace/ipc.handlers.ts` | 整个文件删除（5 个 handler：`getCatalog`/`search`/`install`/`listInstalled`/`uninstall`） | — |
| `electron/src/main/ipc/index.ts` | 移除 `registerMarketplaceHandlers` import + 调用 | 其余 17 个 register 调用不变 |

### 删除的 preload 暴露

`electron/src/preload/index.ts`：
- `api.mcp.listRegistered`、`api.mcp.deleteRegistered`
- `api.skill.listInstalled`、`api.skill.deleteCustom`
- 整个 `api.marketplace` 命名空间（5 个方法）
- 未用到的类型 import：`InstalledSkill`

### 删除的 renderer 类型

`renderer/src/ipc/types.d.ts`：
- `RegisteredMcp` interface（已被 ResourceItem 取代）
- `InstalledSkill` interface（已被 ResourceItem 取代）
- `ApiSurface.mcp.listRegistered` / `deleteRegistered` 字段
- `ApiSurface.skill.listInstalled` / `deleteCustom` 字段
- 整个 `ApiSurface.marketplace` 命名空间（5 个方法）

**保留**（电子端 marketplace 层仍使用 + renderer 端作结构对照文档）：
- `MarketplaceItem` / `MarketplaceCatalog` / `InstalledPackage` 三个独立 type 定义
- `UploadedSkill`（skill:uploadZip 返回类型）
- `McpServerConfig`（mcp:register 入参）

### 保留的底层函数（resource/ 内部复用）

经 grep 验证 7 个底层函数全部保留，resource/library.ts + resource/custom.ts + resource/ipc.handlers.ts 正常引用：

| 函数 | 位置 | 仍被使用 |
|---|---|---|
| `listRegistered` | `mcp/host-manager.ts:197` | resource/custom.ts |
| `deleteRegistered` | `mcp/host-manager.ts:230` | resource/ipc.handlers.ts |
| `listInstalled` (skill) | `skill/zip-uploader.ts:259` | resource/custom.ts |
| `deleteCustomSkill` | `skill/zip-uploader.ts:355` | resource/ipc.handlers.ts |
| `installPackage` | `marketplace/installer.ts:43` (async) | resource/ipc.handlers.ts |
| `uninstallPackage` | `marketplace/installer.ts:263` | resource/ipc.handlers.ts |
| `fetchCatalog` | `marketplace/client.ts:25` (async) | resource/library.ts + resource/ipc.handlers.ts |

---

## 验证输出

### Typecheck（双 workspace 严格模式）

```
> pnpm -r typecheck
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
```

**结果**: 双 clean ✓

### Electron 全套测试

```
Test Files  86 passed (86)
     Tests  580 passed (580)
  Duration  37.02s
```

**结果**: 580/580 通过 ✓（含 mcp/marketplace/skill 底层函数测试 + resource/* 测试）

### Renderer 全套测试

```
Test Files  39 passed (39)
     Tests  363 passed (363)
  Duration  8.44s
```

**结果**: 363/363 通过 ✓（含 CapabilityTabs 25 用例 + AddToWorkspaceDialog 7 + AssignmentCapabilitiesDialog 11 + DefinitionEditor 10）

### Grep 验证（0 匹配）

```bash
$ grep -rn "ipc\.mcp\.listRegistered\|ipc\.mcp\.deleteRegistered\|ipc\.skill\.listInstalled\|ipc\.skill\.deleteCustom\|ipc\.marketplace" renderer/src/ electron/src/preload/
0 matches

$ grep -rn "'mcp:listRegistered'\|'mcp:deleteRegistered'\|'skill:listInstalled'\|'skill:deleteCustom'\|'marketplace:" renderer/src/ electron/src/
# 仅一处 ResourceDetail.test.tsx 的测试描述字符串含 "marketplace:"（非 IPC channel），无实际通道残留
```

---

## Self-Review

| 检查项 | 结果 | 备注 |
|---|---|---|
| CapabilityTabs 调用站点迁移正确（type + filter） | ✓ | `ipc.resource.list({ type })` + `filter(i => i.installed)`；新增 installed=false 不展示的回归测试 |
| 所有废弃 IPC 已删（grep 验证 0 匹配） | ✓ | renderer/preload 0 匹配；channel 字符串仅余一处测试描述（非通道） |
| 底层函数保留（resource/ 仍能用） | ✓ | 7 个函数全部 export 未动，resource/* 测试 580 通过 |
| preload + types.d.ts 同步清理 | ✓ | preload 删 6 个绑定 + marketplace 命名空间；types.d.ts 删 RegisteredMcp/InstalledSkill + 6 个 ApiSurface 字段 + marketplace namespace |
| AddToWorkspaceDialog / AssignmentCapabilitiesDialog 同步 | ✓ | 源码无直接调用（仅 CapabilityTabs 内部拉取），测试 mock 已同步更新 |
| 中文注释 + TS strict | ✓ | 模块头部注释中文；typecheck 双 clean，无 any/@ts-ignore |

---

## Commit

单 commit 合并 T12 + T13（避免中间态破坏）：

```
refactor(ipc): CapabilityTabs 改用 ipc.resource.list + 删除废弃 IPC（T12+T13）

T13: CapabilityTabs 调用站点从 ipc.mcp.listRegistered / ipc.skill.listInstalled
迁移到 ipc.resource.list({ type }) + filter installed；同步更新 4 个相关测试 mock。

T12: 删除 mcp:listRegistered / mcp:deleteRegistered / skill:listInstalled /
skill:deleteCustom / 整个 marketplace:* 命名空间（5 个 handler）的 IPC handler +
preload 暴露 + ApiSurface 类型字段 + RegisteredMcp/InstalledSkill renderer 类型。
底层函数全部保留（resource/ 内部复用）。
```
