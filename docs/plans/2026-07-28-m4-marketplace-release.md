# AgentPlatform M4 — Marketplace + 打包发布 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 用户能在应用内浏览/搜索/安装 Agent/MCP/Skill 包；应用能打包成 macOS/Linux 安装包发布。

**架构：** 静态 JSON catalog（GitHub 托管或本地文件）+ 桌面客户端（fetch + install）+ electron-builder 打包。v1 不做 marketplace 服务器（用静态 catalog 代替）。

**技术栈：** 无新依赖。HTTP 用 `fetch`，解压用 Node.js `tar` 模块（`node:zlib` + 手写或 `tar` npm 包）。

## 全局约束

- **Marketplace v1 仅浏览 + 安装**（无上传 — 那是 v2）。
- **Catalog 是静态 JSON**（GitHub raw URL 或本地文件），不是独立服务器。
- **安装包格式**：tar.gz，含 manifest.yaml（agent）/ SKILL.md（skill）/ package.json（mcp）。
- **校验**：SHA-256 checksum。
- **verification status**：unverified / community / verified / official（显示用，v1 不做实际审核）。
- 代码注释用中文。工作目录 `/workspace`。

## 文件结构

```
electron/src/main/
├── marketplace/
│   ├── types.ts              # MarketplaceItem, Catalog 类型
│   ├── client.ts             # fetch catalog + download package
│   ├── installer.ts          # 解压 + 校验 + 注册到 SQLite
│   └── ipc.handlers.ts       # marketplace:* IPC handlers
├── storage/migrations/
│   └── index.ts              # 修改：008 迁移（installed_packages 表）
resources/
└── marketplace/
    └── catalog.json          # 预填充 catalog（5 个条目）

renderer/src/
├── components/
│   └── marketplace/
│       ├── MarketplaceView.tsx    # 浏览 + 搜索
│       ├── ItemCard.tsx           # 单个条目卡片
│       └── ItemDetail.tsx         # 详情 + 安装按钮
└── stores/
    └── marketplace.store.ts       # Zustand store
```

---

## Task 1: Marketplace 类型 + Catalog 格式

**文件：**
- 创建: `electron/src/main/marketplace/types.ts`
- 创建: `resources/marketplace/catalog.json`
- 测试: `electron/tests/marketplace/types.test.ts`

- [ ] **Step 1: 创建 `marketplace/types.ts`**

```typescript
// electron/src/main/marketplace/types.ts

export type ItemType = 'agent' | 'mcp' | 'skill';
export type VerificationStatus = 'unverified' | 'community' | 'verified' | 'official';

export interface MarketplaceItem {
  id: string;
  type: ItemType;
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  readme: string;
  tags: string[];
  category: string;
  iconEmoji: string;
  verificationStatus: VerificationStatus;
  downloadUrl: string;
  checksum: string;
  sizeBytes: number;
  installCount: number;
}

export interface Catalog {
  version: string;
  updatedAt: string;
  items: MarketplaceItem[];
}
```

- [ ] **Step 2: 创建预填充 `catalog.json`**

```json
{
  "version": "1.0",
  "updatedAt": "2026-07-28T00:00:00Z",
  "items": [
    {
      "id": "agent-pm-agent",
      "type": "agent",
      "slug": "pm-agent",
      "name": "项目经理",
      "version": "1.0.0",
      "author": "AgentPlatform",
      "description": "协调全流程：需求→设计→编码。调度子 agent 完成任务。",
      "readme": "# 项目经理\n\n主 agent，能调度 requirement-analyst 和 coder。",
      "tags": ["project-management", "orchestration"],
      "category": "development",
      "iconEmoji": "👔",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    },
    {
      "id": "agent-requirement-analyst",
      "type": "agent",
      "slug": "requirement-analyst",
      "name": "需求讨论师",
      "version": "1.0.0",
      "author": "AgentPlatform",
      "description": "帮用户梳理需求、产出结构化需求文档。",
      "readme": "# 需求讨论师\n\n使用 Anthropic Claude，输出 Markdown 需求文档。",
      "tags": ["requirement", "document"],
      "category": "development",
      "iconEmoji": "📝",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 1024,
      "installCount": 0
    },
    {
      "id": "agent-coder",
      "type": "agent",
      "slug": "coder",
      "name": "程序员",
      "version": "1.0.0",
      "author": "AgentPlatform",
      "description": "根据需求实现代码，支持多种编程语言。",
      "readme": "# 程序员\n\n使用 OpenAI GPT-4o，编写代码并写入 workspace。",
      "tags": ["coding", "development"],
      "category": "development",
      "iconEmoji": "💻",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 1024,
      "installCount": 0
    },
    {
      "id": "mcp-filesystem",
      "type": "mcp",
      "slug": "filesystem",
      "name": "Filesystem MCP",
      "version": "1.0.0",
      "author": "@modelcontextprotocol",
      "description": "文件系统访问 MCP server（读写文件、列目录）。",
      "readme": "# Filesystem MCP\n\n标准 MCP filesystem server。",
      "tags": ["filesystem", "tools"],
      "category": "development",
      "iconEmoji": "📁",
      "verificationStatus": "verified",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 4096,
      "installCount": 0
    },
    {
      "id": "skill-code-review",
      "type": "skill",
      "slug": "code-review-workflow",
      "name": "代码审查工作流",
      "version": "1.0.0",
      "author": "AgentPlatform",
      "description": "执行标准的代码审查流程。审查代码风格、安全问题、测试覆盖率。",
      "readme": "# 代码审查工作流\n\n## 步骤\n1. 读取代码文件\n2. 检查安全漏洞\n3. 输出审查报告",
      "tags": ["code-review", "security"],
      "category": "development",
      "iconEmoji": "🔍",
      "verificationStatus": "community",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 3072,
      "installCount": 0
    }
  ]
}
```

- [ ] **Step 3: 写测试 + 提交**

```typescript
// electron/tests/marketplace/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Catalog, MarketplaceItem, ItemType } from '../../src/main/marketplace/types';

describe('marketplace/types', () => {
  it('Catalog 包含 items 数组', () => {
    const catalog: Catalog = { version: '1.0', updatedAt: '2026-01-01', items: [] };
    expect(catalog.items).toEqual([]);
  });

  it('MarketplaceItem 含所有字段', () => {
    const item: MarketplaceItem = {
      id: 'test', type: 'agent', slug: 'test', name: '测试', version: '1.0.0',
      author: 'test', description: 'desc', readme: '# Test', tags: [],
      category: 'dev', iconEmoji: '🤖', verificationStatus: 'official',
      downloadUrl: 'https://example.com/pkg.tar.gz', checksum: 'abc123',
      sizeBytes: 100, installCount: 0,
    };
    expect(item.type).toBe('agent');
  });
});
```

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/marketplace/types.test.ts
git add electron/src/main/marketplace/types.ts resources/marketplace/catalog.json \
        electron/tests/marketplace/types.test.ts
git commit -m "feat(marketplace): 类型定义 + 预填充 catalog"
```

---

## Task 2: Marketplace 客户端（fetch + parse）

**文件：**
- 创建: `electron/src/main/marketplace/client.ts`
- 测试: `electron/tests/marketplace/client.test.ts`

- [ ] **Step 1: 实现 `client.ts`**

```typescript
// electron/src/main/marketplace/client.ts
import { logger } from '../logger';
import type { Catalog, MarketplaceItem } from './types';

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/user/repo/main/resources/marketplace/catalog.json';
const LOCAL_CATALOG_PATH = require('path').join(__dirname, '..', '..', '..', 'resources', 'marketplace', 'catalog.json');

/** 获取 catalog（优先远程，失败回退本地） */
export async function fetchCatalog(catalogUrl?: string): Promise<Catalog> {
  const url = catalogUrl ?? DEFAULT_CATALOG_URL;

  // 尝试远程
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const catalog = (await response.json()) as Catalog;
      logger.info('Marketplace catalog 已加载（远程）', { items: catalog.items.length });
      return catalog;
    }
  } catch (err) {
    logger.warn('远程 catalog 获取失败，使用本地', { error: (err as Error).message });
  }

  // 回退到本地
  const fs = require('fs') as typeof import('fs');
  const local = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf-8')) as Catalog;
  logger.info('Marketplace catalog 已加载（本地）', { items: local.items.length });
  return local;
}

/** 搜索 catalog */
export function searchItems(catalog: Catalog, query: string, type?: string): MarketplaceItem[] {
  const q = query.toLowerCase().trim();
  return catalog.items.filter((item) => {
    if (type && item.type !== type) return false;
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.slug.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** 按 category 分组 */
export function groupByCategory(items: MarketplaceItem[]): Map<string, MarketplaceItem[]> {
  const groups = new Map<string, MarketplaceItem[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return groups;
}
```

- [ ] **Step 2: 写测试（mock fetch）**

```typescript
// 测试 fetchCatalog 远程成功
// 测试 fetchCatalog 远程失败 → 回退本地
// 测试 searchItems 按名称/描述/tag 搜索
// 测试 groupByCategory 正确分组
```

- [ ] **Step 3: 提交**

```bash
git add electron/src/main/marketplace/client.ts electron/tests/marketplace/client.test.ts
git commit -m "feat(marketplace): catalog fetch + 搜索 + 分组"
```

---

## Task 3: 包安装器（download + checksum + extract + register）

**文件：**
- 创建: `electron/src/main/marketplace/installer.ts`
- 修改: `electron/src/main/storage/migrations/index.ts`（008 迁移）
- 测试: `electron/tests/marketplace/installer.test.ts`

- [ ] **Step 1: 添加 008 迁移**

```typescript
{
  version: 8,
  sql: `
CREATE TABLE IF NOT EXISTS installed_packages (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT NOT NULL
);
`.trim(),
},
```

- [ ] **Step 2: 实现 `installer.ts`**

```typescript
// electron/src/main/marketplace/installer.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { resolveUserDataDir } from '../paths';
import type { MarketplaceItem } from './types';

/** 安装一个 marketplace 包 */
export async function installPackage(
  item: MarketplaceItem,
  workspaceId?: string,
): Promise<{ cachePath: string }> {
  const cacheBase = path.join(resolveUserDataDir(), 'cache', item.type + 's');
  const cachePath = path.join(cacheBase, item.slug, item.version);

  // 如果已安装，跳过
  if (fs.existsSync(path.join(cachePath, '.installed'))) {
    logger.info('包已安装，跳过', { slug: item.slug });
    return { cachePath };
  }

  fs.mkdirSync(cachePath, { recursive: true });

  // 下载（如果有 downloadUrl）
  if (item.downloadUrl) {
    const archivePath = path.join(cachePath, 'package.tar.gz');
    await downloadFile(item.downloadUrl, archivePath);

    // 校验 checksum
    if (item.checksum) {
      const actualChecksum = await computeChecksum(archivePath);
      if (actualChecksum !== item.checksum) {
        fs.rmSync(cachePath, { recursive: true, force: true });
        throw new Error(`Checksum 不匹配: 期望 ${item.checksum}, 实际 ${actualChecksum}`);
      }
    }

    // 解压
    await extractTarGz(archivePath, cachePath);
    fs.unlinkSync(archivePath); // 删除归档
  } else {
    // 无 downloadUrl：从 catalog 的 readme + 内联内容创建（builtin items）
    createInlinePackage(item, cachePath);
  }

  // 标记已安装
  fs.writeFileSync(path.join(cachePath, '.installed'), new Date().toISOString());

  // 注册到 SQLite
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, item.id, item.type, item.slug, item.version, cachePath, item.checksum);

  logger.info('包已安装', { slug: item.slug, type: item.type, cachePath });
  return { cachePath };
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(dest));
}

async function computeChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  // 使用系统 tar 命令（简单可靠）
  const { exec } = require('node:child_process') as { exec: typeof import('node:child_process').exec };
  return new Promise((resolve, reject) => {
    exec(`tar -xzf "${archivePath}" -C "${destDir}"`, (err) => {
      if (err) reject(new Error(`解压失败: ${err.message}`));
      else resolve();
    });
  });
}

/** 内联包：从 catalog item 直接创建文件（无下载） */
function createInlinePackage(item: MarketplaceItem, cachePath: string): void {
  if (item.type === 'agent') {
    // 从 catalog readme + metadata 生成 YAML manifest
    const yaml = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: ${item.name}
  slug: ${item.slug}
  version: ${item.version}
  description: ${item.description}
  iconEmoji: "${item.iconEmoji}"
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "${item.readme}"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools: []
`;
    fs.writeFileSync(path.join(cachePath, 'manifest.yaml'), yaml);
  } else if (item.type === 'skill') {
    // 生成 SKILL.md
    const skillMd = `---
name: ${item.slug}
description: ${item.description}
version: ${item.version}
---

${item.readme}
`;
    fs.writeFileSync(path.join(cachePath, 'SKILL.md'), skillMd);
  } else if (item.type === 'mcp') {
    // 生成 package.json stub
    const pkg = {
      name: item.slug,
      version: item.version,
      description: item.description,
    };
    fs.writeFileSync(path.join(cachePath, 'package.json'), JSON.stringify(pkg, null, 2));
  }
}

/** 列出已安装的包 */
export function listInstalled(): Array<{
  id: string; itemId: string; itemType: string; slug: string;
  version: string; cachePath: string; installedAt: string;
}> {
  const db = getDb();
  return db.prepare('SELECT * FROM installed_packages ORDER BY installed_at DESC').all() as Array<{
    id: string; item_id: string; item_type: string; slug: string;
    version: string; cache_path: string; installed_at: string;
  }>;
}

/** 卸载包 */
export function uninstallPackage(itemId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT cache_path FROM installed_packages WHERE item_id = ?').get(itemId) as
    | { cache_path: string }
    | undefined;
  if (!row) return;
  fs.rmSync(row.cache_path, { recursive: true, force: true });
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(itemId);
  logger.info('包已卸载', { itemId });
}
```

- [ ] **Step 3: 写测试 + 提交**

```bash
git add electron/src/main/marketplace/installer.ts electron/src/main/storage/migrations/index.ts \
        electron/tests/marketplace/installer.test.ts
git commit -m "feat(marketplace): 包安装器（download + checksum + extract + register）"
```

---

## Task 4: Marketplace IPC handlers

**文件：**
- 创建: `electron/src/main/marketplace/ipc.handlers.ts`
- 修改: `electron/src/main/ipc/index.ts`, `preload/index.ts`, `renderer/src/ipc/types.ts`

- [ ] **Step 1: 实现 IPC handlers**

```typescript
// electron/src/main/marketplace/ipc.handlers.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { fetchCatalog, searchItems } from './client';
import { installPackage, listInstalled, uninstallPackage } from './installer';
import type { MarketplaceItem } from './types';

export function registerMarketplaceHandlers(): void {
  ipcMain.handle('marketplace:getCatalog', async (_evt, catalogUrl?: string) => {
    return fetchCatalog(catalogUrl);
  });

  ipcMain.handle('marketplace:search', async (_evt, query: string, type?: string) => {
    const catalog = await fetchCatalog();
    return searchItems(catalog, query, type);
  });

  ipcMain.handle('marketplace:install', async (_evt, item: MarketplaceItem) => {
    return installPackage(item);
  });

  ipcMain.handle('marketplace:listInstalled', async () => {
    return listInstalled();
  });

  ipcMain.handle('marketplace:uninstall', async (_evt, itemId: string) => {
    uninstallPackage(itemId);
  });

  logger.info('Marketplace IPC handlers 已注册');
}
```

更新 `ipc/index.ts`、`preload/index.ts`、`renderer/src/ipc/types.ts` 添加 `marketplace` 命名空间。

- [ ] **Step 2: 提交**

```bash
git add -A
git commit -m "feat(marketplace): IPC handlers + preload + types"
```

---

## Task 5: Marketplace UI

**文件：**
- 创建: `renderer/src/stores/marketplace.store.ts`
- 创建: `renderer/src/components/marketplace/MarketplaceView.tsx`
- 创建: `renderer/src/components/marketplace/ItemCard.tsx`
- 创建: `renderer/src/components/marketplace/ItemDetail.tsx`
- 修改: `renderer/src/components/layout/MiddlePanel.tsx`（marketplace 视图）

- [ ] **Step 1: 实现 store**

```typescript
// renderer/src/stores/marketplace.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { MarketplaceItem } from '../ipc/types';

interface MarketplaceState {
  items: MarketplaceItem[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filterType: string | null;
  selectedItemId: string | null;
  installingSlug: string | null;

  load: () => Promise<void>;
  search: (query: string) => Promise<void>;
  filter: (type: string | null) => void;
  select: (itemId: string | null) => void;
  install: (item: MarketplaceItem) => Promise<void>;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  searchQuery: '',
  filterType: null,
  selectedItemId: null,
  installingSlug: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const catalog = await ipc.marketplace.getCatalog();
      set({ items: catalog.items, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  search: async (query) => {
    set({ searchQuery: query, loading: true });
    const items = await ipc.marketplace.search(query, get().filterType ?? undefined);
    set({ items, loading: false });
  },

  filter: (type) => {
    set({ filterType: type });
    void get().search(get().searchQuery);
  },

  select: (itemId) => set({ selectedItemId: itemId }),

  install: async (item) => {
    set({ installingSlug: item.slug });
    try {
      await ipc.marketplace.install(item);
      set({ installingSlug: null });
    } catch (err) {
      set({ installingSlug: null, error: (err as Error).message });
    }
  },
}));
```

- [ ] **Step 2: 实现 UI 组件**

`ItemCard.tsx` — 卡片：icon + name + description + verification badge + install button
`ItemDetail.tsx` — 详情面板：readme（Markdown 渲染）+ 版本 + 作者 + 安装按钮
`MarketplaceView.tsx` — 布局：搜索栏 + 类型筛选 tabs + 卡片网格 + 详情侧栏

在 MiddlePanel 的 `activeView === 'marketplace'` 分支渲染 `<MarketplaceView />`。

- [ ] **Step 3: 提交**

```bash
git add renderer/src/stores/marketplace.store.ts renderer/src/components/marketplace/ \
        renderer/src/components/layout/MiddlePanel.tsx
git commit -m "feat(marketplace): 浏览/搜索/安装 UI"
```

---

## Task 6-10: 大纲

### Task 6: 安装后自动注册

**修改：** `marketplace/installer.ts`

**要点：**
- Agent 安装后自动 `parseAgentManifest` + `saveAgentDefinition`
- Skill 安装后自动 `skillRegistry.register(cachePath)` + 写 `skill_definitions` 表
- MCP 安装后自动 `registerMcpDefinition`（从 package.json 读 command/args）

### Task 7: electron-builder 打包最终化

**修改：** `electron/package.json` 的 `build` 配置

**要点：**
- 确认 extraResources 包含 `resources/marketplace/catalog.json` + `resources/agents/`
- 确认 `resources/conduit/static-*` pattern 正确（M0 已修）
- 添加 `.dmg` 图标（512x512 PNG，已在 M0 添加 placeholder）
- 测试 `pnpm pack` 成功产出 unpacked app
- 测试 `pnpm dist` 成功产出 installer（Linux AppImage）

### Task 8: README + 发布文档

**修改：** `README.md` + 创建 `docs/dev/release.md`

**要点：**
- README 更新：v1 GA 标志 + 完整功能列表 + 截图占位
- `docs/dev/release.md`：打包步骤 + 发布 checklist + 版本号管理

### Task 9: v1 GA 验收

**验证以下端到端流程：**
1. 安装应用 → onboarding → 注册账号 → 主界面
2. 创建 workspace → 添加 pm-agent → 自动跟随 sub agents
3. 在 IM @pm-agent → pm-agent dispatch 子 agent → task_reply
4. 切换到 files → 看 agent 写的文件
5. marketplace → 浏览 → 安装一个 skill → agent 能 loadSkill
6. settings → 查看 audit log → 有工具调用记录
7. settings → 配置 git policy → 验证 commit 规则

### Task 10: 清理 + 合并

- 清理 `.superpowers/sdd/` 临时文件
- 合并到 main
- 打 tag `v1.0.0`

---

## 自审

### Spec 覆盖

| Spec M4 要求 | 对应 Task |
|---|---|
| Marketplace REST API | T1-T4（静态 catalog 代替独立服务器，v1 简化） |
| 浏览/搜索 UI | T5 |
| 安装 stdio MCP / Skill / Agent 包 | T3, T6 |
| 依赖检查 + 自动安装 | T6 |
| verification status 显示 | T5 |
| 内置公开 marketplace | T1（catalog.json） |
| 打包发布 | T7 |
| macOS 代码签名 | T7（placeholder，正式签名需 Apple Developer 账号） |

### 验收标准

- ✅ 用户能浏览 marketplace catalog（至少 5 个条目）
- ✅ 能搜索 + 按类型筛选
- ✅ 能安装 agent / skill / mcp 包
- ✅ 安装后包可在 agent runtime 中使用
- ✅ 应用能打包成 Linux AppImage
- ✅ README 文档完整
