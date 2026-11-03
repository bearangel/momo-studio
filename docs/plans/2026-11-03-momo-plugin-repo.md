# momo-plugin 独立仓库 + codegraph 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建独立公开仓库 `../momo-plugin`，把 codegraph 插件本体及其引擎测试迁入，momo-studio 侧删除插件目录并完成测试夹具化收尾。

**Architecture:** 三段式——① 新仓骨架（sibling `../momo-plugin`，`plugins/<name>/` 命名空间）+ codegraph 8 个跟踪文件与本机二进制整体复制；② 随迁测试改造（engine-harness 延迟动态 import 宿主 + dev 安装探针，均 skipIf 容忍宿主/引擎缺失）；③ momo-studio 侧 `git rm` 插件目录、agent-sync 夹具化、注释与 .gitignore 清理。

**Tech Stack:** git / gh CLI / vitest 1.6.1（与宿主同版本）/ Node 24 / pnpm 9（`npx pnpm@9.0.0`）

**Spec:** `docs/specs/2026-11-03-momo-plugin-repo-design.md`（计划与 spec 冲突时以 spec 为准；执行者应同时持有两份）

## Global Constraints

- **Node 24**：每个 shell 会话先 `nvm use 24`（`.nvmrc` 已钉）；pnpm 一律 `npx pnpm@9.0.0`
- **⚠️ momo-studio 内所有 `git commit` 必须 pathspec 限定提交文件**（如 `git commit -m "..." -- <路径列表>`）——staging 区长期存在 office-pro 任务预暂存的改动（smithery.ts / marketplace.ts 删除等），裸 commit 会卷入他人工作。**每次提交后必须 `git show --stat HEAD` 核对文件清单只含本任务文件**。设计阶段已发生过一次误卷入事故（已修复），此约束零容忍
- **office-pro 相关一律不动**：`docs/plans/2026-11-03-office-pro-plugin.md`、staging 区预暂存的删除、`plugins/office-pro*`（尚不存在，勿创建）
- 注释/文档一律中文；标识符英文；Conventional Commits（`feat:` / `test:` / `refactor:` / `docs:` / `chore:`）；**不动版本号**
- momo-studio 测试命令范式（AGENTS.md 陷阱表）：DB 重度目录（tests/plugin、tests/resource）单跑加 `--pool=forks`；根级全量用裸 `npx pnpm@9.0.0 test`（CLI 加 --pool 会破坏 projects 池配置，禁用）
- vitest 非正常退出（exit 139/137、Segmentation fault）后必须执行 `ps -axo pid,ppid,command | grep vitest | grep -v grep` 清理 PPID=1 孤儿 worker
- 新仓绝对路径：`/Users/stbearangel/dev/AiProject/momo-plugin`（下文命令在 momo-studio 根执行时用 `../momo-plugin` 相对路径，效果等价）
- 迁移期间**禁止 push momo-studio**（本计划在 momo-studio 只产生本地 commit）

## Review Focus

五类「spec 隐含但易咬人」的失效模式，每类由归属任务的验证步骤锁定：

1. **staging 区污染**（office-pro 预暂存改动被裸 commit 卷入）→ 每个 momo-studio 提交步骤都显式 pathspec + 提交后 `git show --stat` 核对 → Task 4 Step 8/Task 4 收尾核对
2. **skipIf 判定前静态 import 宿主模块**（宿主缺失时模块解析失败 → 整文件红而非 skip）→ 所有宿主 import 一律 `beforeAll` 内动态 `import()`，hooks 全部内移到被 skip 守卫的 describe → Task 2 Step 4 负例（`MOMO_STUDIO_ROOT=/nonexistent` 必须 skip 绿）
3. **Vite server fs 守卫拒绝 sibling 仓文件**（动态 import 宿主 .ts 报 fs.allow 出界）→ 新仓 vitest config `server.fs.allow: ['..']` → Task 2 Step 3 正例跑通即覆盖
4. **引擎二进制完整性丢失**（cp 丢 exec bit / 目录残缺 → probe 与 harness 起不来）→ 复制后 `test -x` + Task 3 探针断言 `X_OK` → Task 1 Step 3 / Task 3 Step 3
5. **git rm 时序颠倒**（momo-studio 删目录早于新仓就位 → 本地 dev 安装 vendor probe 断裂）→ Task 4 严格排在 Task 1 后；Task 4 内先夹具化、再删目录、删后复跑测试证明独立性 → Task 4 Step 4-6

---

### Task 1: 新仓骨架 + codegraph 本体复制

**Files:**
- Create: `../momo-plugin/` 全部骨架（`.gitignore`、`README.md`、`LICENSE`、`LICENSE-COMMERCIAL.md`、`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vitest.config.ts`）
- Create: `../momo-plugin/plugins/codegraph/`（自 momo-studio `plugins/codegraph/` 整目录复制，含 gitignored 的 engine/ 与 vendor/）
- Test: 无独立测试文件（本任务交付物是文件就位 + exec bit 验证；行为测试在 Task 2/3）

**Interfaces:**
- Produces: 目录布局 `../momo-plugin/plugins/codegraph/`（Task 2/3 的 `PLUGIN_ROOT` 消费）；git 仓库（main 分支，Task 5 推送）
- 不修改 momo-studio 任何文件（复制非移动——momo-studio 侧删除在 Task 4）

- [ ] **Step 1: 复制插件目录（含本机二进制）**

在 momo-studio 根执行：

```bash
mkdir -p ../momo-plugin/plugins
cp -R plugins/codegraph ../momo-plugin/plugins/codegraph
```

- [ ] **Step 2: 验证复制完整性（Review Focus 4）**

```bash
test -x ../momo-plugin/plugins/codegraph/engine/bin/codegraph && echo "exec-ok"
ls ../momo-plugin/plugins/codegraph/vendor/codegraph-darwin-arm64.tar.gz
diff <(git ls-files plugins/codegraph | sort) <(cd ../momo-plugin/plugins/codegraph && find . -type f | sed 's|^\./||' | grep -v -E '^(engine|vendor)/' | sort) && echo "tracked-8-ok"
```

Expected: 三行输出 `exec-ok` / tarball 路径 / `tracked-8-ok`（8 个跟踪文件 + engine/vendor 本机产物全部就位）

- [ ] **Step 3: 写骨架文件**

`../momo-plugin/.gitignore`：

```gitignore
node_modules/
plugins/codegraph/engine/
plugins/codegraph/vendor/
```

`../momo-plugin/package.json`：

```json
{
  "name": "momo-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "Momo Studio 插件集中研发仓库（宿主：momo-studio）",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "vitest": "^1.6.1"
  }
}
```

`../momo-plugin/vitest.config.ts`：

```typescript
// 新仓最小 vitest 配置（spec §3.2）：仅跑 tests/；server.fs.allow 放开父目录
// ——engine-harness / dev-install-probe 经动态 import 引用 sibling 宿主的
// .ts 源码，Vite 默认 fs 守卫只允许本仓根，须显式放开（Review Focus 3）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { fs: { allow: ['..'] } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
```

`../momo-plugin/tsconfig.json`：

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["tests", "vitest.config.ts"]
}
```

`../momo-plugin/README.md`：

````markdown
# momo-plugin

Momo Studio 插件集中研发仓库。宿主应用 [momo-studio](../momo-studio) 的插件本体在此研发；插件系统（安装 / 启停 / hooks / 面板协议）由宿主提供，本仓只放插件。

设计依据：momo-studio 仓库 `docs/specs/2026-11-03-momo-plugin-repo-design.md`。

## 结构

```
plugins/<插件id>/     # 每个插件一个目录（momo-plugin.json 所在根）
tests/               # 跨仓测试（依赖 sibling 宿主，见下）
```

当前插件：`codegraph`（代码图谱，v2.0.1）。

## 开发工作流

momo-studio 设置 → 插件 → 开发目录安装，指向本仓的插件目录（如
`/Users/stbearangel/dev/AiProject/momo-plugin/plugins/codegraph`）。dev 安装不拷贝、
直读源码：改码后在宿主里执行「重载插件」即生效。发布走宿主的 momo-hub 发布链
（dev 源版本回写会直接改本仓 manifest 的 version 字段）。

## 本机产物（不入库）

`plugins/codegraph/engine/`（解包引擎，~283MB）与 `plugins/codegraph/vendor/`
（平台 tarball，~56MB）已 gitignore。新机器获取方式：从原环境拷贝，或依赖插件
运行时自身的引擎下载机制（engineVersion 1.6.2）。引擎缺失时 tests/ 全部 skip，
不影响跑绿。

## 测试

```bash
nvm use 24                       # 宿主 native 依赖（better-sqlite3）ABI 一致性
npx pnpm@9.0.0 install           # 装 vitest
npx pnpm@9.0.0 test              # 引擎在位则真跑；缺失则 skip
```

前提与耦合面：

- 需要 sibling 目录有 momo-studio checkout 且已 `pnpm install`（测试经动态
  import 引用宿主内部模块 `db` / `host-manager` / `installer` 等，其 bare 依赖
  经宿主自身 node_modules 解析）
- 宿主位置默认 `../momo-studio`，可用环境变量 `MOMO_STUDIO_ROOT` 覆盖
- **耦合警告**：宿主重构改动上述内部模块 API 时，本仓测试需同步修改——这是
  有意保留的耦合面（spec D2），README 即契约
````

- [ ] **Step 4: LICENSE 复制 + git init + 首次提交**

```bash
cp LICENSE ../momo-plugin/LICENSE && cp LICENSE-COMMERCIAL.md ../momo-plugin/LICENSE-COMMERCIAL.md
cd ../momo-plugin && git init -b main && git add -A && git commit -m "feat: 初始化 momo-plugin——codegraph 插件自 momo-studio 迁入"
git ls-files | sort
```

Expected: `git ls-files` 共 **15 个文件**：7 个骨架文件（`.gitignore`、`LICENSE`、`LICENSE-COMMERCIAL.md`、`README.md`、`package.json`、`tsconfig.json`、`vitest.config.ts`）+ `plugins/codegraph/` 下 8 文件（`agents/code-navigator.yaml`、`bin/boot.js`、`mcp/mcp.json`、`momo-plugin.json`、`panel/index.html`、`panel/panel.json`、`service/index.js`、`skills/codegraph-usage/SKILL.md`）。**engine/ 与 vendor/ 不得出现**（pnpm-lock.yaml 此时还没有——Step 5 安装后产生，随 Task 2 提交）。

- [ ] **Step 5: 安装依赖（为 Task 2 备好环境）**

```bash
cd ../momo-plugin && nvm use 24 && npx pnpm@9.0.0 install
```

Expected: 安装成功，生成 `pnpm-lock.yaml` 与 `node_modules/`（后者被 .gitignore 排除）

---

### Task 2: engine-harness 随迁改造（延迟动态 import）

**Files:**
- Create: `../momo-plugin/tests/codegraph-engine-harness.test.ts`（自 `electron/tests/plugin/codegraph-engine-harness.test.ts` 改造）
- Modify: 无（momo-studio 侧原文件删除在 Task 4）

**Interfaces:**
- Consumes: Task 1 的 `plugins/codegraph/` 目录与 vitest 环境；sibling 宿主 `MOMO_STUDIO_ROOT`（默认 `../momo-studio`）
- Produces: 可跑绿的 harness 测试（Task 5 §6-2 验证消费）；宿主模块延迟加载范式（Task 3 探针复用同款 beforeAll 动态 import 结构）

- [ ] **Step 1: 写改造版测试文件**

`../momo-plugin/tests/codegraph-engine-harness.test.ts` 完整内容：

```typescript
// tests/codegraph-engine-harness.test.ts（momo-plugin）
//
// 自 momo-studio electron/tests/plugin/codegraph-engine-harness.test.ts 随迁
// （spec 2026-11-03 §3.2）。原语义保留：真引擎双 ws 双语言（TS/Java）各自经
// getOrStartMcp 拉起 codegraph 实例，断言各自命中各自语言的符号——Java 命中是
// dap-e_server 惨案的回归锁。
//
// 跨仓改造（本文件与原版的全部差异）：
//  1. 宿主模块一律 beforeAll 内动态 import（静态 import 会在 skipIf 判定前做
//     模块解析——宿主缺失时整文件红而非 skip，spec §3.2 硬性要求）
//  2. skipIf 条件扩为：宿主可达（package.json + node_modules 在位）且引擎在位
//  3. 宿主类型改为内联最小形状（零 TS 耦合——宿主 refactor 只需同步本文件的
//     内联 interface，README 耦合警告即指此处）
//  4. tmpRoot 惰性创建（skip 时不留孤儿临时目录）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

// ── 可达性判定（先于任何宿主 import）──────────────────────────────────────
const HOST_ROOT = path.resolve(
  process.env.MOMO_STUDIO_ROOT ?? path.join(__dirname, '..', '..', 'momo-studio'),
);
const HOST_READY =
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'package.json')) &&
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'node_modules'));
const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'codegraph');
const ENGINE_BIN = path.join(PLUGIN_ROOT, 'engine', 'bin', 'codegraph');
const ENGINE_READY = fs.existsSync(ENGINE_BIN);

// ── 宿主模块内联最小形状（零 TS 耦合契约面）───────────────────────────────
interface McpClient {
  callTool(name: string, args: unknown): Promise<unknown>;
}
interface DbHandle {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}
interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}
interface HostModules {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  setKeychainImpl(impl: KeychainImpl): void;
  getOrStartMcp(wsId: string, cfg: unknown): Promise<McpClient>;
  stopAllMcpForWorkspace(wsId: string): void;
}
// beforeAll 内赋值；skipIf 守卫保证 hooks 只在 READY 时执行——hook 内非空断言安全
let host: HostModules | null = null;

let tmpRoot = '';
const vault = new Map<string, string>();

function wsDir(name: string): string {
  return path.join(tmpRoot, name);
}

function seedWs(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wsDir(name), rel)), { recursive: true });
    fs.writeFileSync(path.join(wsDir(name), rel), content);
  }
}

// Java 样例：dap-e_server 同款形态（InitGuideApplicationServiceImpl + 调用方）
const JAVA_FILES = {
  'src/main/java/com/x/InitGuideApplicationServiceImpl.java': `package com.x;

public class InitGuideApplicationServiceImpl {
    public String getOverview(boolean refresh) {
        return "overview:" + refresh;
    }

    public String getStatus() {
        return getOverview(false);
    }
}
`,
  'src/main/java/com/x/InitGuideController.java': `package com.x;

public class InitGuideController {
    private final InitGuideApplicationServiceImpl initGuideApplicationService = new InitGuideApplicationServiceImpl();

    public String overview() {
        return initGuideApplicationService.getOverview(true);
    }
}
`,
};

const TS_FILES = {
  'src/tasks.ts': `export function transitionTaskStatus(id: string, next: string): string {
  return id + ':' + next;
}
`,
  'src/flow.ts': `import { transitionTaskStatus } from './tasks';

export function completeTask(id: string): string {
  return transitionTaskStatus(id, 'done');
}
`,
};

const MANIFEST = {
  id: 'cg',
  name: 'cg',
  version: '2.0.0',
  components: { mcp: './mcp/mcp.json' },
};

function mcpConfigFor(): { id: string; name: string; command: string; args: string[]; env: Record<string, string>; transport: string; source: string; pluginId: string } {
  return {
    id: 'plugin-cg-codegraph',
    name: 'codegraph',
    command: 'node',
    args: [
      '${pluginRoot}/bin/boot.js',
      '--engine', '${engineBin}',
      '--root', '${config.workspaceRoot}',
    ],
    env: { CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: '.momo-codegraph' },
    transport: 'stdio',
    source: 'plugin',
    pluginId: 'cg',
  };
}

function seedPlugin(): void {
  const rec = {
    id: 'cg',
    version: '2.0.0',
    manifestJson: JSON.stringify(MANIFEST),
    sourcePath: PLUGIN_ROOT,
  };
  host!
    .getDb()
    .prepare(
      `INSERT OR REPLACE INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, ?, ?, 'active', 'dev', ?, 'x')`,
    )
    .run(rec.id, rec.version, rec.manifestJson, rec.sourcePath);
}

describe.skipIf(!HOST_READY || !ENGINE_READY)('真引擎双 ws 双语言 harness（L2 锚点）', () => {
  beforeAll(async () => {
    const dbUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'db.ts')).href;
    const mcpUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'mcp', 'host-manager.ts')).href;
    const keychainUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'keychain.ts')).href;
    const [db, mcp, keychain] = await Promise.all([
      import(dbUrl),
      import(mcpUrl),
      import(keychainUrl),
    ]) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      { getOrStartMcp(wsId: string, cfg: unknown): Promise<McpClient>; stopAllMcpForWorkspace(wsId: string): void },
      { setKeychainImpl(impl: KeychainImpl): void },
    ];
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      setKeychainImpl: keychain.setKeychainImpl,
      getOrStartMcp: mcp.getOrStartMcp,
      stopAllMcpForWorkspace: mcp.stopAllMcpForWorkspace,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgharness-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.setKeychainImpl({
      setSecret: async (k, v) => void vault.set(k, v),
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => void vault.delete(k),
    });
    host!.runMigrations();
  });

  afterEach(() => {
    host!.stopAllMcpForWorkspace('ws-a');
    host!.stopAllMcpForWorkspace('ws-b');
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  afterAll(() => {
    vault.clear();
  });

  it('TS 工作空间命中 TS 符号；Java 工作空间命中 Java 符号（惨案回归锁）', async () => {
    seedWs('ws-a', TS_FILES);
    seedWs('ws-b', JAVA_FILES);
    seedPlugin();
    host!
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id)
         VALUES ('ws-a', 'A', ?, '@o'), ('ws-b', 'B', ?, '@o')`,
      )
      .run(wsDir('ws-a'), wsDir('ws-b'));
    // scoped activation：行缺失=停用——补两 ws 启用（ws 行须先建，FK 约束）
    host!
      .getDb()
      .prepare(
        `INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled)
         VALUES ('ws-a', 'cg', 1), ('ws-b', 'cg', 1)`,
      )
      .run();

    const a = await host!.getOrStartMcp('ws-a', mcpConfigFor());
    const b = await host!.getOrStartMcp('ws-b', mcpConfigFor());

    // 引擎首启建图需要时间——轮询 explore 直到命中或超时（大仓真实语义）
    const exploreUntil = async (client: McpClient, symbol: string, ms: number): Promise<string> => {
      const deadline = Date.now() + ms;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const r = await client.callTool('codegraph_explore', { query: symbol });
          last = JSON.stringify(r);
          if (!/未收录|not found|no match/i.test(last)) return last;
        } catch (err) {
          last = String(err);
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
      return last;
    };

    const tsHit = await exploreUntil(a, 'transitionTaskStatus', 90_000);
    expect(tsHit).toContain('tasks.ts');
    expect(tsHit).not.toContain('InitGuide');

    const javaHit = await exploreUntil(b, 'InitGuideApplicationServiceImpl', 90_000);
    expect(javaHit).toContain('InitGuideApplicationServiceImpl.java');
    expect(javaHit).not.toContain('tasks.ts');

    // 索引数据落点：各自项目根下 .momo-codegraph/（与 CODEGRAPH_DIR 一致）
    expect(fs.existsSync(path.join(wsDir('ws-a'), '.momo-codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir('ws-b'), '.momo-codegraph'))).toBe(true);
  }, 240_000);
});
```

- [ ] **Step 2: 正例跑通（引擎 + 宿主均在位）**

Run: `cd ../momo-plugin && nvm use 24 && npx pnpm@9.0.0 vitest run`
Expected: 1 个测试 PASS（真引擎双 ws，最长 4 分钟）。若报 `server.fs.allow` / `EACCES` 类错误 → 检查 vitest.config.ts 的 `server.fs.allow: ['..']`（Review Focus 3）；若 import 解析失败 → 确认宿主 `../momo-studio` 存在且 `electron/node_modules` 在位

- [ ] **Step 3: 负例验证（Review Focus 2：宿主缺失必须 skip 而非红）**

Run: `cd ../momo-plugin && MOMO_STUDIO_ROOT=/nonexistent npx pnpm@9.0.0 vitest run`
Expected: 输出含 `skipped`（1 skipped / 0 failed），退出码 0

- [ ] **Step 4: 提交**

```bash
cd ../momo-plugin && git add tests/codegraph-engine-harness.test.ts pnpm-lock.yaml && git commit -m "test: codegraph 引擎 harness 随迁（宿主模块延迟动态 import + skipIf 容忍缺失）"
```

---

### Task 3: dev 安装探针测试（真实插件目录 + 宿主安装链）

**Files:**
- Create: `../momo-plugin/tests/dev-install-probe.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `plugins/codegraph/`（真实 manifest v2.0.1 + vendor probe）；宿主 `installPluginDevDir(dir, currentAppVersion, originWorkspaceId)` / `getPlugin(id)` / db 三件套（经与 Task 2 同款 beforeAll 动态 import）
- Produces: spec §6-3 的确定性验证（dev 注册 + manifest 校验过 + vendor probe 通过）；Task 5 §6 sweep 消费其证据

- [ ] **Step 1: 写测试文件**

`../momo-plugin/tests/dev-install-probe.test.ts` 完整内容：

```typescript
// tests/dev-install-probe.test.ts（momo-plugin）
//
// dev 目录安装探针（spec §6-3）：宿主 installPluginDevDir 真链注册本仓真实
// codegraph 目录——断言 dev 记录落库（不拷贝）、manifest 校验通过、vendor
// probe（engine/bin/codegraph）可执行。这是「拆仓后 dev 工作流仍通」的最小
// 确定性验证（UI 插件卡由同一数据面渲染，不在本探针范围）。
//
// 宿主模块延迟动态 import + skipIf 语义与 codegraph-engine-harness.test.ts
// 同款（spec §3.2）；DB 隔离范式抄自宿主 tests/plugin/install-dev-dir.test.ts
// （AP_USER_DATA_DIR 注入 + runMigrations + 手插 ws 行）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const HOST_ROOT = path.resolve(
  process.env.MOMO_STUDIO_ROOT ?? path.join(__dirname, '..', '..', 'momo-studio'),
);
const HOST_READY =
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'package.json')) &&
  fs.existsSync(path.join(HOST_ROOT, 'electron', 'node_modules'));
const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'codegraph');
const ENGINE_BIN = path.join(PLUGIN_ROOT, 'engine', 'bin', 'codegraph');
const ENGINE_READY = fs.existsSync(ENGINE_BIN);

interface DbHandle {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}
interface PluginRecordLike {
  id: string;
  version: string;
  source: string;
  sourcePath: string;
}
interface ProbeHost {
  runMigrations(): void;
  getDb(): DbHandle;
  closeDb(): void;
  installPluginDevDir(dir: string, currentAppVersion: string, originWorkspaceId: string): PluginRecordLike;
  stopPluginService(id: string): Promise<void>;
  getPlugin(id: string): { version: string } | null;
}
// beforeAll 内赋值；skipIf 守卫保证 hooks 只在 READY 时执行——hook 内非空断言安全
let host: ProbeHost | null = null;

let tmpRoot = '';

describe.skipIf(!HOST_READY || !ENGINE_READY)('dev 目录安装探针（真实插件目录）', () => {
  beforeAll(async () => {
    const dbUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'storage', 'db.ts')).href;
    const installerUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'installer.ts')).href;
    const serviceUrl = pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'service-manager.ts')).href;
    const [db, installer, service] = await Promise.all([
      import(dbUrl),
      import(installerUrl),
      import(serviceUrl),
    ]) as [
      { runMigrations(): void; getDb(): DbHandle; closeDb(): void },
      { installPluginDevDir(dir: string, v: string, ws: string): PluginRecordLike },
      { stopPluginService(id: string): Promise<void> },
    ];
    const registry = await import(
      pathToFileURL(path.join(HOST_ROOT, 'electron', 'src', 'main', 'plugin', 'registry.ts')).href
    ) as { getPlugin(id: string): { version: string } | null };
    host = {
      runMigrations: db.runMigrations,
      getDb: db.getDb,
      closeDb: db.closeDb,
      installPluginDevDir: installer.installPluginDevDir,
      stopPluginService: service.stopPluginService,
      getPlugin: registry.getPlugin,
    };
  });

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-probe-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    host!.runMigrations();
    host!
      .getDb()
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-t', 'T', '/tmp/x', '@o')`,
      )
      .run();
  });

  afterEach(async () => {
    // installPluginDevDir 会拉起插件 service（fire-and-forget）——先停再关库，
    // 防 watcher 线程/句柄泄漏挂住 vitest 退出
    await host!.stopPluginService('codegraph').catch(() => undefined);
    host!.closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('installPluginDevDir 注册真实 codegraph：dev 源不拷贝 + manifest 过校验 + probe 可执行', () => {
    const rec = host!.installPluginDevDir(PLUGIN_ROOT, '2.1.0', 'ws-t');
    // dev 源语义：记录直指源目录（spec 2026-10-15 §7.2）
    expect(rec.source).toBe('dev');
    expect(rec.sourcePath).toBe(PLUGIN_ROOT);
    expect(rec.id).toBe('codegraph');
    // manifest 版本透传（真实 manifest v2.0.1——manifest 校验已在安装链内完成，
    // 走到这里即「校验过」）
    expect(rec.version).toBe('2.0.1');
    expect(host!.getPlugin('codegraph')?.version).toBe('2.0.1');
    // vendor probe 通过的确定性形态：引擎二进制在位且可执行（Review Focus 4）
    fs.accessSync(ENGINE_BIN, fs.constants.X_OK);
  });
});
```

- [ ] **Step 2: 正例跑通**

Run: `cd ../momo-plugin && nvm use 24 && npx pnpm@9.0.0 vitest run`
Expected: 2 个测试全 PASS（harness + probe）或按 skip 条件 skip；probe 单跑可 `npx pnpm@9.0.0 vitest run tests/dev-install-probe.test.ts`

- [ ] **Step 3: 负例验证（宿主缺失 skip）**

Run: `cd ../momo-plugin && MOMO_STUDIO_ROOT=/nonexistent npx pnpm@9.0.0 vitest run`
Expected: 2 skipped / 0 failed，退出码 0

- [ ] **Step 4: 提交**

```bash
cd ../momo-plugin && git add tests/dev-install-probe.test.ts && git commit -m "test: dev 目录安装探针——真实 codegraph 目录经宿主安装链注册"
```

---

### Task 4: momo-studio 侧收尾（删除 + 夹具化 + 清理）

**Files:**
- Modify: `electron/tests/plugin/agent-sync.test.ts`（L208-231 describe 块夹具化）
- Modify: `electron/tests/resource/library.test.ts`（L57-58 注释更新）
- Modify: `.gitignore`（删 codegraph 两行）
- Delete: `plugins/codegraph/`（git rm 跟踪文件 + rm 残留本机目录 + 删空的 plugins/）
- Delete: `electron/tests/plugin/codegraph-engine-harness.test.ts`

**Interfaces:**
- Consumes: Task 1 已完成新仓复制（本任务删除源目录的前提，Review Focus 5）
- Produces: 自包含的宿主测试套件（不依赖仓库内任何插件目录）；spec §6-1 验证面

- [ ] **Step 1: agent-sync 夹具化（先改测试，目录此刻仍在）**

打开 `electron/tests/plugin/agent-sync.test.ts`，将 L207-231 的 describe 块（含注释行 `// v2.0 引擎整合回归锁：插件 agent 注册链...`）整体替换为：

```typescript
// v2.0 引擎整合回归锁：插件 agent 注册链（manifest agents 声明 → 定义落库 source='plugin'）。
// 2026-11-03 夹具化（spec 2026-11-03-momo-plugin §4）：原版 sourcePath 指向仓库
// plugins/codegraph，插件已迁出至独立仓 momo-plugin——改 tmp 夹具 + 内联与真实
// code-navigator 同形的 YAML，断言语义不变。
describe('registerPluginAgents（codegraph v2.0 agents 声明）', () => {
  it('manifest 声明 agents → yaml 注册为 plugin 源定义', () => {
    const fxRoot = path.join(tmpRoot, 'cg-fixture');
    fs.mkdirSync(path.join(fxRoot, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(fxRoot, 'agents', 'code-navigator.yaml'),
      `# 夹具：与 momo-plugin 仓 codegraph agents/code-navigator.yaml 同形（最小保留 frontmatter 语义字段）
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 代码导航员
  slug: code-navigator
  version: 1.0.0
  description: 问「某符号被谁调用 / 改动影响面」派我；先用 codegraph 图谱查询，再读源码确认。
spec:
  declarative:
    systemPrompt: |
      你是代码导航员——调用关系专家。
    model:
      provider: openai
      model: gpt-4o
  defaultTools:
    - kind: builtin
      ref: read_file
`,
      'utf-8',
    );
    const manifest = {
      id: 'cg',
      name: 'cg',
      version: '2.0.0',
      components: { agents: './agents' },
    };
    const rec = {
      id: 'cg',
      version: '2.0.0',
      manifestJson: JSON.stringify(manifest),
      state: 'active',
      source: 'dev',
      sourcePath: fxRoot,
      installedAt: 'x',
    } as Parameters<typeof registerPluginAgents>[0];
    const n = registerPluginAgents(rec);
    expect(n).toBeGreaterThanOrEqual(1);
    const def = getDb()
      .prepare(`SELECT source, slug FROM agent_definitions WHERE id = 'plugin:cg:code-navigator'`)
      .get() as { source: string; slug: string } | undefined;
    expect(def).toMatchObject({ source: 'plugin', slug: 'code-navigator' });
  });
});
```

注意：`tmpRoot`、`fs`、`path`、`getDb`、`registerPluginAgents` 均为该文件既有模块级引用（前半 L198 的 tmp 夹具已在使用），无需新增 import。若替换后 typecheck 报 `as` 断言问题，与原文件 L224 的既有写法保持一致即可（原版即 `as Parameters<typeof registerPluginAgents>[0]`）。

- [ ] **Step 2: 更新 library.test.ts 过时注释**

`electron/tests/resource/library.test.ts` L57-58，将：

```typescript
// mock 插件资源行（plugins 表/开发目录扫描——不 mock 会读到仓库 plugins/codegraph
// 的 agent+skill 两行，测试随仓库插件状态漂移；本文件只测三源纯合并逻辑）
```

替换为：

```typescript
// mock 插件资源行（plugins 表/开发目录扫描——历史注：仓库曾内置 plugins/codegraph
// 目录，2026-11-03 已迁出至独立仓 momo-plugin；本文件只测三源纯合并逻辑）
```

- [ ] **Step 3: 夹具化先行验证（目录仍在，测试先绿）**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/plugin/agent-sync.test.ts tests/resource/library.test.ts`
Expected: 全 PASS（此刻仓库 plugins/codegraph 仍在场，验证夹具版测试本身正确）

- [ ] **Step 4: 删除插件目录与已迁测试（Review Focus 5：严格在 Task 1 之后）**

```bash
git rm -r plugins/codegraph
rm -rf plugins/codegraph        # 清掉 engine/、vendor/ 本机残留（已复制到新仓）
rmdir plugins 2>/dev/null || true   # plugins/ 只含 codegraph，删空目录
git rm electron/tests/plugin/codegraph-engine-harness.test.ts
```

同时编辑 `.gitignore`：删除这两行（保留其余全部条目，尤其 office-pro 后续要用的结构）：

```gitignore
plugins/codegraph/engine/
plugins/codegraph/vendor/
```

- [ ] **Step 5: 删除后复跑——证明夹具独立性（Review Focus 5 的判定点）**

Run: `cd electron && npx pnpm@9.0.0 vitest run --pool=forks tests/plugin tests/resource`
Expected: 全 PASS——plugins/codegraph 已不存在而套件仍绿，即夹具化完成（若有失败：`tests/plugin` 内引用旧路径者为遗漏，按 Task 2/3 同款思路处理或确认其本就自包含）

- [ ] **Step 6: typecheck + 全量冒烟**

Run: `cd /Users/stbearangel/dev/AiProject/moo-studio && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: typecheck 双 workspace 无错；全量测试无**新增**失败（存量失败逐个甄别，须与本变更无关才可放行——若有疑似相关失败，回到 Step 5 排查）

- [ ] **Step 7: pathspec 提交（Review Focus 1——绝不裸 commit）**

```bash
git commit -m "refactor: codegraph 迁出至独立仓 momo-plugin，测试夹具化收尾" -- plugins/codegraph electron/tests/plugin/codegraph-engine-harness.test.ts electron/tests/plugin/agent-sync.test.ts electron/tests/resource/library.test.ts .gitignore
```

注意：`git rm` 已把删除暂存，此命令只提交指定路径；staging 区 office-pro 预暂存改动保持原样。

- [ ] **Step 8: 提交核对（Review Focus 1 判定点）**

```bash
git show --stat HEAD && git status --short | head -10
```

Expected: `git show --stat` 只含 Step 7 列出的 5 个路径（删除 9 文件 + 修改 3 文件）；`git status` 里 office-pro 的预暂存改动（`D electron/src/main/resource/hub/smithery.ts` 等）原样仍在 staging 区

---

### Task 5: GitHub 远端创建 + spec §6 全链验证

**Files:**
- Create: GitHub 仓库 `momo-plugin`（公开）
- 无本地文件改动（纯验证与推送）

**Interfaces:**
- Consumes: Task 1-4 全部交付物
- Produces: spec §6「完成的定义」四项证据 + 远端仓库

- [ ] **Step 1: gh 认证检查**

Run: `gh auth status`
Expected: 已登录且 token 有效。若未登录：停下报告用户（不要自行 `gh auth login` 交互）

- [ ] **Step 2: 创建公开仓库并推送**

```bash
cd ../momo-plugin && gh repo create momo-plugin --public --source=. --remote=origin --push --description "Momo Studio 插件集中研发仓库（宿主：momo-studio）"
```

Expected: 输出仓库 URL；`git ls-remote origin` 可见 `refs/heads/main`

- [ ] **Step 3: 远端可见性验证（spec §6-4）**

Run: `gh repo view momo-plugin --json visibility,url`
Expected: `"visibility": "PUBLIC"`

```bash
cd ../momo-plugin && git ls-files | sort
```

Expected: 18 个文件 = Task 1 Step 4 的 15 个 + `pnpm-lock.yaml` + `tests/codegraph-engine-harness.test.ts` + `tests/dev-install-probe.test.ts`——逐项核对，无 engine/vendor 泄漏

- [ ] **Step 4: spec §6 全链复验（逐项留证据）**

| spec §6 项 | 命令 | 期望 |
|---|---|---|
| 6-1 momo-studio | `cd /Users/stbearangel/dev/AiProject/moo-studio && npx pnpm@9.0.0 typecheck` | 无错（Task 4 已跑，此处复核） |
| 6-2 momo-plugin 引擎在位 | `cd ../momo-plugin && npx pnpm@9.0.0 vitest run` | PASS（harness + probe） |
| 6-2 momo-plugin 缺失容忍 | `cd ../momo-plugin && MOMO_STUDIO_ROOT=/nonexistent npx pnpm@9.0.0 vitest run` | 全 skip 绿 |
| 6-3 dev 链 | Task 3 探针证据（Step 4 复跑即重取） | dev 注册 + probe X_OK |

Expected: 四项全过——spec「完成的定义」达成

- [ ] **Step 5: 清理检查**

Run: `ps -axo pid,ppid,command | grep vitest | grep -v grep`
Expected: 无 PPID=1 孤儿 worker（有则逐个 `kill <pid>`，AGENTS.md 陷阱表纪律）

---

## Self-Review 记录

1. **Spec coverage**：§2 结构→Task 1；§3.1→Task 1/5；§3.2→Task 2；§4 表格五行→Task 4 Step 1/2/4（删目录+删测试+夹具化+注释+gitignore）；§5 非目标→Global Constraints；§6 四项→Task 5 Step 4 + Task 3；§8 mv 时序→Review Focus 5 + Task 4 Step 4。无缺口
2. **Placeholder scan**：全部步骤含具体命令/代码/期望输出；无 TBD/TODO/「适当处理」
3. **Type consistency**：`HostModules`/`ProbeHost` 内联形状与 beforeAll 动态 import 返回断言一致；`PLUGIN_ROOT`/`HOST_ROOT`/`ENGINE_BIN` 命名在 Task 2/3 一致；`installPluginDevDir(dir, currentAppVersion, originWorkspaceId)` 三参与宿主签名一致（install-dev-dir.test.ts L48 为证）
4. **Review Focus**：五类失效模式均有归属任务与验证步骤（见各条目内联标注）
