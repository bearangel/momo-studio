# 资源库 UI 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把资源库单页双行 tab 重构为「二级侧边菜单（Agent/MCP/Skill）+ 每类独立页 + 类型原生添加流程（表单/导入/网络获取）+ 紧凑行列表 + 三段式详情」。

**Architecture:** renderer 侧新增 TypeSidebar / TypePageShell / ResourceRow / AddMenu / RegistryBrowse 及三个新弹窗与 Agent 分步向导；数据层新增 RegistryProvider（v1 = 本地 marketplace catalog）。electron 侧仅新增 1 个 IPC（`resource:createSkill`）；Agent YAML 导入复用现有 `agent.createFromYaml`，向导能力绑定复用 `agent.createCustom` 现成的 `defaultMcps`/`defaultSkills`。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM/Vite）+ zustand + Tailwind 语义 token + lucide-react + vitest/jsdom。

**设计依据:** `docs/specs/2026-09-22-resource-library-ui-redesign-design.md`（实现前通读）。

## Global Constraints

- Node 20 LTS：每个终端会话先 `nvm use 20`（Node 26 会毁 better-sqlite3 native binding）
- 包管理器一律 `npx pnpm@9.0.0`；单测跑单文件：`cd renderer && npx pnpm@9.0.0 vitest run <path>`（electron 同理）
- TypeScript strict：禁止 `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error`）
- renderer UI 只用语义 token（`bg-surface-*` / `text-secondary` / `border-subtle`…），禁标准 Tailwind 色阶与 inline 颜色（裸色阶类在编译层不生成 CSS）
- 图标只用 lucide-react，默认 `size={16} strokeWidth={1.75} aria-hidden`；纯图标按钮必须 `aria-label`
- 状态色一律 `Badge tone` / `taskStatusStyle`，组件内禁止重造色映射
- 原子组件优先：`components/ui/`（Button/Input/Dialog/Badge/Segmented/EmptyState/Checkbox…）
- 所有代码注释、文案中文；commit 走 Conventional Commits（`feat:` / `test:` / `refactor:` / `chore:`）
- 单测位置：renderer 贴源 colocated（`Foo.test.tsx` 与组件同目录）；electron 集中 `electron/tests/`（镜像 src 结构）——vitest include 机械强制，放别处不执行
- 涉及双端类型（Task 11）必须跑根目录 `npx pnpm@9.0.0 typecheck`（双 workspace）
- mock IPC 用 `vi.mock('<相对路径>/ipc/client', ...)` 返回带真实通道名的对象（momo-test-rules：断言通道入参形状，不简化 ID/绑定语义）

---

### Task 1: resource.store 演进（activeType + mode）

**Files:**
- Modify: `renderer/src/stores/resource.store.ts`
- Test: `renderer/src/stores/resource.store.test.ts`（已有文件，追加用例）

**Interfaces:**
- Consumes: 现有 `ResourceFilter` / `ResourceItem`（`renderer/src/ipc/types.d.ts`）
- Produces: store 新增 `activeType: ResourceType`（无 `'all'`）、`mode: 'installed' | 'registry'`、`setActiveType(t: ResourceType): void`（内部驱动 typeFilter + load + localStorage 持久化）、`setMode(m): void`。Task 7/8 依赖。

- [ ] **Step 1: 写失败测试**

在 `resource.store.test.ts` 追加（沿用文件内既有 mock ipc 结构；若形状不同，以「能断言 `ipc.resource.list` 收到 `{type:'mcp'}`」为准对齐）：

```ts
import { useResourceStore } from './resource.store';

const listMock = vi.fn(async () => []);
vi.mock('../ipc/client', () => ({
  ipc: { resource: { list: (...a: unknown[]) => listMock(...a), install: vi.fn(), delete: vi.fn() } },
}));

describe('resource.store 资源库重设计（activeType + mode）', () => {
  beforeEach(() => {
    listMock.mockClear();
    localStorage.clear();
    useResourceStore.setState({ activeType: 'agent', mode: 'installed', typeFilter: 'all', sourceFilter: 'all' });
  });

  it('setActiveType 驱动 typeFilter 并按 type 过滤拉取', async () => {
    await useResourceStore.getState().setActiveType('mcp');
    expect(useResourceStore.getState().typeFilter).toBe('mcp');
    expect(useResourceStore.getState().mode).toBe('installed');
    expect(listMock).toHaveBeenLastCalledWith({ type: 'mcp' });
  });

  it('setActiveType 持久化到 localStorage', () => {
    useResourceStore.getState().setActiveType('skill');
    expect(localStorage.getItem('momo.resourceLibrary.activeType')).toBe('skill');
  });

  it('setMode 切换 registry 模式且不动列表数据', () => {
    useResourceStore.setState({ items: [{ id: 'x' } as never] });
    useResourceStore.getState().setMode('registry');
    expect(useResourceStore.getState().mode).toBe('registry');
    expect(useResourceStore.getState().items.length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts
```
预期：新用例 FAIL（`setActiveType is not a function`）。

- [ ] **Step 3: 实现**

`resource.store.ts` 头部 import 补 `ResourceType`：

```ts
import type { ResourceItem, ResourceFilter, ResourceType } from '../ipc/types';
```

接口追加（`setQuery` 声明之后）：

```ts
/** 资源库重设计：当前激活的资源页类型（无 'all'——三页结构） */
activeType: ResourceType;
/** 页面模式：installed=已安装列表 / registry=网络获取（注册表浏览） */
mode: 'installed' | 'registry';
/** 切换资源页：驱动 typeFilter、持久化、立即刷新；并复位到已安装模式 */
setActiveType: (t: ResourceType) => void;
/** 切换页面模式（registry 数据由 RegistryBrowse 自行经 Provider 拉取，不动 items） */
setMode: (m: 'installed' | 'registry') => void;
```

实现体：初始值区（`query: ''` 之后）加 `activeType: 'agent', mode: 'installed',`；方法（`setQuery` 实现之后）：

```ts
setActiveType: (t) => {
  // 持久化上次选择（写入失败静默——隐私模式等场景不影响内存状态）
  try {
    localStorage.setItem('momo.resourceLibrary.activeType', t);
  } catch {
    // 忽略
  }
  set({ activeType: t, typeFilter: t, mode: 'installed', installNotice: null });
  void get().load();
},

setMode: (m) => set({ mode: m, installNotice: null }),
```

文件末尾（`create(...)` 之后）补启动恢复：

```ts
// 启动恢复上次激活的资源页类型（失效值回退 'agent'；typeFilter 同步对齐）
{
  const persisted = (() => {
    try {
      return localStorage.getItem('momo.resourceLibrary.activeType');
    } catch {
      return null;
    }
  })();
  const valid: ResourceType =
    persisted === 'agent' || persisted === 'mcp' || persisted === 'skill' ? persisted : 'agent';
  useResourceStore.setState({ activeType: valid, typeFilter: valid });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts
```
预期：全部 PASS（`setTypeFilter` 语义未变，既有用例不受影响）。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/stores/resource.store.ts renderer/src/stores/resource.store.test.ts
git commit -m "feat: resource.store 增加 activeType/mode（资源库三页结构与网络获取模式）"
```

---

### Task 2: MCP JSON 纯函数解析器

**Files:**
- Create: `renderer/src/lib/mcp-json.ts`
- Test: `renderer/src/lib/mcp-json.test.ts`

**Interfaces:**
- Produces: `interface ParsedMcpEntry { name: string; command: string; args?: string[]; env?: Record<string, string>; }`、`function parseMcpServersJson(text: string): ParsedMcpEntry[]`（抛中文 Error）。Task 10 消费。

- [ ] **Step 1: 写失败测试**

```ts
// renderer/src/lib/mcp-json.test.ts
import { parseMcpServersJson } from './mcp-json';

describe('parseMcpServersJson', () => {
  it('解析标准 mcpServers 包裹结构', () => {
    const out = parseMcpServersJson(
      JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['-y', 'server.js'], env: { TOKEN: 'x' } } },
      }),
    );
    expect(out).toEqual([
      { name: 'github', command: 'npx', args: ['-y', 'server.js'], env: { TOKEN: 'x' } },
    ]);
  });

  it('解析裸对象结构（无 mcpServers 包裹）', () => {
    expect(parseMcpServersJson(JSON.stringify({ search: { command: 'uvx' } }))).toEqual([
      { name: 'search', command: 'uvx' },
    ]);
  });

  it('多服务器一次解析多条', () => {
    const out = parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    expect(out.length).toBe(2);
  });

  it('非 JSON 抛中文错误', () => {
    expect(() => parseMcpServersJson('not json')).toThrow('内容不是合法 JSON');
  });

  it('根不是对象 / 空对象抛中文错误', () => {
    expect(() => parseMcpServersJson('[1]')).toThrow('根必须是 JSON 对象');
    expect(() => parseMcpServersJson('{}')).toThrow('未找到服务器定义');
  });

  it('条目缺 command 抛含名称的错误', () => {
    expect(() => parseMcpServersJson(JSON.stringify({ mcpServers: { bad: {} } }))).toThrow(
      '服务器 "bad" 缺少 command 字段',
    );
  });

  it('args 非数组 / env 值非字符串 / url 型远程条目 抛错误', () => {
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', args: 'y' } } })),
    ).toThrow('args 必须是字符串数组');
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', env: { K: 1 } } } })),
    ).toThrow('env 的值必须是字符串');
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { r: { url: 'https://x' } } })),
    ).toThrow('仅支持 stdio');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/mcp-json.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// renderer/src/lib/mcp-json.ts
// MCP 服务器 JSON 批量导入解析器（纯函数，McpJsonPasteDialog 消费）。
// 接受两种输入：
//   1. 标准 { "mcpServers": { <name>: { command, args?, env? } } } 包裹结构
//   2. 裸 { <name>: { command, ... } } 对象
// 当前后端仅支持 stdio 传输（registerMcpDefinition 硬编码），
// url 型（远程 MCP）条目显式报「暂不支持」而不是静默丢弃。

/** 解析后的单条服务器定义（与 RegisterMcpInput 对齐的子集） */
export interface ParsedMcpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 解析文本为服务器列表。任何格式错误抛中文 Error（含条目名/字段名）。 */
export function parseMcpServersJson(text: string): ParsedMcpEntry[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('内容不是合法 JSON');
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('根必须是 JSON 对象');
  }
  // mcpServers 包裹优先；无包裹键则把整个对象当服务器表
  const raw = root as Record<string, unknown>;
  const servers = (raw.mcpServers !== undefined ? raw.mcpServers : root) as Record<string, unknown>;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('未找到服务器定义（期望 { "mcpServers": { ... } } 或裸 { "名称": {...} }）');
  }
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    throw new Error('未找到服务器定义（对象为空）');
  }
  return entries.map(([name, value]) => parseEntry(name, value));
}

/** 解析并校验单条服务器定义 */
function parseEntry(name: string, value: unknown): ParsedMcpEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`服务器 "${name}" 的定义必须是对象`);
  }
  const v = value as Record<string, unknown>;
  // url 型远程 server：后端 stdio-only，显式报错而不是静默丢弃
  if (typeof v.url === 'string' && v.url !== '') {
    throw new Error(`服务器 "${name}" 是远程（url）类型，当前版本仅支持 stdio（command）方式`);
  }
  if (typeof v.command !== 'string' || v.command.trim() === '') {
    throw new Error(`服务器 "${name}" 缺少 command 字段`);
  }
  const entry: ParsedMcpEntry = { name, command: v.command };
  if (v.args !== undefined) {
    if (!Array.isArray(v.args) || v.args.some((a) => typeof a !== 'string')) {
      throw new Error(`服务器 "${name}" 的 args 必须是字符串数组`);
    }
    entry.args = v.args as string[];
  }
  if (v.env !== undefined) {
    if (typeof v.env !== 'object' || v.env === null || Array.isArray(v.env)) {
      throw new Error(`服务器 "${name}" 的 env 必须是对象`);
    }
    for (const [k, val] of Object.entries(v.env as Record<string, unknown>)) {
      if (typeof val !== 'string') throw new Error(`服务器 "${name}" 的 env.${k} 值必须是字符串`);
    }
    entry.env = v.env as Record<string, string>;
  }
  return entry;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/mcp-json.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/mcp-json.ts renderer/src/lib/mcp-json.test.ts
git commit -m "feat: mcpServers JSON 批量导入解析器（纯函数）"
```

---

### Task 3: RegistryProvider 服务层

**Files:**
- Create: `renderer/src/services/registry/types.ts`
- Create: `renderer/src/services/registry/marketplace-catalog-provider.ts`
- Test: `renderer/src/services/registry/marketplace-catalog-provider.test.ts`

**Interfaces:**
- Consumes: `ipc.resource.list({ type, source: 'marketplace' })`
- Produces: `RegistryEntry` / `RegistryProvider`（Step 3 全文）+ `marketplaceCatalogProvider`。Task 7 的 RegistryBrowse 消费 `list(type, query?)`。

- [ ] **Step 1: 写失败测试**

```ts
// renderer/src/services/registry/marketplace-catalog-provider.test.ts
import { marketplaceCatalogProvider } from './marketplace-catalog-provider';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn(async () => []);
vi.mock('../../ipc/client', () => ({
  ipc: { resource: { list: (...a: unknown[]) => listMock(...a) } },
}));

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'marketplace-agent-x', type: 'agent', source: 'marketplace', slug: 'x',
    name: 'X', description: 'desc', installed: false, installable: true, removable: false,
    marketplace: {
      author: 'a', readme: '', downloadUrl: '', checksum: '',
      verificationStatus: 'community', tags: ['t1'], category: 'c',
    },
    ...over,
  } as ResourceItem;
}

describe('marketplaceCatalogProvider', () => {
  beforeEach(() => listMock.mockClear());

  it('按 type + source=marketplace 拉取并映射 RegistryEntry', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    const out = await marketplaceCatalogProvider.list('agent');
    expect(listMock).toHaveBeenCalledWith({ type: 'agent', source: 'marketplace' });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: 'marketplace-agent-x', name: 'X', tags: ['t1'] });
  });

  it('query 前端模糊过滤（name/description/slug）', async () => {
    listMock.mockResolvedValue([
      mkItem({ name: 'coder', slug: 'coder' }),
      mkItem({ name: 'writer', description: '写作' }),
    ]);
    const out = await marketplaceCatalogProvider.list('agent', 'cod');
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe('coder');
  });

  it('未安装项排在已安装项之前', async () => {
    listMock.mockResolvedValue([
      mkItem({ id: 'a1', slug: 'installed-one', installed: true }),
      mkItem({ id: 'a2', slug: 'fresh', installed: false }),
    ]);
    const out = await marketplaceCatalogProvider.list('agent');
    expect(out[0]!.id).toBe('a2');
  });

  it('Provider 抛错原样透传（错误态由 RegistryBrowse 渲染）', async () => {
    listMock.mockRejectedValue(new Error('catalog 加载失败'));
    await expect(marketplaceCatalogProvider.list('agent')).rejects.toThrow('catalog 加载失败');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/services/registry/marketplace-catalog-provider.test.ts
```

- [ ] **Step 3: 实现**

```ts
// renderer/src/services/registry/types.ts
// 网络获取（注册表浏览）数据层契约。v1 仅内置 marketplace catalog Provider；
// 未来接 mcphub / skillhub = 新增实现，页面组件零改动（spec §3）。
import type { ResourceItem, ResourceType } from '../../ipc/types';

/** 注册表条目——网络获取模式的统一形状 */
export interface RegistryEntry {
  /** 对应 marketplace item 的 resource id（安装时透传给 installResource，禁止重新生成） */
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  /** 完整资源项（安装链路与详情面板消费） */
  item: ResourceItem;
}

export interface RegistryProvider {
  /** 稳定标识（未来多源选择器的 key） */
  readonly key: string;
  /** 展示名（如「内置市场」） */
  readonly label: string;
  /** 拉取某类型的注册表条目；query 为可选前端模糊过滤。失败抛 Error。 */
  list(type: ResourceType, query?: string): Promise<RegistryEntry[]>;
}
```

```ts
// renderer/src/services/registry/marketplace-catalog-provider.ts
// v1 唯一 Provider：本地打包的 marketplace catalog（经现有 resource:list 通道）。
// 排序：未安装在前（浏览目标优先），已安装垫底（供确认「已装过」）。
import { ipc } from '../../ipc/client';
import type { ResourceItem, ResourceType } from '../../ipc/types';
import type { RegistryEntry, RegistryProvider } from './types';

function toEntry(item: ResourceItem): RegistryEntry {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    description: item.description,
    version: item.version,
    tags: item.marketplace?.tags ?? [],
    category: item.marketplace?.category,
    item,
  };
}

/** 前端模糊匹配（name/description/slug，case-insensitive——与已安装列表搜索同语义） */
function matches(entry: RegistryEntry, q: string): boolean {
  const lower = q.toLowerCase();
  return (
    entry.name.toLowerCase().includes(lower) ||
    entry.description.toLowerCase().includes(lower) ||
    entry.item.slug.toLowerCase().includes(lower)
  );
}

export const marketplaceCatalogProvider: RegistryProvider = {
  key: 'marketplace',
  label: '内置市场',
  async list(type: ResourceType, query?: string): Promise<RegistryEntry[]> {
    const items = await ipc.resource.list({ type, source: 'marketplace' });
    const entries = items.map(toEntry);
    const filtered = query?.trim() ? entries.filter((e) => matches(e, query.trim())) : entries;
    return filtered.sort((a, b) => Number(a.item.installed) - Number(b.item.installed));
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/services/registry/marketplace-catalog-provider.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/services/registry/
git commit -m "feat: RegistryProvider 数据层——网络获取模式可插拔注册表（v1 内置市场）"
```

---

### Task 4: ResourceRow（紧凑行，取代 ResourceCard）

**Files:**
- Create: `renderer/src/components/resource-library/ResourceRow.tsx`
- Test: `renderer/src/components/resource-library/ResourceRow.test.tsx`

**Interfaces:**
- Consumes: `ResourceItem`、`SourceBadge`、lucide
- Produces: `ResourceRowProps`（Step 3 全文）+ `TYPE_ICON: Record<ResourceType, LucideIcon>`（导出，Task 5/7 复用）。尾部操作条件逻辑**逐条平移自 `ResourceCard.tsx`**（ResourceCard 本 task 不删，Task 16 删）。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/ResourceRow.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceRow } from './ResourceRow';
import type { ResourceItem } from '../../ipc/types';

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'custom-mcp-x', type: 'mcp', source: 'custom', slug: 'x', name: '服务器X',
    description: '一行描述', installed: true, installable: false, removable: true, ...over,
  } as ResourceItem;
}

const noop = (): void => undefined;

describe('ResourceRow', () => {
  it('渲染名称/描述，点行触发 onSelect', () => {
    const onSelect = vi.fn();
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('服务器X'));
    expect(onSelect).toHaveBeenCalledWith('custom-mcp-x');
  });

  it('选中态有 accent 边框类', () => {
    const { container } = render(<ResourceRow item={mkItem({})} selected={true} onSelect={noop} />);
    expect(container.firstChild).toHaveClass('border-accent-500');
  });

  it('可安装项显示安装按钮，点击不冒泡到行', () => {
    const onInstall = vi.fn();
    const onSelect = vi.fn();
    render(
      <ResourceRow
        item={mkItem({ installable: true, installed: false })}
        selected={false} onSelect={onSelect} onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('custom-mcp-x');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('builtin agent 未启用显示启用按钮；已启用显示已启用标记', () => {
    const { rerender } = render(
      <ResourceRow
        item={mkItem({ type: 'agent', source: 'builtin', installed: true, removable: false, builtin: { agentEnabled: false } })}
        selected={false} onSelect={noop} onEnable={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '启用' })).toBeTruthy();
    rerender(
      <ResourceRow
        item={mkItem({ type: 'agent', source: 'builtin', installed: true, removable: false, builtin: { agentEnabled: true } })}
        selected={false} onSelect={noop} onEnable={noop}
      />,
    );
    expect(screen.getByText('已启用')).toBeTruthy();
  });

  it('已安装且可删项显示删除按钮（aria-label 含名称）', () => {
    render(<ResourceRow item={mkItem({})} selected={false} onSelect={noop} onDelete={noop} />);
    expect(screen.getByRole('button', { name: '删除 服务器X' })).toBeTruthy();
  });

  it('custom agent 传入 onEdit/onConfigure 时显示编辑/配置按钮', () => {
    render(
      <ResourceRow
        item={mkItem({ type: 'agent', installed: true })}
        selected={false} onSelect={noop} onEdit={noop} onConfigure={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '配置' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceRow.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/ResourceRow.tsx
// 资源库紧凑行（spec §6.1）——取代卡片网格。结构：
//   图标 + 名称 + 一行描述(截断) + 来源徽章 + 尾部操作槽（条件逻辑平移自 ResourceCard）
// 操作按钮点击 stopPropagation 防冒泡到行 onSelect（沿用卡片防线）。
import type { LucideIcon } from 'lucide-react';
import { Bot, Check, Package, Puzzle, Trash2 } from 'lucide-react';
import type { ResourceItem, ResourceType } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { SourceBadge } from './SourceBadge';

interface ResourceRowProps {
  item: ResourceItem;
  selected: boolean;
  onSelect: (id: string) => void;
  /** 可选安装回调；仅当 item.installable && !item.installed 时渲染按钮 */
  onInstall?: (id: string) => void;
  /** 可选删除回调；仅当 item.installed && item.removable 时渲染按钮 */
  onDelete?: (id: string) => void;
  /** builtin agent 未启用时的「启用」回调（弹 EnablePresetDialog） */
  onEnable?: (id: string) => void;
  /** custom agent 的编辑入口（仅 type=agent && source=custom && installed） */
  onEdit?: (id: string) => void;
  /** builtin 已启用 / marketplace 已装 agent 的配置入口 */
  onConfigure?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染）。TypeSidebar/TypePageShell 复用。 */
export const TYPE_ICON: Record<ResourceType, LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

export function ResourceRow({
  item, selected, onSelect, onInstall, onDelete, onEnable, onEdit, onConfigure,
}: ResourceRowProps) {
  const TypeIcon = TYPE_ICON[item.type];
  return (
    <div
      data-testid={`resource-row-${item.id}`}
      className={cn(
        'flex items-center gap-2 px-3 h-11 rounded-lg border bg-surface-2 cursor-pointer transition-colors',
        selected ? 'border-accent-500' : 'border-subtle hover:border-strong',
      )}
      onClick={() => onSelect(item.id)}
    >
      {item.iconEmoji ? (
        <span className="text-xl leading-none shrink-0">{item.iconEmoji}</span>
      ) : (
        <TypeIcon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />
      )}
      <span className="font-medium truncate text-primary text-[13px]">{item.name}</span>
      <span className="text-xs text-tertiary truncate flex-1 min-w-0">{item.description}</span>
      <SourceBadge source={item.source} />

      <span className="flex gap-1 items-center shrink-0">
        {/* 安装：仅 installable 且未安装（registry 浏览 / marketplace 项） */}
        {item.installable && !item.installed && onInstall && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
          >
            安装
          </button>
        )}
        {/* 编辑：custom agent 专属（定义编辑入口） */}
        {item.type === 'agent' && item.source === 'custom' && item.installed && onEdit && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onEdit(item.id); }}
          >
            编辑
          </button>
        )}
        {/* 配置：builtin 已启用 / marketplace 已装 agent（改模型等） */}
        {item.type === 'agent' && onConfigure &&
          ((item.source === 'builtin' && item.builtin?.agentEnabled) ||
            (item.source === 'marketplace' && item.installed)) && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onConfigure(item.id); }}
          >
            配置
          </button>
        )}
        {/* 启用：builtin agent 未启用（def 不在库，spec 2026-09-22） */}
        {item.type === 'agent' && item.source === 'builtin' && !item.builtin?.agentEnabled && onEnable && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onEnable(item.id); }}
          >
            启用
          </button>
        )}
        {/* 已启用标记：builtin agent def 已在库 */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已启用
          </span>
        )}
        {/* 已安装静态标记：installed 且不可删的 builtin 非 agent 项（随应用分发语义） */}
        {item.installed && !item.removable && !(item.type === 'agent' && item.source === 'builtin') && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已安装
          </span>
        )}
        {/* 删除：仅 installed 且 removable（custom 上传项） */}
        {item.installed && item.removable && onDelete && (
          <button
            type="button"
            aria-label={`删除 ${item.name}`}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-status-error-tint text-status-error hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          >
            <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            删除
          </button>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceRow.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/resource-library/ResourceRow.tsx renderer/src/components/resource-library/ResourceRow.test.tsx
git commit -m "feat: ResourceRow 紧凑行组件（条件逻辑自 ResourceCard 平移）"
```

---

### Task 5: TypeSidebar（二级侧边菜单）

**Files:**
- Create: `renderer/src/components/resource-library/TypeSidebar.tsx`
- Test: `renderer/src/components/resource-library/TypeSidebar.test.tsx`

**Interfaces:**
- Consumes: `ResourceType`、`TYPE_ICON`（Task 4）
- Produces: `interface TypeSidebarProps { activeType: ResourceType; onSelect: (t: ResourceType) => void; }`

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/TypeSidebar.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { TypeSidebar } from './TypeSidebar';

describe('TypeSidebar', () => {
  it('渲染三个菜单项（Agent/MCP/Skill），无总览', () => {
    render(<TypeSidebar activeType="agent" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Agent/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /MCP/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Skill/ })).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('点击切换回调', () => {
    const onSelect = vi.fn();
    render(<TypeSidebar activeType="mcp" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Skill/ }));
    expect(onSelect).toHaveBeenCalledWith('skill');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/TypeSidebar.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/TypeSidebar.tsx
// 资源库二级侧边菜单（spec §2.1 决策①）：Agent / MCP / Skill 三项，无总览。
// 选中态 = bg-surface-active + accent 文字（设计系统导航选中态规范）。
import type { ResourceType } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { TYPE_ICON } from './ResourceRow';

/** 三页菜单配置（与 store.activeType 的 ResourceType 对齐，无 'all'） */
const TYPES: Array<{ key: ResourceType; label: string }> = [
  { key: 'agent', label: 'Agent' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skill', label: 'Skill' },
];

interface TypeSidebarProps {
  activeType: ResourceType;
  onSelect: (t: ResourceType) => void;
}

export function TypeSidebar({ activeType, onSelect }: TypeSidebarProps) {
  return (
    <nav aria-label="资源类型" className="w-28 shrink-0 border-r border-subtle bg-surface-1 py-2 flex flex-col gap-0.5">
      {TYPES.map(({ key, label }) => {
        const Icon = TYPE_ICON[key];
        const active = activeType === key;
        return (
          <button
            key={key}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 mx-1.5 px-2.5 h-8 rounded-md text-[13px] transition-colors',
              active
                ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                : 'text-secondary hover:bg-surface-3',
            )}
            onClick={() => onSelect(key)}
          >
            <Icon size={16} strokeWidth={1.75} aria-hidden />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/TypeSidebar.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/resource-library/TypeSidebar.tsx renderer/src/components/resource-library/TypeSidebar.test.tsx
git commit -m "feat: TypeSidebar 资源库二级侧边菜单（Agent/MCP/Skill，无总览）"
```

---

### Task 6: AddMenu（类型专属「＋」下拉）

**Files:**
- Create: `renderer/src/components/resource-library/AddMenu.tsx`
- Test: `renderer/src/components/resource-library/AddMenu.test.tsx`

**Interfaces:**
- Produces: `export interface AddMenuItem { key: string; title: string; hint?: string; onSelect: () => void; }`、`interface AddMenuProps { label: string; items: AddMenuItem[]; }`。Task 7/8 消费。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/AddMenu.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { AddMenu } from './AddMenu';

const items = [
  { key: 'form', title: '手动配置…', hint: '名称 / 命令 / 参数', onSelect: vi.fn() },
  { key: 'json', title: '粘贴 JSON…', onSelect: vi.fn() },
];

describe('AddMenu', () => {
  it('初始不显示菜单，点按钮展开并渲染标题+副文案', () => {
    render(<AddMenu label="＋ 添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    expect(screen.getByText('手动配置…')).toBeTruthy();
    expect(screen.getByText('名称 / 命令 / 参数')).toBeTruthy();
  });

  it('点菜单项触发 onSelect 并收起菜单', () => {
    render(<AddMenu label="＋ 添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    fireEvent.click(screen.getByText('粘贴 JSON…'));
    expect(items[1]!.onSelect).toHaveBeenCalled();
    expect(screen.queryByText('粘贴 JSON…')).toBeNull();
  });

  it('点击菜单外部收起（document mousedown）', () => {
    render(<AddMenu label="＋ 添加服务器" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('手动配置…')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/AddMenu.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/AddMenu.tsx
// 类型专属「＋」下拉（spec §4，Cherry Studio MCP 模式）：命名路径 + 一句副文案。
// 点击外部收起；菜单项点击后必收起。图标 lucide Plus（禁 emoji）。
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '../../lib/cn';

/** 单条添加路径 */
export interface AddMenuItem {
  key: string;
  /** 菜单项标题（如「手动配置…」） */
  title: string;
  /** 一句副文案（如「名称 / 命令 / 参数」） */
  hint?: string;
  onSelect: () => void;
}

interface AddMenuProps {
  /** 按钮文案（按类型命名，如「＋ 添加服务器」） */
  label: string;
  items: AddMenuItem[];
}

export function AddMenu({ label, items }: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部收起（挂卸成对）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-accent-500 text-inverse text-[13px] font-medium hover:opacity-90"
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden />
        {label}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-10 w-64 rounded-lg border border-subtle bg-surface-3 shadow-lg py-1">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="w-full text-left px-3 py-1.5 hover:bg-surface-active transition-colors"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="block text-[13px] text-primary">{item.title}</span>
              {item.hint && <span className="block text-xs text-tertiary">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

（`cn` import 若未用到则删除。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/AddMenu.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/resource-library/AddMenu.tsx renderer/src/components/resource-library/AddMenu.test.tsx
git commit -m "feat: AddMenu 类型专属添加下拉（命名路径+副文案）"
```

---

### Task 7: TypePageShell + RegistryBrowse（页面骨架与网络获取模式）

**Files:**
- Create: `renderer/src/components/resource-library/TypePageShell.tsx`
- Create: `renderer/src/components/resource-library/RegistryBrowse.tsx`
- Test: `renderer/src/components/resource-library/TypePageShell.test.tsx`
- Test: `renderer/src/components/resource-library/RegistryBrowse.test.tsx`

**Interfaces:**
- Consumes: `useResourceStore`（Task 1）、`ResourceRow`/`TYPE_ICON`（Task 4）、`AddMenu`/`AddMenuItem`（Task 6）、`Segmented`、`EmptyState`、`Input`、`marketplaceCatalogProvider`（Task 3）、`ResourceDetail`（现有组件直接挂载——Task 15 才升级三段式，对外 props 不变）
- Produces:
  - `interface TypePageShellProps { type: ResourceType; addItems: AddMenuItem[]; onInstall: (id: string) => void; onEditAgent: (id: string) => void; onOpenPreset: (id: string) => void; }`
  - `interface RegistryBrowseProps { type: ResourceType; onInstall: (id: string) => void; }`

- [ ] **Step 1: 写失败测试（RegistryBrowse）**

```tsx
// renderer/src/components/resource-library/RegistryBrowse.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegistryBrowse } from './RegistryBrowse';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn();
vi.mock('../../ipc/client', () => ({
  ipc: { resource: { list: (...a: unknown[]) => listMock(...a) } },
}));

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'marketplace-mcp-x', type: 'mcp', source: 'marketplace', slug: 'x', name: 'X服务',
    description: 'd', installed: false, installable: true, removable: false,
    marketplace: { author: 'a', readme: '', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: ['t'], category: 'c' },
    ...over,
  } as ResourceItem;
}

describe('RegistryBrowse', () => {
  beforeEach(() => listMock.mockReset());

  it('挂载即拉取该类型 marketplace 条目并渲染行与来源标注', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('X服务')).toBeTruthy());
    expect(listMock).toHaveBeenCalledWith({ type: 'mcp', source: 'marketplace' });
    expect(screen.getByText('来源：内置市场')).toBeTruthy();
  });

  it('未安装行点安装触发 onInstall(id)', async () => {
    listMock.mockResolvedValue([mkItem({})]);
    const onInstall = vi.fn();
    render(<RegistryBrowse type="mcp" onInstall={onInstall} />);
    await waitFor(() => screen.getByText('X服务'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onInstall).toHaveBeenCalledWith('marketplace-mcp-x');
  });

  it('Provider 抛错渲染错误态与重试按钮', async () => {
    listMock.mockRejectedValue(new Error('catalog 加载失败'));
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/加载失败：catalog 加载失败/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('空目录渲染空态', async () => {
    listMock.mockResolvedValue([]);
    render(<RegistryBrowse type="mcp" onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('目录中没有匹配项')).toBeTruthy());
  });
});
```

- [ ] **Step 2: 写失败测试（TypePageShell）**

```tsx
// renderer/src/components/resource-library/TypePageShell.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { TypePageShell } from './TypePageShell';
import { useResourceStore } from '../../stores/resource.store';

vi.mock('../../ipc/client', () => ({
  ipc: { resource: { list: vi.fn(async () => []) } },
}));

describe('TypePageShell', () => {
  beforeEach(() => {
    useResourceStore.setState({
      items: [], loading: false, error: null, installNotice: null,
      typeFilter: 'mcp', sourceFilter: 'all', query: '',
      activeType: 'mcp', mode: 'installed',
    });
  });

  it('工具栏含模式 Segmented（已安装|网络获取）、来源 chips、AddMenu', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByRole('radio', { name: '已安装' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '网络获取' })).toBeTruthy();
    expect(screen.getByText('预置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ 添加服务器' })).toBeTruthy();
  });

  it('已安装空列表渲染 EmptyState 文案', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('还没有 MCP 服务器')).toBeTruthy();
  });

  it('行点击选中后挂载详情面板', () => {
    useResourceStore.setState({
      items: [{
        id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
        description: '', installed: true, installable: false, removable: true,
      }],
    });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });

  it('mode=registry 时渲染 RegistryBrowse（来源标注出现）', () => {
    useResourceStore.setState({ mode: 'registry' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('来源：内置市场')).toBeTruthy();
  });
});
```

- [ ] **Step 3: 跑两个测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/RegistryBrowse.test.tsx src/components/resource-library/TypePageShell.test.tsx
```

- [ ] **Step 4: 实现 RegistryBrowse**

```tsx
// renderer/src/components/resource-library/RegistryBrowse.tsx
// 网络获取模式（spec §4.4）：RegistryProvider 拉取 + 前端搜索/分类 chips + 行列表。
// v1 Provider = 内置市场；未来多 Provider 时顶部说明位变选择器。
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { ResourceRow } from './ResourceRow';
import { marketplaceCatalogProvider } from '../../services/registry/marketplace-catalog-provider';
import type { RegistryEntry } from '../../services/registry/types';

interface RegistryBrowseProps {
  type: ResourceType;
  /** 安装回调（透传 resource.id——禁止重新生成，momo-boundary-rules） */
  onInstall: (id: string) => void;
}

/** 分类 chips：条目 tags 去重取 Top 8 */
function topTags(entries: RegistryEntry[]): string[] {
  const count = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
}

export function RegistryBrowse({ type, onInstall }: RegistryBrowseProps) {
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 递增触发重试（重试按钮 = attempt 变化重挂 effect）
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    marketplaceCatalogProvider
      .list(type)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, attempt]);

  const tags = useMemo(() => topTags(entries), [entries]);
  const q = query.trim().toLowerCase();
  const visible = entries.filter((e) => {
    if (tagFilter && !e.tags.includes(tagFilter)) return false;
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.item.slug.toLowerCase().includes(q)
    );
  });

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8">
        <p className="text-sm text-status-error">加载失败：{error}</p>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-surface-active text-accent-600 dark:text-accent-300"
          onClick={() => setAttempt((n) => n + 1)}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏：搜索 + 分类 chips + 来源标注 */}
      <div className="px-4 py-2.5 border-b border-subtle flex items-center gap-2 flex-wrap">
        <div className="w-56">
          <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            className={tagFilter === t
              ? 'text-xs px-2 py-0.5 rounded-full bg-surface-active text-accent-600 dark:text-accent-300'
              : 'text-xs px-2 py-0.5 rounded-full bg-surface-3 text-secondary hover:bg-surface-active'}
            onClick={() => setTagFilter(tagFilter === t ? null : t)}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto text-xs text-tertiary">来源：{marketplaceCatalogProvider.label}</span>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
        {loading ? (
          <div className="text-center text-tertiary text-sm py-8">加载中…</div>
        ) : visible.length === 0 ? (
          <EmptyState icon={RefreshCw} title="目录中没有匹配项" description="试试清除搜索或切换分类" />
        ) : (
          visible.map((e) => (
            <ResourceRow key={e.id} item={e.item} selected={false} onSelect={() => undefined} onInstall={onInstall} />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 实现 TypePageShell**

```tsx
// renderer/src/components/resource-library/TypePageShell.tsx
// 资源页公共骨架（spec §2.1）：工具栏（搜索 + 来源 chips + AddMenu + 模式 Segmented）
// + 已安装行列表 / RegistryBrowse + 右侧详情面板。三页同构，type 参数驱动。
import { useState } from 'react';
import type { ResourceFilter, ResourceSource, ResourceType } from '../../ipc/types';
import { useResourceStore } from '../../stores/resource.store';
import { EmptyState } from '../ui/EmptyState';
import { Input } from '../ui/Input';
import { Segmented } from '../ui/Segmented';
import { cn } from '../../lib/cn';
import { AddMenu } from './AddMenu';
import type { AddMenuItem } from './AddMenu';
import { RegistryBrowse } from './RegistryBrowse';
import { ResourceRow, TYPE_ICON } from './ResourceRow';
import { ResourceDetail } from './ResourceDetail';

/** 来源筛选 chips（'all' = 不限） */
const SOURCE_CHIPS: Array<{ key: ResourceFilter['source'] | 'all'; label: string }> = [
  { key: 'all', label: '全部来源' },
  { key: 'builtin', label: '预置' },
  { key: 'custom', label: '自定义' },
  { key: 'marketplace', label: '网络' },
  { key: 'p2p', label: 'P2P' },
];

/** 每类页的空态标题（spec §7） */
const EMPTY_COPY: Record<ResourceType, string> = {
  agent: '还没有智能体',
  mcp: '还没有 MCP 服务器',
  skill: '还没有技能',
};

const MODE_OPTIONS = [
  { value: 'installed', label: '已安装' },
  { value: 'registry', label: '网络获取' },
] as const;

/** 每类页的「＋」按钮文案 */
const ADD_LABEL: Record<ResourceType, string> = {
  agent: '＋ 新建 / 导入',
  mcp: '＋ 添加服务器',
  skill: '＋ 添加技能',
};

interface TypePageShellProps {
  type: ResourceType;
  /** 类型专属「＋」下拉项（由 ResourceLibraryView 组装——弹窗开关都在那边） */
  addItems: AddMenuItem[];
  /** 安装包装（marketplace agent 成功后弹配置引导——逻辑在 View 层） */
  onInstall: (id: string) => void;
  /** custom agent 编辑入口（DefinitionEditor 挂载在 View 层） */
  onEditAgent: (id: string) => void;
  /** builtin/marketplace agent 启用/配置入口（EnablePresetDialog 挂载在 View 层） */
  onOpenPreset: (id: string) => void;
}

export function TypePageShell({ type, addItems, onInstall, onEditAgent, onOpenPreset }: TypePageShellProps) {
  const {
    items, loading, error, installNotice, sourceFilter, query, mode,
    setSourceFilter, setQuery, setMode, deleteResource,
  } = useResourceStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const Icon = TYPE_ICON[type];

  // 详情数据：删除后 items 更新可能让 selected 失效 → 自动收起（沿用原 View 语义）
  const selected = selectedId ? items.find((i) => i.id === selectedId) : undefined;

  // 前端搜索过滤（与原 View 同语义：name/description/slug 模糊匹配）
  const q = query.trim().toLowerCase();
  const filteredItems = q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.slug.toLowerCase().includes(q),
      )
    : items;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="px-4 py-2.5 border-b border-subtle flex items-center gap-2 flex-wrap">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          {type === 'agent' ? '智能体' : type === 'mcp' ? 'MCP 服务器' : '技能'}
        </h2>
        <div className="w-56">
          <Input placeholder="搜索名称 / 描述 / slug…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {mode === 'installed' &&
          SOURCE_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={cn(
                'text-xs px-2 py-0.5 rounded-full transition-colors',
                sourceFilter === chip.key
                  ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                  : 'bg-surface-3 text-secondary hover:bg-surface-active',
              )}
              onClick={() => setSourceFilter(chip.key as ResourceSource | 'all')}
            >
              {chip.label}
            </button>
          ))}
        <div className="ml-auto flex items-center gap-2">
          <Segmented options={MODE_OPTIONS} value={mode} onChange={(v) => setMode(v)} aria-label="列表模式" />
          <AddMenu label={ADD_LABEL[type]} items={addItems} />
        </div>
      </div>

      {/* 一次性成功横幅（沿用原 View） */}
      {mode === 'installed' && installNotice && (
        <div data-testid="install-notice" className="mx-4 mt-3 px-3 py-2 rounded-md border border-subtle bg-status-success-tint text-status-success text-sm inline-flex items-center gap-1.5 self-start">
          {installNotice}
        </div>
      )}

      {/* 主区 */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {mode === 'registry' ? (
            <RegistryBrowse type={type} onInstall={onInstall} />
          ) : error ? (
            <div className="text-center text-status-error text-sm py-8">加载失败：{error}</div>
          ) : loading && items.length === 0 ? (
            <div className="text-center text-tertiary text-sm py-8">加载中…</div>
          ) : filteredItems.length === 0 ? (
            <EmptyState icon={Icon} title={EMPTY_COPY[type]} description="从右上角「＋」选择添加方式" />
          ) : (
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-1.5">
              {filteredItems.map((item) => (
                <ResourceRow
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onSelect={setSelectedId}
                  onInstall={onInstall}
                  onDelete={deleteResource}
                  onEnable={onOpenPreset}
                  onEdit={onEditAgent}
                  onConfigure={onOpenPreset}
                />
              ))}
            </div>
          )}
        </div>

        {/* 右侧详情面板（条件渲染；Task 15 升级三段式，props 不变） */}
        {mode === 'installed' && selected && (
          <ResourceDetail
            item={selected}
            onClose={() => setSelectedId(null)}
            onInstall={onInstall}
            onDelete={deleteResource}
            onEdit={onEditAgent}
            onEnable={onOpenPreset}
            onConfigure={onOpenPreset}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/RegistryBrowse.test.tsx src/components/resource-library/TypePageShell.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add renderer/src/components/resource-library/TypePageShell.tsx renderer/src/components/resource-library/RegistryBrowse.tsx renderer/src/components/resource-library/TypePageShell.test.tsx renderer/src/components/resource-library/RegistryBrowse.test.tsx
git commit -m "feat: TypePageShell 页面骨架 + RegistryBrowse 网络获取模式"
```

---

### Task 8: ResourceLibraryView 壳重写

**Files:**
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（整文件替换）
- Test: `renderer/src/components/resource-library/ResourceLibraryView.test.tsx`（整文件重写）

**Interfaces:**
- Consumes: Task 1/4/5/6/7 产出；现有 `RegisterMcpDialog` / `UploadSkillDialog` / `CreateAgentDialog`（**本 task 先挂 CreateAgentDialog 占位**，Task 14 换成 AgentCreateWizard）、`DefinitionEditor`、`EnablePresetDialog`
- Produces: View 对外签名不变（`export function ResourceLibraryView()`，MiddlePanel 零改动）

- [ ] **Step 1: 重写测试（先写，锁定新结构）**

```tsx
// renderer/src/components/resource-library/ResourceLibraryView.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceLibraryView } from './ResourceLibraryView';
import { useResourceStore } from '../../stores/resource.store';

vi.mock('../../ipc/client', () => ({
  ipc: {
    resource: { list: vi.fn(async () => []), install: vi.fn(), delete: vi.fn() },
    agent: { list: vi.fn(async () => []) },
  },
}));

describe('ResourceLibraryView（三页壳）', () => {
  beforeEach(() => {
    localStorage.clear();
    useResourceStore.setState({
      items: [], loading: false, error: null, installNotice: null,
      typeFilter: 'agent', sourceFilter: 'all', query: '',
      activeType: 'agent', mode: 'installed',
    });
  });

  it('渲染二级侧边菜单与默认 Agent 页', () => {
    render(<ResourceLibraryView />);
    expect(screen.getByRole('navigation', { name: '资源类型' })).toBeTruthy();
    expect(screen.getByText('智能体')).toBeTruthy();
  });

  it('切到 MCP 页标题与添加按钮文案切换', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    expect(screen.getByText('MCP 服务器')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ 添加服务器' })).toBeTruthy();
  });

  it('MCP 页下拉含三条路径（手动配置/粘贴 JSON/网络获取）', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    expect(screen.getByText('手动配置…')).toBeTruthy();
    expect(screen.getByText('粘贴 JSON…')).toBeTruthy();
    expect(screen.getByText('从网络获取…')).toBeTruthy();
  });

  it('持久化恢复上次激活页', () => {
    localStorage.setItem('momo.resourceLibrary.activeType', 'skill');
    useResourceStore.setState({ activeType: 'skill', typeFilter: 'skill' });
    render(<ResourceLibraryView />);
    expect(screen.getByText('技能')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 3: 实现（整文件替换 ResourceLibraryView.tsx）**

```tsx
// renderer/src/components/resource-library/ResourceLibraryView.tsx
// 资源库壳（spec §2.1 重设计）：TypeSidebar（Agent/MCP/Skill 二级菜单）+ TypePageShell。
// 弹窗开关全部集中在本层；agent 专属回调和 preset/edit 逻辑自旧单页 View 平移。
// Task 10/12/13 接线三个新弹窗；Task 14 起向导替换 CreateAgentDialog。
import { useState } from 'react';
import { useResourceStore } from '../../stores/resource.store';
import { ipc } from '../../ipc/client';
import { TypeSidebar } from './TypeSidebar';
import { TypePageShell } from './TypePageShell';
import type { AddMenuItem } from './AddMenu';
import { RegisterMcpDialog } from '../agent/RegisterMcpDialog';
import { UploadSkillDialog } from '../agent/UploadSkillDialog';
import { CreateAgentDialog } from '../agent/CreateAgentDialog';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import { EnablePresetDialog } from '../agent/EnablePresetDialog';
import type { AgentDefinition, ResourceType } from '../../ipc/types';

export function ResourceLibraryView() {
  const { activeType, setActiveType, setMode, items, installResource, load } = useResourceStore();
  // 弹窗开关（本层集中）
  const [registerMcpOpen, setRegisterMcpOpen] = useState(false);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [importYamlOpen, setImportYamlOpen] = useState(false);
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [skillCreateOpen, setSkillCreateOpen] = useState(false);
  const [editingDef, setEditingDef] = useState<AgentDefinition | null>(null);
  const [presetTarget, setPresetTarget] = useState<{ slug: string; name: string; def?: AgentDefinition } | null>(null);

  // ── agent 专属回调（自旧 View 平移，逻辑不变）─────────────────────────
  const handleEditAgent = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    try {
      const defs = await ipc.agent.list();
      const def = defs.find((d) => d.source === 'custom' && d.id === item.slug);
      if (def) setEditingDef(def);
      else console.warn('未找到资源对应的 agent 定义', { itemId, slug: item.slug });
    } catch (err) {
      console.error('打开 agent 编辑失败', { itemId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const openPresetDialog = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    if (!item || item.type !== 'agent') return;
    try {
      const defs = await ipc.agent.list();
      const def =
        item.source === 'builtin'
          ? (defs.find((d) => d.id === `builtin-${item.slug}`) ?? defs.find((d) => d.slug === item.slug))
          : defs.find((d) => d.slug === item.slug);
      setPresetTarget({ slug: item.slug, name: item.name, def });
    } catch (err) {
      console.error('打开预设 agent 配置失败', { itemId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleInstall = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    const ok = await installResource(itemId);
    // marketplace agent 安装成功 → 配置引导（def 刚落库需配模型；取消可稍后从「配置」再配）
    if (ok && item?.type === 'agent' && item.source === 'marketplace') {
      await openPresetDialog(itemId);
    }
  };

  const closePresetDialog = (): void => {
    setPresetTarget(null);
    void load();
  };

  // ── 三类页的「＋」菜单（最后一条固定「从网络获取」）───────────────────
  const addItemsFor = (type: ResourceType): AddMenuItem[] => {
    if (type === 'agent') {
      return [
        { key: 'wizard', title: '新建智能体…', hint: '分步向导：基础信息 → 提示词 → 能力 → 模型', onSelect: () => setCreateAgentOpen(true) },
        { key: 'import-yaml', title: '导入 YAML 文件…', hint: 'manifest 格式，校验后注册为自定义 agent', onSelect: () => setImportYamlOpen(true) },
        { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
      ];
    }
    if (type === 'mcp') {
      return [
        { key: 'form', title: '手动配置…', hint: '名称 / 命令 / 参数 / 环境变量（高级项默认折叠）', onSelect: () => setRegisterMcpOpen(true) },
        { key: 'json', title: '粘贴 JSON…', hint: 'mcpServers 格式，支持一次导入多条', onSelect: () => setMcpJsonOpen(true) },
        { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
      ];
    }
    return [
      { key: 'zip', title: '导入 zip 包…', hint: '拖放或选择文件（SKILL.md 打包）', onSelect: () => setUploadSkillOpen(true) },
      { key: 'create', title: '新建 SKILL.md…', hint: 'frontmatter（name/description）+ Markdown 正文', onSelect: () => setSkillCreateOpen(true) },
      { key: 'registry', title: '从网络获取…', hint: '浏览注册表（内置市场）', onSelect: () => setMode('registry') },
    ];
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      <TypeSidebar activeType={activeType} onSelect={setActiveType} />
      <TypePageShell
        type={activeType}
        addItems={addItemsFor(activeType)}
        onInstall={handleInstall}
        onEditAgent={handleEditAgent}
        onOpenPreset={openPresetDialog}
      />

      {/* 弹窗组（Task 10/12/13 的新弹窗接线后追加在此） */}
      {registerMcpOpen && (
        <RegisterMcpDialog onClose={() => setRegisterMcpOpen(false)} onSuccess={() => { setRegisterMcpOpen(false); void load(); }} />
      )}
      {uploadSkillOpen && (
        <UploadSkillDialog onClose={() => setUploadSkillOpen(false)} onSuccess={() => void load()} />
      )}
      {createAgentOpen && (
        <CreateAgentDialog source="library" onClose={() => { setCreateAgentOpen(false); void load(); }} />
      )}
      {editingDef && (
        <DefinitionEditor mode="edit" def={editingDef} onClose={() => { setEditingDef(null); void load(); }} />
      )}
      {presetTarget && (
        <EnablePresetDialog slug={presetTarget.slug} name={presetTarget.name} def={presetTarget.def} onClose={closePresetDialog} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 5: 资源库域全量回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library src/stores/resource.store.test.ts
```
预期：PASS（ResourceCard.test.tsx 仍独立通过——旧组件尚未删除）。

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/ResourceLibraryView.tsx renderer/src/components/resource-library/ResourceLibraryView.test.tsx
git commit -m "feat: 资源库壳重写——TypeSidebar + TypePageShell 三页结构"
```

---

### Task 9: RegisterMcpDialog 高级项折叠

**Files:**
- Modify: `renderer/src/components/agent/RegisterMcpDialog.tsx:126-150`（env 区块包进 details）
- Test: `renderer/src/components/agent/RegisterMcpDialog.test.tsx`（追加用例）

**Interfaces:** 组件签名不变（`onClose` / `onSuccess`），仅布局变化。

- [ ] **Step 1: 追加失败测试**

```tsx
// RegisterMcpDialog.test.tsx 追加
it('环境变量区默认折叠在「高级」内，展开后可输入', () => {
  render(<RegisterMcpDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByText('高级：环境变量')).toBeTruthy();
  const details = screen.getByText('高级：环境变量').closest('details');
  expect(details).toBeTruthy();
  expect(details).not.toHaveProperty('open', true);
  fireEvent.click(screen.getByText('高级：环境变量'));
  expect(details).toHaveProperty('open', true);
  expect(screen.getByPlaceholderText('KEY=VALUE')).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/RegisterMcpDialog.test.tsx
```

- [ ] **Step 3: 实现**

把 `RegisterMcpDialog.tsx` 中现有的环境变量区块（`<div className="flex flex-col gap-1">` 内含 `<label>环境变量</label>` + envRows 渲染 + 「+ 添加环境变量」按钮的整块，约 126-150 行）替换为：

```tsx
<details className="border border-subtle rounded-md px-3 py-2">
  <summary className="text-sm text-secondary cursor-pointer select-none">高级：环境变量</summary>
  <div className="flex flex-col gap-1 pt-2">
    <label className="text-sm text-secondary">环境变量</label>
    {/* 原有 envRows.map(...) 渲染与「+ 添加环境变量」按钮原样保留在此处（一字不改） */}
  </div>
</details>
```

- [ ] **Step 4: 跑测试确认通过（含既有用例——DOM 均在，行为不变）**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/RegisterMcpDialog.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/agent/RegisterMcpDialog.tsx renderer/src/components/agent/RegisterMcpDialog.test.tsx
git commit -m "refactor: RegisterMcpDialog 环境变量折叠进「高级」区（渐进披露）"
```

---

### Task 10: McpJsonPasteDialog（JSON 批量导入）

**Files:**
- Create: `renderer/src/components/resource-library/McpJsonPasteDialog.tsx`
- Test: `renderer/src/components/resource-library/McpJsonPasteDialog.test.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（接线 mcpJsonOpen）

**Interfaces:**
- Consumes: `parseMcpServersJson`（Task 2）、`ipc.resource.list` / `ipc.resource.registerMcp`
- Produces: `interface Props { onClose: () => void; onSuccess: () => void; }`——View 在 `mcpJsonOpen` 时挂载

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/McpJsonPasteDialog.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpJsonPasteDialog } from './McpJsonPasteDialog';

const listMock = vi.fn(async () => [
  { id: 'custom-mcp-github', type: 'mcp', source: 'custom', slug: 'github', name: 'github', description: '', installed: true, installable: false, removable: true },
]);
const registerMcpMock = vi.fn(async () => ({}));
vi.mock('../../ipc/client', () => ({
  ipc: { resource: { list: (...a: unknown[]) => listMock(...a), registerMcp: (...a: unknown[]) => registerMcpMock(...a) } },
}));

const NEW_JSON = JSON.stringify({ mcpServers: { fresh: { command: 'npx', args: ['-y', 'a'] } } });
const OVERLAP_JSON = JSON.stringify({ mcpServers: { github: { command: 'npx' } } });

describe('McpJsonPasteDialog', () => {
  beforeEach(() => { listMock.mockClear(); registerMcpMock.mockClear(); });

  it('非法 JSON 解析错误内联展示且不触发注册', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('内容不是合法 JSON')).toBeTruthy();
    expect(registerMcpMock).not.toHaveBeenCalled();
  });

  it('解析成功展示待导入清单（名称+命令摘要）', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: NEW_JSON } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('fresh')).toBeTruthy();
  });

  it('同名服务器出现覆盖确认文案；确认后逐条注册并展示结果摘要', async () => {
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), { target: { value: OVERLAP_JSON } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText(/将覆盖 1 个同名服务器/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(registerMcpMock).toHaveBeenCalledWith({ name: 'github', command: 'npx' }));
    expect(await screen.findByText(/成功 1 条/)).toBeTruthy();
  });

  it('部分失败展示失败清单（名称+原因），成功项不回滚', async () => {
    registerMcpMock.mockRejectedValueOnce(new Error('启动失败'));
    render(<McpJsonPasteDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('粘贴 JSON'), {
      target: { value: JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText(/失败 1 条/)).toBeTruthy();
    expect(screen.getByText(/a：启动失败/)).toBeTruthy();
    expect(registerMcpMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/McpJsonPasteDialog.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/McpJsonPasteDialog.tsx
// MCP JSON 批量导入（spec §4.2）：粘贴 → 解析预览（含同名覆盖确认）→ 逐条注册 → 结果摘要。
// 后端 registerMcp 为 INSERT OR REPLACE——覆盖语义必须在 UI 显式确认。
import { useState } from 'react';
import { ipc } from '../../ipc/client';
import type { ParsedMcpEntry } from '../../lib/mcp-json';
import { parseMcpServersJson } from '../../lib/mcp-json';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  onClose: () => void;
  /** 全部条目处理完毕（无论部分失败与否）后调用——父组件刷新列表 */
  onSuccess: () => void;
}

type Phase =
  | { kind: 'input' }
  | { kind: 'review'; entries: ParsedMcpEntry[]; conflicts: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; ok: number; failures: Array<{ name: string; reason: string }> };

export function McpJsonPasteDialog({ onClose, onSuccess }: Props) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [error, setError] = useState<string | null>(null);

  const handleParse = async (): Promise<void> => {
    setError(null);
    try {
      const entries = parseMcpServersJson(text);
      // 同名预检：与已注册 mcp 比对（slug 即 mcp name）
      const installed = await ipc.resource.list({ type: 'mcp' });
      const names = new Set(installed.map((i) => i.slug));
      const conflicts = entries.map((e) => e.name).filter((n) => names.has(n));
      setPhase({ kind: 'review', entries, conflicts });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async (): Promise<void> => {
    if (phase.kind !== 'review') return;
    setPhase({ kind: 'importing' });
    let ok = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    // 顺序执行（写库操作不并发；逐条收集错误）
    for (const entry of phase.entries) {
      try {
        await ipc.resource.registerMcp({
          name: entry.name,
          command: entry.command,
          args: entry.args,
          env: entry.env,
        });
        ok += 1;
      } catch (err) {
        failures.push({ name: entry.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    setPhase({ kind: 'done', ok, failures });
    if (ok > 0) onSuccess();
  };

  return (
    <Dialog open onClose={onClose} title="粘贴 JSON 导入 MCP" width={520}>
      <div className="flex flex-col gap-3">
        {phase.kind === 'input' && (
          <>
            <label htmlFor="mcp-json-input" className="text-sm text-secondary">
              粘贴 JSON（支持 {'{ "mcpServers": { … } }'} 或裸 {'{ "名称": { command, args, env } }'}）
            </label>
            <textarea
              id="mcp-json-input"
              aria-label="粘贴 JSON"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }'
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[12.5px] font-mono text-primary focus:border-focus focus:outline-none resize-y"
            />
            {error && <div className="text-status-error text-sm break-all">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
              <Button type="button" disabled={!text.trim()} onClick={() => void handleParse()}>解析</Button>
            </div>
          </>
        )}

        {phase.kind === 'review' && (
          <>
            <div className="text-sm text-secondary">待导入 {phase.entries.length} 条：</div>
            <ul className="max-h-52 overflow-y-auto flex flex-col gap-1">
              {phase.entries.map((e) => (
                <li key={e.name} className="text-xs text-secondary bg-surface-2 rounded-md px-2.5 py-1.5 flex items-center gap-2">
                  <span className="font-medium text-primary">{e.name}</span>
                  <code className="text-tertiary truncate">{e.command} {(e.args ?? []).join(' ')}</code>
                </li>
              ))}
            </ul>
            {phase.conflicts.length > 0 && (
              <div className="text-xs text-status-warning">
                将覆盖 {phase.conflicts.length} 个同名服务器：{phase.conflicts.join('、')}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => setPhase({ kind: 'input' })}>返回修改</Button>
              <Button type="button" onClick={() => void handleImport()}>确认导入</Button>
            </div>
          </>
        )}

        {phase.kind === 'importing' && <div className="text-sm text-tertiary py-4 text-center">导入中…</div>}

        {phase.kind === 'done' && (
          <>
            <div className="text-sm text-status-success">成功 {phase.ok} 条</div>
            {phase.failures.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-sm text-status-error">失败 {phase.failures.length} 条：</div>
                {phase.failures.map((f) => (
                  <div key={f.name} className="text-xs text-status-error break-all">{f.name}：{f.reason}</div>
                ))}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button type="button" onClick={onClose}>关闭</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: 接线 View**

`ResourceLibraryView.tsx`：import 补 `import { McpJsonPasteDialog } from './McpJsonPasteDialog';`，弹窗组追加：

```tsx
{mcpJsonOpen && (
  <McpJsonPasteDialog onClose={() => setMcpJsonOpen(false)} onSuccess={() => void load()} />
)}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/McpJsonPasteDialog.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/McpJsonPasteDialog.tsx renderer/src/components/resource-library/McpJsonPasteDialog.test.tsx renderer/src/components/resource-library/ResourceLibraryView.tsx
git commit -m "feat: MCP JSON 批量导入弹窗（解析预览+覆盖确认+结果摘要）"
```

---

### Task 11: `resource:createSkill` IPC（唯一新通道，两端同 commit）

**Files:**
- Modify: `electron/src/main/skill/zip-uploader.ts:102`（`nameToSlug` 加 `export`）
- Create: `electron/src/main/skill/form-create.ts`
- Modify: `electron/src/main/resource/ipc.handlers.ts`（新 handler）
- Modify: `electron/src/preload/index.ts`（resource 段加桥接）
- Modify: `renderer/src/ipc/types.d.ts`（`SkillCreateInput` + resource 面加 `createSkill`）
- Test: `electron/tests/skill/form-create.test.ts`

**Interfaces（两端同 commit，momo-boundary-rules 第 4 条）:**
```ts
interface SkillCreateInput { name: string; description: string; body: string; }
// renderer: ipc.resource.createSkill(input): Promise<UploadedSkill>
// electron: createSkillFromForm(input, skillsDir?) -> UploadedSkill
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/skill/form-create.test.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSkillFromForm } from '../../src/main/skill/form-create';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'momo-skill-create-'));
}

describe('createSkillFromForm', () => {
  it('生成 SKILL.md（frontmatter+正文）与 .sha256 标记，返回 UploadedSkill', () => {
    const dir = tmpDir();
    const out = createSkillFromForm(
      { name: 'My Cool Skill', description: '描述：含冒号', body: '# 正文\n内容' },
      dir,
    );
    expect(out).toEqual({ slug: 'my-cool-skill', name: 'My Cool Skill', description: '描述：含冒号' });
    const md = fs.readFileSync(path.join(dir, 'my-cool-skill', 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: "My Cool Skill"');
    expect(md).toContain('description: "描述：含冒号"');
    expect(md).toContain('# 正文');
    expect(fs.existsSync(path.join(dir, 'my-cool-skill', '.sha256'))).toBe(true);
  });

  it('同名重复创建覆盖旧目录（幂等语义与 zip 上传一致）', () => {
    const dir = tmpDir();
    createSkillFromForm({ name: 'dup', description: 'd', body: 'v1' }, dir);
    createSkillFromForm({ name: 'dup', description: 'd', body: 'v2' }, dir);
    const md = fs.readFileSync(path.join(dir, 'dup', 'SKILL.md'), 'utf-8');
    expect(md).toContain('v2');
  });

  it('空 name / 空 description / 空正文抛中文错误', () => {
    const dir = tmpDir();
    expect(() => createSkillFromForm({ name: '', description: 'd', body: 'b' }, dir)).toThrow('name 不能为空');
    expect(() => createSkillFromForm({ name: 'n', description: '', body: 'b' }, dir)).toThrow('description 不能为空');
    expect(() => createSkillFromForm({ name: 'n', description: 'd', body: ' ' }, dir)).toThrow('正文不能为空');
  });

  it('name 无法生成合法 slug 时抛错', () => {
    const dir = tmpDir();
    expect(() => createSkillFromForm({ name: '***', description: 'd', body: 'b' }, dir)).toThrow('无法从名称生成合法 slug');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/skill/form-create.test.ts
```

- [ ] **Step 3: 实现**

`zip-uploader.ts` 行 102：`function nameToSlug(` → `export function nameToSlug(`。

```ts
// electron/src/main/skill/form-create.ts
// 表单创建 skill（spec §5.1 唯一新 IPC 的主进程实现）：
//   name/description/body → <skillsDir>/<slug>/SKILL.md + .sha256 标记
// 与 zip 上传同布局——listInstalled 依据 .sha256 标记自动识别为 custom 源，无需写 DB。
// slug 冲突 = 覆盖（与 zip 重复上传同语义）。skillsDir 参数供测试注入。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir, nameToSlug, type UploadedSkill } from './zip-uploader';
import { logger } from '../logger';

export interface SkillCreateInput {
  name: string;
  description: string;
  body: string;
}

export function createSkillFromForm(input: SkillCreateInput, skillsDir: string = getSkillsDir()): UploadedSkill {
  if (!input.name.trim()) throw new Error('name 不能为空');
  if (!input.description.trim()) throw new Error('description 不能为空');
  if (!input.body.trim()) throw new Error('正文不能为空');
  const slug = nameToSlug(input.name);
  if (!slug) throw new Error(`无法从名称生成合法 slug：${input.name}`);

  const targetDir = path.join(skillsDir, slug);
  // frontmatter 值用 JSON 风格双引号转义——防描述含 ': ' 等 YAML 破坏字符
  const content = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n${input.body}`;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content, 'utf-8');
  // .sha256 标记 = custom 源识别依据（内容 hash，与 zip 上传同口径）
  fs.writeFileSync(
    path.join(targetDir, '.sha256'),
    crypto.createHash('sha256').update(content, 'utf-8').digest('hex'),
  );
  logger.info('Skill 表单创建成功', { slug });
  return { slug, name: input.name, description: input.description };
}
```

`ipc.handlers.ts` import 段补：

```ts
import { createSkillFromForm, type SkillCreateInput } from '../skill/form-create';
```

`resource:uploadSkill` handler 之后追加：

```ts
// resource:createSkill — 表单创建 skill（spec 2026-09-22 资源库重设计，唯一新通道）。
// 写 <skillsDir>/<slug>/SKILL.md + .sha256 标记（listInstalled 自动识别 custom 源）；
// slug 冲突覆盖（与 zip 重复上传同语义——UI 提交前自行比对提示）。
ipcMain.handle('resource:createSkill', async (_evt, input: SkillCreateInput) => {
  const uploaded = createSkillFromForm(input);
  void broadcastLocalResourceCatalog();
  return uploaded;
});
```

`preload/index.ts` resource 段（`uploadSkill` 桥接之后、跟随文件既有 import 风格）补：

```ts
/** 表单创建 skill（frontmatter+正文 → custom skill；slug 冲突覆盖） */
createSkill: (input: SkillCreateInput) => invoke<UploadedSkill>('resource:createSkill', input),
```

`renderer/src/ipc/types.d.ts`：`RegisterMcpInput` 之后加：

```ts
/** resource:createSkill 入参——表单创建 skill（spec 2026-09-22 资源库重设计） */
export interface SkillCreateInput {
  name: string;
  description: string;
  body: string;
}
```

`ApiSurface.resource` 段（`uploadSkill` 之后）加：

```ts
/** 表单创建 skill（frontmatter+正文 → custom skill；slug 冲突覆盖，返回同 zip 上传形状） */
createSkill(input: SkillCreateInput): Promise<UploadedSkill>;
```

- [ ] **Step 4: 跑测试 + 双端 typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/skill/form-create.test.ts
cd /workspace && npx pnpm@9.0.0 typecheck
```
预期：测试 PASS；typecheck 双 workspace 0 error。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/skill/zip-uploader.ts electron/src/main/skill/form-create.ts electron/src/main/resource/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/skill/form-create.test.ts
git commit -m "feat: resource:createSkill 通道——表单创建 skill（两端类型同 commit 对齐）"
```

---

### Task 12: SkillCreateDialog

**Files:**
- Create: `renderer/src/components/resource-library/SkillCreateDialog.tsx`
- Test: `renderer/src/components/resource-library/SkillCreateDialog.test.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（接线 skillCreateOpen）

**Interfaces:**
- Consumes: `ipc.resource.createSkill`（Task 11）、`ipc.resource.list`（slug 冲突预检）
- Produces: `interface Props { onClose: () => void; onSuccess: () => void; }`

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/SkillCreateDialog.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillCreateDialog } from './SkillCreateDialog';

const listMock = vi.fn(async () => [
  { id: 'custom-skill-dup', type: 'skill', source: 'custom', slug: 'dup', name: 'dup', description: '', installed: true, installable: false, removable: true },
]);
const createSkillMock = vi.fn(async () => ({ slug: 'new-one', name: 'New One', description: 'd' }));
vi.mock('../../ipc/client', () => ({
  ipc: { resource: { list: (...a: unknown[]) => listMock(...a), createSkill: (...a: unknown[]) => createSkillMock(...a) } },
}));

function fillForm(): void {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'New One' } });
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'd' } });
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '# 你好' } });
}

describe('SkillCreateDialog', () => {
  beforeEach(() => { listMock.mockClear(); createSkillMock.mockClear(); });

  it('必填缺失时提交禁用', () => {
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
  });

  it('填齐后提交调 createSkill，成功提示保留展示', async () => {
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(createSkillMock).toHaveBeenCalledWith({ name: 'New One', description: 'd', body: '# 你好' }),
    );
    expect(await screen.findByText(/已创建：new-one/)).toBeTruthy();
  });

  it('slug 与已装 skill 同名时显示覆盖警示文案', async () => {
    render(<SkillCreateDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'd' } });
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: 'b' } });
    expect(await screen.findByText(/已存在同名 skill，保存将覆盖/)).toBeTruthy();
  });

  it('创建失败内联红字且弹窗不关', async () => {
    createSkillMock.mockRejectedValueOnce(new Error('写盘失败'));
    const onClose = vi.fn();
    render(<SkillCreateDialog onClose={onClose} onSuccess={vi.fn()} />);
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('写盘失败')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/SkillCreateDialog.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/SkillCreateDialog.tsx
// 新建 SKILL.md（spec §4.3）：name/description + Markdown 正文表单，生成内容可预览；
// 提交走 resource:createSkill（slug 冲突覆盖语义先警示）。
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

export function SkillCreateDialog({ onClose, onSuccess }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [existingSlugs, setExistingSlugs] = useState<Set<string>>(new Set());

  // 挂载即取已装 skill slug 集（覆盖警示预检；失败不阻断创建）
  useEffect(() => {
    let cancelled = false;
    ipc.resource.list({ type: 'skill' })
      .then((items) => { if (!cancelled) setExistingSlugs(new Set(items.map((i) => i.slug))); })
      .catch(() => { /* 预检失败静默 */ });
    return () => { cancelled = true; };
  }, []);

  // 本地同款 slug 化（仅预览/预检用；权威 slug 由主进程生成）
  const previewSlug = useMemo(
    () => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
    [name],
  );
  const willOverwrite = previewSlug !== '' && existingSlugs.has(previewSlug);
  const canCreate = name.trim() !== '' && description.trim() !== '' && body.trim() !== '' && !creating;
  const preview = `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n${body}`;

  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const uploaded = await ipc.resource.createSkill({
        name: name.trim(),
        description: description.trim(),
        body,
      });
      setSuccessMsg(`已创建：${uploaded.slug}（${uploaded.description}）`);
      onSuccess(); // 先刷新列表，弹窗保留展示成功消息（对齐 UploadSkillDialog 模式）
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="新建 SKILL.md" width={520}>
      <div className="flex flex-col gap-3">
        <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：pdf-report-writer" autoFocus />
        <Input label="描述" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明用途（注入索引用）" />
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-body" className="text-sm text-secondary">正文（Markdown）</label>
          <textarea
            id="skill-body"
            aria-label="正文"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'# 使用指引\n…'}
            className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
          />
        </div>
        {willOverwrite && (
          <div className="text-xs text-status-warning">已存在同名 skill（{previewSlug}），保存将覆盖</div>
        )}
        <details className="border border-subtle rounded-md px-3 py-2">
          <summary className="text-sm text-secondary cursor-pointer select-none">预览生成的 SKILL.md</summary>
          <pre className="mt-2 text-xs font-mono text-secondary whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{preview}</pre>
        </details>
        {successMsg && <div className="text-status-success text-sm break-all">{successMsg}</div>}
        {error && <div className="text-status-error text-sm break-all">{error}</div>}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={creating}>关闭</Button>
          <Button type="button" disabled={!canCreate} onClick={() => void handleCreate()}>
            {creating ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: 接线 View**

`ResourceLibraryView.tsx`：import 补 `import { SkillCreateDialog } from './SkillCreateDialog';`，弹窗组追加：

```tsx
{skillCreateOpen && (
  <SkillCreateDialog onClose={() => setSkillCreateOpen(false)} onSuccess={() => void load()} />
)}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/SkillCreateDialog.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/SkillCreateDialog.tsx renderer/src/components/resource-library/SkillCreateDialog.test.tsx renderer/src/components/resource-library/ResourceLibraryView.tsx
git commit -m "feat: 新建 SKILL.md 表单弹窗（预览+覆盖警示）"
```

---

### Task 13: ImportAgentYamlDialog（复用 agent.createFromYaml）

**Files:**
- Create: `renderer/src/components/resource-library/ImportAgentYamlDialog.tsx`
- Test: `renderer/src/components/resource-library/ImportAgentYamlDialog.test.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（接线 importYamlOpen）

**Interfaces:**
- Consumes: `ipc.agent.createFromYaml(yaml: string): Promise<AgentDefinition>`（现有通道）
- Produces: `interface Props { onClose: () => void; onSuccess: () => void; }`

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/ImportAgentYamlDialog.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';

const createFromYamlMock = vi.fn();
vi.mock('../../ipc/client', () => ({
  ipc: { agent: { createFromYaml: (...a: unknown[]) => createFromYamlMock(...a) } },
}));

const VALID_YAML = 'apiVersion: v1\nkind: AgentDefinition\nmetadata:\n  name: 审查员\n  slug: reviewer\nspec:\n  declarative:\n    systemPrompt: 你是审查员\n    model:\n      provider: openai\n      model: gpt-4o\n';

describe('ImportAgentYamlDialog', () => {
  beforeEach(() => createFromYamlMock.mockReset());

  it('选择文件后读取文本并展示文件名', async () => {
    render(<ImportAgentYamlDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'reviewer.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    expect(await screen.findByText('reviewer.yaml')).toBeTruthy();
  });

  it('导入调 agent.createFromYaml（原文透传），成功展示名称', async () => {
    createFromYamlMock.mockResolvedValue({ id: 'u1', name: '审查员', slug: 'reviewer' });
    render(<ImportAgentYamlDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'reviewer.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(createFromYamlMock).toHaveBeenCalledWith(VALID_YAML));
    expect(await screen.findByText(/已导入：审查员/)).toBeTruthy();
  });

  it('校验失败错误内联且弹窗不关', async () => {
    createFromYamlMock.mockRejectedValue(new Error('Agent manifest 校验失败:\n  - metadata.slug 不能为空'));
    const onClose = vi.fn();
    render(<ImportAgentYamlDialog onClose={onClose} onSuccess={vi.fn()} />);
    const file = new File([VALID_YAML], 'bad.yaml', { type: 'text/yaml' });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    expect(await screen.findByText(/metadata.slug 不能为空/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ImportAgentYamlDialog.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/ImportAgentYamlDialog.tsx
// 导入 Agent YAML（spec §4.1）——复用现有 agent.createFromYaml 通道
// （manifest 解析+校验+落库一体；校验错误含字段名，内联展示不关弹窗）。
import { useRef, useState, type ChangeEvent } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

/** FileReader 读文本（jsdom 未实现 File.text()——UploadSkillDialog 同款约束） */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

const noop = (): void => undefined;

export function ImportAgentYamlDialog({ onClose, onSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    setError(null);
    setSuccessMsg(null);
  };

  const handleImport = async (): Promise<void> => {
    if (!file || importing) return;
    setImporting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const yaml = await readFileAsText(file);
      const def = await ipc.agent.createFromYaml(yaml);
      setSuccessMsg(`已导入：${def.name}（${def.slug}）`);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open onClose={importing ? noop : onClose} title="导入 Agent YAML" width={448}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm text-secondary">Agent manifest 文件（.yaml / .yml）</label>
          <div className="flex gap-2 items-center">
            <Button variant="ghost" type="button" onClick={() => inputRef.current?.click()} disabled={importing}>
              选择文件...
            </Button>
            <span className="text-sm text-tertiary truncate flex-1">{file ? file.name : '未选择文件'}</span>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".yaml,.yml,.txt"
            onChange={handleFileChange}
            className="hidden"
            aria-label="选择文件"
            disabled={importing}
          />
          <p className="text-xs text-tertiary mt-1">
            K8s 风格 manifest（apiVersion: v1 / kind: AgentDefinition / metadata / spec.declarative），
            校验失败会逐条列出字段问题。
          </p>
        </div>
        {successMsg && <div className="text-status-success text-sm break-all">{successMsg}</div>}
        {error && <div className="text-status-error text-sm whitespace-pre-wrap break-all">{error}</div>}
        <div className="flex gap-2 justify-end mt-1">
          <Button variant="ghost" type="button" onClick={onClose} disabled={importing}>取消</Button>
          <Button type="button" disabled={!file || importing} onClick={() => void handleImport()}>
            {importing ? '导入中…' : '导入'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: 接线 View**

`ResourceLibraryView.tsx`：import 补 `import { ImportAgentYamlDialog } from './ImportAgentYamlDialog';`，弹窗组追加：

```tsx
{importYamlOpen && (
  <ImportAgentYamlDialog onClose={() => setImportYamlOpen(false)} onSuccess={() => void load()} />
)}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ImportAgentYamlDialog.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/ImportAgentYamlDialog.tsx renderer/src/components/resource-library/ImportAgentYamlDialog.test.tsx renderer/src/components/resource-library/ResourceLibraryView.tsx
git commit -m "feat: Agent YAML 导入弹窗（复用 agent.createFromYaml，零新 IPC）"
```

---

### Task 14: AgentCreateWizard（4 步向导）

**Files:**
- Create: `renderer/src/components/resource-library/wizard/AgentCreateWizard.tsx`
- Test: `renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（`createAgentOpen` 弹窗 CreateAgentDialog → AgentCreateWizard）

**Interfaces:**
- Consumes: `ipc.agent.createCustom`（现成含 `defaultMcps`/`defaultSkills`）、`ipc.resource.list`（能力多选数据）、`ProviderModelPicker` / `ThinkingOverrideControl`（`components/agent/`）、`SAFE_MINIMUM_TOOLS` / `ALL_BUILTIN_TOOLS` / `TOOL_CATEGORIES`（`lib/tool-catalog`）
- Produces: `interface Props { onClose: () => void; onSuccess: () => void; }`。MembersPanel 的 CreateAgentDialog **保留不动**（spec §11 非目标）。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentCreateWizard } from './AgentCreateWizard';

const createCustomMock = vi.fn(async () => ({ id: 'u1', name: '审查员', slug: 'reviewer' }));
const listMock = vi.fn(async (filter?: { type?: string }) => {
  if (filter?.type === 'mcp') return [
    { id: 'custom-mcp-github', type: 'mcp', source: 'custom', slug: 'github', name: 'github', description: '', installed: true, installable: false, removable: true },
  ];
  return [
    { id: 'custom-skill-pdf', type: 'skill', source: 'custom', slug: 'pdf', name: 'pdf', description: '', installed: true, installable: false, removable: true },
  ];
});
vi.mock('../../../ipc/client', () => ({
  ipc: {
    agent: { createCustom: (...a: unknown[]) => createCustomMock(...a) },
    resource: { list: (...a: unknown[]) => listMock(...a) },
  },
}));
vi.mock('../../agent/ProviderModelPicker', () => ({
  ProviderModelPicker: ({ onProviderChange, onModelChange }: { onProviderChange: (v: string) => void; onModelChange: (v: string) => void }) => (
    <div aria-label="model-picker-stub">
      <button type="button" onClick={() => onProviderChange('openai')}>选供应商</button>
      <button type="button" onClick={() => onModelChange('gpt-4o')}>选模型</button>
    </div>
  ),
}));
vi.mock('../../agent/ThinkingOverrideControl', () => ({
  ThinkingOverrideControl: () => <div aria-label="thinking-stub" />,
}));

function fillStep1AndNext(): void {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '审查员' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}
function fillStep2AndNext(): void {
  fireEvent.change(screen.getByLabelText('系统提示词'), { target: { value: '你是审查员' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

describe('AgentCreateWizard', () => {
  beforeEach(() => createCustomMock.mockClear());

  it('四步流转：基础→提示词→能力→模型；必填校验拦截空步', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    // 步 1：名称必填
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('名称不能为空')).toBeTruthy();
    fillStep1AndNext();
    // 步 2：提示词必填
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('系统提示词不能为空')).toBeTruthy();
    fillStep2AndNext();
    // 步 3：能力绑定（MCP/Skill 多选出现）
    expect(await screen.findByText('github')).toBeTruthy();
    expect(screen.getByText('pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    // 步 4：模型
    expect(screen.getByLabelText('model-picker-stub')).toBeTruthy();
  });

  it('步 3 勾选 MCP/Skill 后 createCustom 携带 defaultMcps/defaultSkills', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fillStep2AndNext();
    fireEvent.click(await screen.findByRole('checkbox', { name: /github/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '选供应商' }));
    fireEvent.click(screen.getByRole('button', { name: '选模型' }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustomMock).toHaveBeenCalled());
    const arg = createCustomMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.defaultMcps).toEqual([{ kind: 'mcp', ref: 'github' }]);
    expect(arg.defaultSkills).toEqual([{ kind: 'skill', ref: 'pdf' }]);
    expect(arg.scope).toBe('global');
  });

  it('上一步回退保留已填内容', () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    fillStep1AndNext();
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('审查员');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/wizard/AgentCreateWizard.test.tsx
```

- [ ] **Step 3: 实现**

```tsx
// renderer/src/components/resource-library/wizard/AgentCreateWizard.tsx
// 新建智能体 4 步向导（spec §4.1）：基础信息 → System Prompt → 能力绑定 → 模型与完成。
// 提交复用 agent.createCustom（现成支持 defaultMcps/defaultSkills）。
// MembersPanel 的 CreateAgentDialog 保留不动（收敛为后续迭代，spec §11）。
import { useEffect, useState } from 'react';
import { ipc } from '../../../ipc/client';
import type { ResourceItem, ThinkingConfig } from '../../../ipc/types';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../../lib/tool-catalog';
import { ProviderModelPicker } from '../../agent/ProviderModelPicker';
import { ThinkingOverrideControl } from '../../agent/ThinkingOverrideControl';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Dialog } from '../../ui/Dialog';
import { cn } from '../../../lib/cn';

type ToolPreset = 'safe' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'safe', label: '安全最小集', hint: '读写 / 搜索 / todo，不含 Shell 与 Git 写操作' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash 与 git 写操作）' },
  { key: 'custom', label: '自选', hint: '手动勾选工具' },
];

const STEPS = ['基础信息', '提示词', '能力', '模型'] as const;

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

export function AgentCreateWizard({ onClose, onSuccess }: Props) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 步 1：基础信息
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iconEmoji, setIconEmoji] = useState('🤖');
  // 步 2：System Prompt
  const [prompt, setPrompt] = useState('');
  // 步 3：能力绑定
  const [preset, setPreset] = useState<ToolPreset>('safe');
  const [customTools, setCustomTools] = useState<string[]>([...SAFE_MINIMUM_TOOLS]);
  const [mcps, setMcps] = useState<ResourceItem[]>([]);
  const [skills, setSkills] = useState<ResourceItem[]>([]);
  const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  // 步 4：模型与完成
  const [providerId, setProviderId] = useState('');
  const [modelName, setModelName] = useState('');
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(null);

  // 步 3 挂载时拉能力多选数据（已安装 mcp / skill；失败不阻断创建）
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    Promise.all([ipc.resource.list({ type: 'mcp' }), ipc.resource.list({ type: 'skill' })])
      .then(([m, s]) => {
        if (cancelled) return;
        setMcps(m.filter((i) => i.installed));
        setSkills(s.filter((i) => i.installed));
      })
      .catch(() => { /* 多选区为空 */ });
    return () => { cancelled = true; };
  }, [step]);

  const validateStep = (): string | null => {
    if (step === 0 && !name.trim()) return '名称不能为空';
    if (step === 1 && !prompt.trim()) return '系统提示词不能为空';
    if (step === 3 && (!providerId || !modelName.trim())) return '请选择模型供应商与模型';
    return null;
  };

  const handleNext = (): void => {
    const err = validateStep();
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleSubmit = async (): Promise<void> => {
    const err = validateStep();
    if (err) { setError(err); return; }
    setSaving(true);
    setError(null);
    try {
      const tools =
        preset === 'safe' ? SAFE_MINIMUM_TOOLS : preset === 'all' ? ALL_BUILTIN_TOOLS : customTools;
      await ipc.agent.createCustom({
        name: name.trim(),
        slug: name.trim().toLowerCase().replace(/\s+/g, '-'),
        description: description.trim() || `自定义 agent: ${name.trim()}`,
        systemPrompt: prompt.trim(),
        iconEmoji,
        scope: 'global',
        modelProviderId: providerId,
        modelName: modelName.trim(),
        thinkingJson,
        defaultTools: tools.map((ref) => ({ kind: 'builtin' as const, ref })),
        defaultMcps: selectedMcps.map((ref) => ({ kind: 'mcp' as const, ref })),
        defaultSkills: selectedSkills.map((ref) => ({ kind: 'skill' as const, ref })),
      });
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (list: string[], setList: (v: string[]) => void, v: string): void =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog open onClose={onClose} title="新建智能体" width={520}>
      <div className="flex flex-col gap-4">
        {/* 步进条 */}
        <ol className="flex items-center gap-1.5 text-xs">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[11px]',
                  i < step
                    ? 'bg-status-success-tint text-status-success'
                    : i === step
                      ? 'bg-accent-500 text-inverse'
                      : 'bg-surface-3 text-tertiary',
                )}
              >
                {i + 1}
              </span>
              <span className={i === step ? 'text-primary font-medium' : 'text-tertiary'}>{label}</span>
              {i < STEPS.length - 1 && <span className="w-4 h-px bg-border-strong" />}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="flex flex-col gap-3">
            <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：代码审查员" autoFocus />
            <Input label="描述" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明（可选）" />
            <Input label="图标 emoji" value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} placeholder="用户数据照渲染" />
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="wizard-prompt" className="text-sm text-secondary">系统提示词</label>
            <textarea
              id="wizard-prompt"
              aria-label="系统提示词"
              rows={8}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="你是一名资深审查员..."
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none resize-y"
            />
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            {/* 默认工具集三档（平移自 CreateAgentDialog） */}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm text-secondary">默认工具集</legend>
              {PRESETS.map((p) => (
                <label key={p.key} className="flex items-start gap-2 text-sm text-secondary">
                  <input
                    type="radio"
                    name="wizard-tool-preset"
                    aria-label={p.label}
                    checked={preset === p.key}
                    onChange={() => setPreset(p.key)}
                    className="mt-0.5"
                  />
                  <span>
                    {p.label}
                    <span className="block text-xs text-tertiary">{p.hint}</span>
                  </span>
                </label>
              ))}
              {preset === 'custom' && (
                <div className="flex flex-col gap-2 pl-5 pt-1">
                  {TOOL_CATEGORIES.map((cat) => (
                    <div key={cat.label}>
                      <div className="text-xs text-tertiary mb-1">{cat.emoji} {cat.label}</div>
                      <div className="flex flex-wrap gap-2">
                        {cat.tools.map((tool) => (
                          <label key={tool} className="flex items-center gap-1 text-xs text-secondary">
                            <input
                              type="checkbox"
                              aria-label={tool}
                              checked={customTools.includes(tool)}
                              onChange={(e) => toggle(customTools, setCustomTools, tool)}
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>
            {/* MCP / Skill 多选（数据来自资源库已装项） */}
            <div className="flex flex-col gap-2">
              <span className="text-sm text-secondary">绑定 MCP（可选）</span>
              <div className="flex flex-wrap gap-2">
                {mcps.length === 0 && <span className="text-xs text-tertiary">暂无已安装 MCP</span>}
                {mcps.map((m) => (
                  <label key={m.id} className="flex items-center gap-1 text-xs text-secondary">
                    <input
                      type="checkbox"
                      aria-label={m.name}
                      checked={selectedMcps.includes(m.slug)}
                      onChange={() => toggle(selectedMcps, setSelectedMcps, m.slug)}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              <span className="text-sm text-secondary">绑定 Skill（可选）</span>
              <div className="flex flex-wrap gap-2">
                {skills.length === 0 && <span className="text-xs text-tertiary">暂无已安装 Skill</span>}
                {skills.map((s) => (
                  <label key={s.id} className="flex items-center gap-1 text-xs text-secondary">
                    <input
                      type="checkbox"
                      aria-label={s.name}
                      checked={selectedSkills.includes(s.slug)}
                      onChange={() => toggle(selectedSkills, setSelectedSkills, s.slug)}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-3">
            <ProviderModelPicker
              providerId={providerId}
              modelId={modelName}
              onProviderChange={setProviderId}
              onModelChange={(id) => {
                setModelName(id);
                setThinkingJson(null); // 换模型重置覆盖，防旧档位残留
              }}
            />
            <ThinkingOverrideControl value={thinkingJson} onChange={setThinkingJson} />
            <p className="text-xs text-tertiary">仅创建全局 Agent 定义；加入具体工作空间请从「Agent 管理 → 成员」添加</p>
          </div>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}

        <div className="flex gap-2 justify-end">
          {step > 0 && (
            <Button variant="ghost" type="button" onClick={() => { setError(null); setStep((s) => s - 1); }}>
              上一步
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={handleNext}>下一步</Button>
          ) : (
            <Button type="button" disabled={saving} onClick={() => void handleSubmit()}>
              {saving ? '创建中…' : '创建'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
```

注意：`ProviderModelPicker` / `ThinkingOverrideControl` 的 props 形状以 `CreateAgentDialog.tsx:140-155` 的真实用法为准（如 `ThinkingOverrideControl` 需 `capability` 入参则照抄补上）；实现时打开该文件对照，勿凭记忆。

- [ ] **Step 4: View 替换**

`ResourceLibraryView.tsx`：import 的 `CreateAgentDialog` 替换为 `import { AgentCreateWizard } from './wizard/AgentCreateWizard';`；弹窗组中 `createAgentOpen` 分支替换为：

```tsx
{createAgentOpen && (
  <AgentCreateWizard onClose={() => { setCreateAgentOpen(false); void load(); }} onSuccess={() => void load()} />
)}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/wizard/AgentCreateWizard.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/wizard/ renderer/src/components/resource-library/ResourceLibraryView.tsx
git commit -m "feat: AgentCreateWizard 四步向导（能力绑定走 createCustom 现成 mcps/skills 字段）"
```

---

### Task 15: ResourceDetail 三段式改造

**Files:**
- Modify: `renderer/src/components/resource-library/ResourceDetail.tsx`
- Test: `renderer/src/components/resource-library/ResourceDetail.test.tsx`（更新断言）

**Interfaces:** 对外 props 不变（TypePageShell 已在用）；内部结构改为三段式：状态 / 配置预览 / 元数据 + 底部操作条（现有按钮逻辑不动）。新增 custom agent 的定义预览（经 `ipc.agent.list` 反查 def，与 View 层 `handleEditAgent` 同口径：custom agent 资源 slug = def.id）。

- [ ] **Step 1: 更新测试（锁定三段结构）**

在 `ResourceDetail.test.tsx` 中追加/调整用例（沿用文件内既有 mkItem 辅助）：

```tsx
it('三段式标签齐全：状态 / 配置预览 / 元数据', () => {
  render(<ResourceDetail item={mkCustomMcpItem()} onClose={vi.fn()} />);
  expect(screen.getByText('状态')).toBeTruthy();
  expect(screen.getByText('配置预览')).toBeTruthy();
  expect(screen.getByText('元数据')).toBeTruthy();
});

it('custom agent 反查 def 并展示 YAML 预览（slug=def.id 口径）', async () => {
  // mock ipc.agent.list 返回 def；item.slug = def.id
  render(<ResourceDetail item={mkCustomAgentItem()} onClose={vi.fn()} />);
  expect(await screen.findByText(/systemPrompt:/)).toBeTruthy();
});
```

（具体 mock 写法沿用该测试文件既有的 `vi.mock('../../ipc/client')` 模式。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx
```

- [ ] **Step 3: 实现**

`ResourceDetail.tsx` 改造要点（保留文件头注释与底部操作条原样）：

1. 顶部补 state 与 effect——custom agent 反查 def：

```tsx
const [defPreview, setDefPreview] = useState<string | null>(null);
useEffect(() => {
  if (!(item.source === 'custom' && item.type === 'agent')) { setDefPreview(null); return; }
  let cancelled = false;
  // custom agent 资源 slug = def.id（UUID）——与 View 层 handleEditAgent 同口径
  ipc.agent.list()
    .then((defs) => {
      if (cancelled) return;
      const def = defs.find((d) => d.source === 'custom' && d.id === item.slug);
      if (!def) { setDefPreview(null); return; }
      const promptHead = def.systemPrompt.slice(0, 200);
      setDefPreview(
        `# ${def.name} (${def.slug})\n` +
        `model: ${def.modelProviderId || '(未配置)'} / ${def.modelName}\n` +
        `tools: ${def.defaultTools.map((t) => t.ref).join(', ') || '(空)'}\n` +
        `mcps: ${def.defaultMcps.map((m) => m.ref).join(', ') || '(空)'}\n` +
        `skills: ${def.defaultSkills.map((s) => s.ref).join(', ') || '(空)'}\n\n` +
        `systemPrompt:\n${promptHead}${def.systemPrompt.length > 200 ? '…' : ''}`,
      );
    })
    .catch(() => { if (!cancelled) setDefPreview(null); });
  return () => { cancelled = true; };
}, [item]);
```

（import 补 `ipc`、`useEffect`。）

2. 可滚动内容区的各块分别包进三个带小标题的 section（标题样式 `text-xs text-tertiary`，对齐现有「描述」标签）：

```tsx
<section>
  <div className="text-xs text-tertiary mb-1">状态</div>
  {/* 原 SourceBadge + sourceLabel·type·version 行移入此处 */}
</section>
<section>
  <div className="text-xs text-tertiary mb-1">配置预览</div>
  {/* custom MCP 的命令/参数/env（KEY=***）、custom Skill 的 frontmatter、
      custom Agent 的 defPreview（<pre className="...font-mono whitespace-pre-wrap">{defPreview}</pre>），
      builtin/marketplace 的 README 折叠——原各条件块移入，内容不动 */}
</section>
<section>
  <div className="text-xs text-tertiary mb-1">元数据</div>
  {/* 作者/校验状态/下载地址（marketplace）、安装时间、p2p 来源节点——原各条件块移入 */}
</section>
```

3. 原「描述」块保留在状态段之前（不属于三段，作为导语）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/resource-library/ResourceDetail.tsx renderer/src/components/resource-library/ResourceDetail.test.tsx
git commit -m "feat: ResourceDetail 三段式改造（状态/配置预览/元数据 + custom agent 定义预览）"
```

---

### Task 16: 清理旧组件 + 全量回归

**Files:**
- Delete: `renderer/src/components/resource-library/ResourceCard.tsx` + `ResourceCard.test.tsx`
- Delete: `renderer/src/components/resource-library/AddResourceMenu.tsx`（若存在测试一并删）

**Interfaces:** 无——纯清理与验证。

- [ ] **Step 1: 确认无残留引用**

```bash
cd renderer && grep -rn "ResourceCard\|AddResourceMenu" src/ --include='*.tsx' --include='*.ts'
```
预期：仅 ResourceCard.tsx / ResourceCard.test.tsx / AddResourceMenu.tsx 自身命中（及其测试）。如有其它引用，先修复再删除。

- [ ] **Step 2: 删除文件**

```bash
git rm renderer/src/components/resource-library/ResourceCard.tsx renderer/src/components/resource-library/ResourceCard.test.tsx renderer/src/components/resource-library/AddResourceMenu.tsx
```

- [ ] **Step 3: typecheck + lint + 全量测试**

```bash
nvm use 20
cd /workspace && npx pnpm@9.0.0 typecheck
cd renderer && npx pnpm@9.0.0 exec eslint src/components/resource-library src/stores src/services src/lib
npx pnpm@9.0.0 test
```
预期：typecheck 双 workspace 0 error；eslint 0 error；`pnpm test`（electron + renderer 全部）PASS。任何失败先修复再继续——禁止跳过或删测试。

- [ ] **Step 4: 冒烟（可选但推荐）**

```bash
cd /workspace && npx pnpm@9.0.0 dev
```
人工核对：活动栏 → 资源库 → 三页切换 / 三类「＋」下拉 / JSON 粘贴导入 / SKILL.md 新建 / YAML 导入 / 网络获取模式安装。容器内无 GUI，需 `xvfb-run -a --server-args="-screen 0 1280x800x24"` 包裹，或在 macOS 主机验收。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: 移除资源库旧组件（ResourceCard/AddResourceMenu），三页结构收官"
```

---

## Self-Review 结论（计划完成后自查记录）

1. **Spec 覆盖**：spec §2（骨架=Task 1/5/7/8）、§3（Provider=Task 3）、§4.1-4.3（三类添加流程=Task 8/9/10/12/13/14）、§4.4（RegistryBrowse=Task 7）、§5（IPC=Task 11）、§6（行/详情=Task 4/15）、§7（错误与空态：各组件测试均有专项用例）、§8（测试计划：每个 task 内嵌 TDD 步骤）、§10（文件清单：与各 task Files 一致）、P2/非目标不在本计划。
2. **占位符**：无 TBD/TODO；Task 15 的「原各条件块移入」指 `ResourceDetail.tsx` 现存代码块原样移动（该文件已存在，不重复抄写），实现者打开文件即可对照。
3. **类型一致性**：`RegistryEntry`/`RegistryProvider`（Task 3 定义，Task 7 消费）、`AddMenuItem`（Task 6 定义，Task 7/8 消费）、`TYPE_ICON`（Task 4 定义，Task 5/7 消费）、`ParsedMcpEntry`（Task 2 定义，Task 10 消费）、`SkillCreateInput`（Task 11 两端定义）、`setActiveType`/`setMode`（Task 1 定义，Task 7/8 消费）——签名已逐一核对一致。
