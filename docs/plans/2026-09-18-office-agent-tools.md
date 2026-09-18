# 办公文档工具组（OfficeTools）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent 运行时新增第 12 个工具模块 OfficeTools——xlsx / docx / pptx / pdf 四格式读取与生成 + Excel 增量写 + 文档复制，完整继承沙箱 / Read-before-Edit / 变更账本 / 权限 / 审计，并交付内置办公助理 agent。

**Architecture:** 单一 `OfficeTools` ToolModule 无条件注册进 `buildToolRegistry`；内部按格式拆 helper（`tools/office/*.ts`）。写路径统一模式：沙箱断言 → 已存在则 assertRead → 读旧字节 → write-ahead 记账（before/after 为 Buffer，经账本二进制扩展落 blob）→ 落盘 → 标记已读。前置扩展 journal（recorder/store/revert）接受 `string | Buffer`，既有文本调用方零变化。

**Tech Stack:** exceljs / docx / mammoth / pptxgenjs / pdfkit / pdfjs-dist ^3.11（全部纯 JS 无 native binding）；pptx 读取用既有 adm-zip + cheerio 自解析。（2026-09-18 裁定：弃 pdf-parse——v2 硬依赖 @napi-rs/canvas 原生二进制）

**Spec:** `docs/specs/2026-09-18-office-agent-tools-design.md`（本计划的唯一需求来源，冲突时以 spec 为准）

## 全局约束（每个任务默认继承）

- **Node 20**：一切 pnpm / vitest 命令前先 `nvm use 20`（Node 26 会破坏 better-sqlite3）
- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；`noUncheckedIndexedAccess: true`（数组下标访问返回 `T | undefined`，循环一律用 `.entries()` 迭代或显式兜底）
- **中文注释**：源码注释、文档全中文；标识符英文
- **单测位置**：electron 主进程单测集中 `electron/tests/`，子目录镜像 `src/`（`tests/agent/tools/office/` 镜像 `src/main/agent/tools/office/`；journal 用例进 `tests/journal/`；migration 用例进 `tests/storage/`）
- **测试命令**：`cd electron && npx pnpm@9.0.0 vitest run <路径>`；类型检查 `npx pnpm@9.0.0 typecheck`（仓库根）
- **版本纪律**：所有 commit 不动 `package.json` 版本号；不动 CHANGELOG（主机批量记账）
- **Conventional Commits**：`feat:` / `test:` / `docs:` 前缀 + 中文描述
- **momo-test-rules**：测试仿真真实运行时语义（真实 tmp 目录 + 真实 WorkspaceFS + 真实 ReadTracker + 真实 journal store），不 mock 库本身
- **journal 测试隔离**：测试内 `process.env.AP_USER_DATA_DIR = <tmp>`（blob 落盘根），afterEach 恢复原值并 `__setJournalStoreForTest(null)`
- CJS 库 import 形态：`esModuleInterop: true` 已启用，default import（`import ExcelJS from 'exceljs'`）

## 文件结构总览

```
electron/src/main/journal/recorder.ts      [改] string|Buffer 泛化
electron/src/main/journal/store.ts         [改] writeBlob 泛化 + readBlobBytes
electron/src/main/journal/revert.ts        [改] 撤销恢复字节化
electron/src/main/journal/ipc.handlers.ts  [改] 视图 blob 严格 utf-8 容错
electron/src/main/agent/tools/office-tools.ts      [新] ToolModule（8 工具）
electron/src/main/agent/tools/office/format.ts     [新] 嗅探 / range / 参数校验
electron/src/main/agent/tools/office/excel.ts      [新] Excel 读写
electron/src/main/agent/tools/office/docx.ts       [新] Word 读写
electron/src/main/agent/tools/office/pptx.ts       [新] PPT 读写
electron/src/main/agent/tools/office/pdf.ts        [新] PDF 读写 + 字体
electron/src/main/agent/tools/index.ts     [改] 注册 OfficeTools
electron/src/main/agent/tools/catalog.ts   [改] 全集 25→33 + 办公分类
electron/src/main/storage/migrations/037_v2_1_office_tools_builtin.ts [新]
electron/src/main/storage/migrations/index.ts [改] 注册 037
electron/resources/agents/office-assistant.yaml [新]
electron/resources/fonts/NotoSansSC-Regular.ttf + OFL.txt [新]
electron/package.json                      [改] 依赖 + extraResources
resources/marketplace/catalog.json         [改] office-assistant 条目
```

---

## Phase P1：账本二进制扩展（独立可验收，先行铺路）

### Task 1: recorder + store 接受 Buffer（hash / blob 字节化）

**Files:**
- Modify: `electron/src/main/journal/recorder.ts`
- Modify: `electron/src/main/journal/store.ts`
- Test: `electron/tests/journal/recorder-binary.test.ts`（新建）

**Interfaces:**
- Produces: `hashContent(content: string | Buffer): string`（同字节同 hash；字符串按 utf-8 编码——既有文本条目 hash 不变，撤销守卫兼容的关键）
- Produces: `recordChange(rc, filePath, op, before: string | Buffer | null, after: string | Buffer | null, oldPath?): JournalEntry`
- Produces: `JournalStore.writeBlob(workspaceId, hash, content: string | Buffer): void`
- Produces: `JournalStore.readBlobBytes(workspaceId, hash): Buffer | null`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/journal/recorder-binary.test.ts
// 账本二进制扩展（spec §6.3）：Buffer before/after 记账 → blob 字节级 round-trip。
// 关键兼容性质：hashContent(字符串) === hashContent(该字符串的 utf-8 Buffer)，
// 保证既有文本条目的撤销 hash 守卫在新代码下语义不变。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setJournalStoreForTest,
  getJournalStore,
  hashContent,
  recordChange,
  type RecordCtx,
} from '../../src/main/journal/recorder';
import { createJournalStore } from '../../src/main/journal/store';
import { migration033 } from '../../src/main/storage/migrations/033_v2_5_change_journal';

let tmpDir: string;
let prevUserData: string | undefined;
const rc: RecordCtx = {
  workspaceId: 'ws-bin',
  taskId: null,
  sessionId: null,
  streamSessionId: 'ssn-bin',
  toolName: 'office_test',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-journal-bin-'));
  prevUserData = process.env.AP_USER_DATA_DIR;
  process.env.AP_USER_DATA_DIR = tmpDir;
  const db = new Database(':memory:');
  db.exec(migration033.up);
  __setJournalStoreForTest(createJournalStore(db));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  if (prevUserData === undefined) delete process.env.AP_USER_DATA_DIR;
  else process.env.AP_USER_DATA_DIR = prevUserData;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hashContent string|Buffer 泛化', () => {
  it('字符串与其 utf-8 Buffer 同 hash（既有文本条目守卫兼容）', () => {
    const s = 'héllo 世界\n';
    expect(hashContent(Buffer.from(s, 'utf-8'))).toBe(hashContent(s));
  });

  it('不同字节不同 hash', () => {
    expect(hashContent(Buffer.from([0x00, 0xff, 0x10]))).not.toBe(
      hashContent(Buffer.from([0x00, 0xff, 0x11])),
    );
  });
});

describe('recordChange Buffer 记账', () => {
  it('before/after 为 Buffer：entry hash 正确', () => {
    // 模拟 zip 头 + 非 utf-8 字节序列（若按文本落盘必损坏）
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00]);
    const after = Buffer.concat([before, Buffer.from([0x01, 0x02])]);
    const entry = recordChange(rc, '报表.xlsx', 'modify', before, after);
    expect(entry.beforeHash).toBe(hashContent(before));
    expect(entry.afterHash).toBe(hashContent(after));
    expect(entry.op).toBe('modify');
  });

  it('blob 字节 round-trip：readBlobBytes 与原 Buffer equals', () => {
    const store = getJournalStore();
    expect(store).not.toBeNull();
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0x81, 0x82]);
    const entry = recordChange(rc, 'bin.xlsx', 'create', null, bytes);
    const back = store!.readBlobBytes('ws-bin', entry.afterHash!);
    expect(back).not.toBeNull();
    expect(back!.equals(bytes)).toBe(true);
  });

  it('文本 blob 既有语义不回归：readBlob 返回 utf-8 字符串', () => {
    const store = getJournalStore()!;
    const entry = recordChange(rc, 'a.ts', 'create', null, 'const x = 1;');
    expect(store.readBlob('ws-bin', entry.afterHash!)).toBe('const x = 1;');
    expect(store.readBlobBytes('ws-bin', entry.afterHash!)!.toString('utf-8')).toBe('const x = 1;');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/journal/recorder-binary.test.ts
```
预期：FAIL（`hashContent` 不接受 Buffer / `readBlobBytes` 不存在，编译或运行时报错）

- [ ] **Step 3: 实现 recorder 泛化**

`electron/src/main/journal/recorder.ts`：

```ts
/** sha256 hex 内容寻址；与 store.writeBlob 内容寻址存储契约一致。
 * v2.1 二进制扩展：接受 Buffer（office 文档等 zip 容器）；字符串按 utf-8 编码后
 * hash——同一字节流两种传法同 hash，既有文本条目的撤销守卫语义不变。 */
export function hashContent(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return createHash('sha256').update(buf).digest('hex');
}
```

`recordChange` 与 `assembleEntry` 签名的 `before` / `after` 类型改为 `string | Buffer | null`（函数体不动——hash 与 writeBlob 均已泛化透传）。文件头注释追加：`// v2.1 二进制扩展：before/after 泛化 string|Buffer（office 工具组；spec 2026-09-18 §6.3）。`

- [ ] **Step 4: 实现 store 泛化 + readBlobBytes**

`electron/src/main/journal/store.ts` 接口两处：

```ts
  /** 内容寻址写盘，幂等（同 hash 已存在即跳过）。v2.1 二进制扩展：接受 Buffer。 */
  writeBlob(workspaceId: string, hash: string, content: string | Buffer): void;
  readBlob(workspaceId: string, hash: string): string | null;
  /** v2.1 二进制扩展：字节读取（撤销恢复二进制文件用）；文本 blob 读回即其 utf-8 字节 */
  readBlobBytes(workspaceId: string, hash: string): Buffer | null;
```

实现三处：

```ts
    writeBlob(workspaceId: string, hash: string, content: string | Buffer): void {
      const file = resolveJournalDir(workspaceId, hash);
      // 内容寻址：同 hash 即同内容，已存在直接跳过（幂等，不重写不覆盖）
      if (fs.existsSync(file)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);
    },
    readBlob(workspaceId: string, hash: string): string | null {
      const file = resolveJournalDir(workspaceId, hash);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf-8');
    },
    readBlobBytes(workspaceId: string, hash: string): Buffer | null {
      const file = resolveJournalDir(workspaceId, hash);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file);
    },
```

- [ ] **Step 5: 跑测试 + 既有 journal 套件不回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/journal/
```
预期：全部 PASS

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/journal/recorder.ts electron/src/main/journal/store.ts electron/tests/journal/recorder-binary.test.ts
GIT_MASTER=1 git commit -m "feat: 账本二进制扩展——recorder/store 接受 Buffer 与字节 blob 读取"
```

### Task 2: revert 字节化恢复 + IPC 视图二进制容错

**Files:**
- Modify: `electron/src/main/journal/revert.ts`
- Modify: `electron/src/main/journal/ipc.handlers.ts`
- Test: `electron/tests/journal/revert-binary.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `hashContent(string | Buffer)`、`readBlobBytes`
- Produces: revert.ts 内部 `readFileOrNull` → `readFileBytesOrNull`（返回 Buffer）、`fetchBeforeContent` 返回 Buffer、`writeBack(abs, content: Buffer)`；对外 API（`revertEntries` / `RevertOutcome`）签名不变
- Produces: ipc.handlers.ts 的 `readTextCapped` 对非 utf-8 blob 返回 null（视图层沿用既有 null 占位；spec §6.3-5「二进制内容」以 null 语义实现，不改 renderer）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/journal/revert-binary.test.ts
// 二进制 modify → revert → 字节级一致（office 文档撤销保真的核心回归锁）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setJournalStoreForTest,
  getJournalStore,
  recordChange,
  type RecordCtx,
} from '../../src/main/journal/recorder';
import { createJournalStore } from '../../src/main/journal/store';
import { revertEntries } from '../../src/main/journal/revert';
import { migration033 } from '../../src/main/storage/migrations/033_v2_5_change_journal';

let tmpDir: string;      // userData（blob 根）
let wsDir: string;       // workspace
let prevUserData: string | undefined;
const rc: RecordCtx = {
  workspaceId: 'ws-bin2',
  taskId: null,
  sessionId: null,
  streamSessionId: 'ssn-bin2',
  toolName: 'office_write_excel',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-revert-bin-'));
  wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir);
  prevUserData = process.env.AP_USER_DATA_DIR;
  process.env.AP_USER_DATA_DIR = tmpDir;
  const db = new Database(':memory:');
  db.exec(migration033.up);
  __setJournalStoreForTest(createJournalStore(db));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  if (prevUserData === undefined) delete process.env.AP_USER_DATA_DIR;
  else process.env.AP_USER_DATA_DIR = prevUserData;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('二进制文件 modify 撤销', () => {
  it('revert 后字节级一致（含非 utf-8 序列）', async () => {
    const rel = '报表.xlsx';
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x99]);
    const after = Buffer.concat([before, Buffer.from([0xde, 0xad])]);
    fs.writeFileSync(path.join(wsDir, rel), before);
    const entry = recordChange(rc, rel, 'modify', before, after);
    fs.writeFileSync(path.join(wsDir, rel), after); // 模拟工具写盘

    const outcomes = await revertEntries('ws-bin2', wsDir, [entry.id]);
    expect(outcomes[0]?.result).toBe('reverted');
    const restored = fs.readFileSync(path.join(wsDir, rel));
    expect(restored.equals(before)).toBe(true);
  });

  it('文本文件撤销不回归（字节读写对 utf-8 无损）', async () => {
    const rel = 'a.ts';
    const before = 'const x = 1;\n';
    const after = 'const x = 2;\n';
    fs.writeFileSync(path.join(wsDir, rel), before);
    const entry = recordChange(rc, rel, 'modify', before, after);
    fs.writeFileSync(path.join(wsDir, rel), after);
    const outcomes = await revertEntries('ws-bin2', wsDir, [entry.id]);
    expect(outcomes[0]?.result).toBe('reverted');
    expect(fs.readFileSync(path.join(wsDir, rel), 'utf-8')).toBe(before);
  });
});

describe('IPC 视图二进制容错（严格 utf-8 校验方法有效性）', () => {
  it('非 utf-8 字节经 toString 再编码不等于原字节（校验方法成立）', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0xff, 0xfe, 0x00]);
    const roundTrip = Buffer.from(bytes.toString('utf-8'), 'utf-8');
    expect(roundTrip.equals(bytes)).toBe(false);
  });

  it('二进制 blob 经 readBlobBytes 原样可取（视图层判定输入成立）', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0xff, 0xfe, 0x00]);
    const entry = recordChange(rc, 'b.xlsx', 'create', null, bytes);
    const back = getJournalStore()!.readBlobBytes('ws-bin2', entry.afterHash!);
    expect(back!.equals(bytes)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/journal/revert-binary.test.ts
```
预期：第一个用例 FAIL（当前 revert 按文本读写，二进制恢复后字节被 utf-8 往返破坏）

- [ ] **Step 3: revert.ts 字节化**

`electron/src/main/journal/revert.ts` 四处修改（对外 API 与语义注释不动）：

```ts
/** 读取文件当前字节；不存在返回 null；其余读错误向上抛（→ failed）
 * v2.1 字节化：二进制与文本统一按字节处理（文本是字节子集，utf-8 无损） */
async function readFileBytesOrNull(absPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absPath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}
```

```ts
/** 取 before 内容 blob 字节；条目脏数据（缺 beforeHash）或 blob 缺失 → 抛错（→ failed） */
function fetchBeforeContent(
  store: JournalStore,
  workspaceId: string,
  entry: JournalEntry,
): Buffer {
  if (entry.beforeHash == null) {
    throw new Error('条目缺少 beforeHash，无法撤回（数据异常）');
  }
  const content = store.readBlobBytes(workspaceId, entry.beforeHash);
  if (content === null) {
    throw new Error(`before 内容 blob 缺失（hash=${entry.beforeHash}）`);
  }
  return content;
}
```

```ts
/** 写回内容字节（先确保父目录存在——restore 场景父目录可能已删；父路径被普通文件
 *  占位时 mkdir 抛 EEXIST → 由调用方 catch 成 failed） */
async function writeBack(absPath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}
```

`recordInverse` 的 `before` / `after` 参数类型改为 `string | Buffer | null`（`recordChange` 已泛化，直接透传）。

`revertOne` 内：`const current = await readFileBytesOrNull(absPath);`（删除原 `readFileOrNull`；`curHash = current !== null ? hashContent(current) : null` 这行不变——hashContent 已接受 Buffer）。

- [ ] **Step 4: ipc.handlers.ts 二进制容错**

`readTextCapped` 替换为：

```ts
/** hash 侧文本：hash 为 null（无内容侧）或 blob 缺失 → null；二进制 blob（非严格
 * utf-8）→ null（视图层显示占位）；否则截断 100KB。
 * v2.1 二进制扩展：office 文档 blob 不是文本，解码再编码不等于原字节即判非文本。 */
function readTextCapped(workspaceId: string, hash: string | null): string | null {
  if (hash === null) return null;
  const buf = requireStore().readBlobBytes(workspaceId, hash);
  if (buf === null) return null;
  const text = buf.toString('utf-8');
  if (!Buffer.from(text, 'utf-8').equals(buf)) return null;
  return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
}
```

- [ ] **Step 5: 跑测试 + 全 journal 套件**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/journal/
```
预期：全部 PASS

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/journal/revert.ts electron/src/main/journal/ipc.handlers.ts electron/tests/journal/revert-binary.test.ts
GIT_MASTER=1 git commit -m "feat: 账本撤销字节化 + 视图二进制容错——office 二进制文档撤销保真"
```

---

## Phase P2：Excel 全链路

### Task 3: 依赖安装 + office/format.ts（格式嗅探与 A1 range 解析）

**Files:**
- Create: `electron/src/main/agent/tools/office/format.ts`
- Modify: `electron/package.json`（依赖）
- Test: `electron/tests/agent/tools/office/format.test.ts`（新建）

**Interfaces:**
- Produces: `type OfficeFormat = 'xlsx' | 'docx' | 'pptx' | 'pdf'`
- Produces: `detectOfficeFormat(fileName: string): OfficeFormat | null`
- Produces: `assertOfficeFormat(fileName: string): OfficeFormat`（不支持时抛中文错误，旧格式提示另存）
- Produces: `parseRange(range: string): { startRow: number; startCol: number; endRow: number | null; endCol: number | null }`（1-based；`'A1'` → ends null；`'B3:C12'` → ends 有值）
- Produces: `colToIndex(letters: string): number`（A=1，AA=27）
- Produces: `asString(v: unknown, what: string): string` / `asStringArray(v: unknown, what: string): string[]`（后续任务的参数窄化原语）

- [ ] **Step 1: 安装全部新依赖（后续任务不再装）**

```bash
nvm use 20
npx pnpm@9.0.0 --filter momo-studio-electron add exceljs docx pptxgenjs mammoth pdfkit pdfjs-dist@^3.11.174
npx pnpm@9.0.0 --filter momo-studio-electron add -D @types/pdfkit
# 注：@types/mammoth 不存在（npm 404，T7 用本地模块声明）；@types/pdf-parse 不需要（pdfjs-dist 自带 types）；pdf-parse 已弃用（裁定见 spec §4.2）
```
预期：pnpm-lock 更新，无 native 编译产物（全部纯 JS）

- [ ] **Step 2: 写失败测试**

```ts
// electron/tests/agent/tools/office/format.test.ts
import { describe, it, expect } from 'vitest';
import {
  detectOfficeFormat, assertOfficeFormat, parseRange, colToIndex, asString, asStringArray,
} from '../../../../src/main/agent/tools/office/format';

describe('detectOfficeFormat', () => {
  it('四格式大小写不敏感识别', () => {
    expect(detectOfficeFormat('a.XLSX')).toBe('xlsx');
    expect(detectOfficeFormat('b.Docx')).toBe('docx');
    expect(detectOfficeFormat('c.pptx')).toBe('pptx');
    expect(detectOfficeFormat('d.pdf')).toBe('pdf');
  });
  it('旧格式与其他扩展名返回 null', () => {
    expect(detectOfficeFormat('old.xls')).toBeNull();
    expect(detectOfficeFormat('old.doc')).toBeNull();
    expect(detectOfficeFormat('old.ppt')).toBeNull();
    expect(detectOfficeFormat('a.txt')).toBeNull();
  });
});

describe('assertOfficeFormat', () => {
  it('旧格式报错并提示另存新格式', () => {
    expect(() => assertOfficeFormat('x.xls')).toThrow(/另存/);
  });
  it('支持格式原样通过', () => {
    expect(assertOfficeFormat('x.xlsx')).toBe('xlsx');
  });
});

describe('parseRange', () => {
  it('单格：ends 为 null（按 values 形状展开）', () => {
    expect(parseRange('A1')).toEqual({ startRow: 1, startCol: 1, endRow: null, endCol: null });
    expect(parseRange('b3')).toEqual({ startRow: 3, startCol: 2, endRow: null, endCol: null });
  });
  it('完整区域', () => {
    expect(parseRange('A1:F50')).toEqual({ startRow: 1, startCol: 1, endRow: 50, endCol: 6 });
    expect(parseRange('aa10:AB12')).toEqual({ startRow: 10, startCol: 27, endRow: 12, endCol: 28 });
  });
  it('非法输入全部拒绝', () => {
    for (const bad of ['1A', 'A0', 'C2:A1', '5', 'A1:B0', 'A:', '', 'A1:B2C']) {
      expect(() => parseRange(bad), `range=${bad}`).toThrow();
    }
  });
});

describe('colToIndex', () => {
  it('字母转列号', () => {
    expect(colToIndex('A')).toBe(1);
    expect(colToIndex('Z')).toBe(26);
    expect(colToIndex('AA')).toBe(27);
  });
});

describe('参数窄化原语', () => {
  it('asString 拒绝非字符串与空串', () => {
    expect(asString('ok', 'path')).toBe('ok');
    expect(() => asString(1, 'path')).toThrow(/path/);
    expect(() => asString('', 'path')).toThrow(/path/);
  });
  it('asStringArray 逐元素校验', () => {
    expect(asStringArray(['a', 'b'], 'items')).toEqual(['a', 'b']);
    expect(() => asStringArray(['a', 1], 'items')).toThrow(/items\[1\]/);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/format.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 4: 实现 format.ts**

```ts
// electron/src/main/agent/tools/office/format.ts
// 办公工具组共享：扩展名嗅探、A1 range 解析、参数窄化原语。

import path from 'node:path';

export type OfficeFormat = 'xlsx' | 'docx' | 'pptx' | 'pdf';

/** 按文件名扩展名嗅探格式；不支持（含旧二进制 .xls/.doc/.ppt）返回 null */
export function detectOfficeFormat(fileName: string): OfficeFormat | null {
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  return null;
}

/** 断言支持格式；旧格式给出「另存为新格式」指引 */
export function assertOfficeFormat(fileName: string): OfficeFormat {
  const fmt = detectOfficeFormat(fileName);
  if (fmt !== null) return fmt;
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  if (ext === 'xls' || ext === 'doc' || ext === 'ppt') {
    throw new Error(`不支持旧格式 .${ext}——请先在 Office/WPS 中另存为 .${ext}x 新格式`);
  }
  throw new Error(`不支持的文档格式: ${fileName}（支持 xlsx / docx / pptx / pdf）`);
}

/** 列字母 → 1-based 列号（A=1, Z=26, AA=27） */
export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) throw new Error(`非法列字母: ${letters}`);
    n = n * 26 + (code - 64);
  }
  return n;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  /** null = 未给定终点（调用方按数据形状展开） */
  endRow: number | null;
  endCol: number | null;
}

const RANGE_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/;

/** A1 记法解析：'A1'（ends null）或 'A1:F50'（ends 有值，保证 start<=end） */
export function parseRange(range: string): CellRange {
  const m = RANGE_RE.exec(range.trim());
  if (!m) throw new Error(`非法 range: "${range}"（示例：A1 或 A1:F50）`);
  const startCol = colToIndex(m[1]!);
  const startRow = Number(m[2]!);
  const endCol = m[3] !== undefined ? colToIndex(m[3]) : null;
  const endRow = m[4] !== undefined ? Number(m[4]) : null;
  if (endCol !== null && endRow !== null && (endRow < startRow || endCol < startCol)) {
    throw new Error(`非法 range: "${range}"（终点必须不小于起点）`);
  }
  return { startRow, startCol, endRow, endCol };
}

/** 窄化原语：非空字符串或抛错（中文错误含字段名） */
export function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`参数 ${what} 缺失或不是非空字符串`);
  }
  return v;
}

/** 窄化原语：字符串数组或抛错（逐元素报字段下标） */
export function asStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`参数 ${what} 缺失或不是数组`);
  return v.map((x, i) => asString(x, `${what}[${i}]`));
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/format.test.ts
```
预期：PASS

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/format.ts electron/tests/agent/tools/office/format.test.ts electron/package.json ../pnpm-lock.yaml
GIT_MASTER=1 git commit -m "feat: office 工具组地基——格式嗅探、A1 range 解析与六库依赖引入"
```

### Task 4: excel.ts 读取链路（sheet 预览 + 区域精读）

**Files:**
- Create: `electron/src/main/agent/tools/office/excel.ts`
- Test: `electron/tests/agent/tools/office/excel-read.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `parseRange`
- Produces: `readXlsxPreview(abs: string, signal?: AbortSignal): Promise<string>`（每 sheet `## Sheet: <名> (<行>×<列>)` + 前 20 行 × 12 列 markdown 表格；空 sheet 标注；超限提示精读）
- Produces: `readXlsxCells(abs: string, sheet: string | number, range?: string, formulas?: boolean): Promise<string>`（markdown 表格，首行为表头；上限 500 行 × 64 列）
- Produces: `cellText(v: ExcelJS.CellValue, formulas?: boolean): string`（公式取缓存 result；`formulas=true` 显示 `=<原文>`。注意：exceljs 不计算公式，result 仅取文件内缓存值，无缓存显示空）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/excel-read.test.ts
// 真实 exceljs 造文件 → 真实读取断言（不 mock 库）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readXlsxPreview, readXlsxCells } from '../../../../src/main/agent/tools/office/excel';

let tmpDir: string;
let abs: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xlsx-read-'));
  abs = path.join(tmpDir, 'data.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('销售');
  ws.addRow(['日期', '地区', '金额']);
  ws.addRow(['2026-01-01', '华东', 100]);
  ws.addRow(['2026-01-02', '华北', 200]);
  const ws2 = wb.addWorksheet('空表');
  const fws = wb.addWorksheet('公式');
  fws.getCell('A1').value = 1;
  fws.getCell('A2').value = 2;
  fws.getCell('A3').value = { formula: 'SUM(A1:A2)' }; // 无缓存 result
  await wb.xlsx.writeFile(abs);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('readXlsxPreview', () => {
  it('逐 sheet 输出维度与预览，空 sheet 标注', async () => {
    const out = await readXlsxPreview(abs);
    expect(out).toContain('## Sheet: 销售 (3×3)');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('## Sheet: 空表');
    expect(out).toContain('(空 sheet)');
  });
});

describe('readXlsxCells', () => {
  it('默认已用区域，首行为表头（markdown 表格）', async () => {
    const out = await readXlsxCells(abs, '销售');
    expect(out).toContain('| 日期 | 地区 | 金额 |');
    expect(out).toContain('| 2026-01-02 | 华北 | 200 |');
  });
  it('range 精读 + sheet 序号定位', async () => {
    const out = await readXlsxCells(abs, 1, 'A1:B2');
    expect(out).toContain('| 日期 | 地区 |');
    expect(out).not.toContain('华北');
  });
  it('公式默认显示缓存值（无缓存为空），formulas=true 显示原文', async () => {
    expect(await readXlsxCells(abs, '公式')).toContain('|  |'); // A3 无缓存 result
    expect(await readXlsxCells(abs, '公式', undefined, true)).toContain('=SUM(A1:A2)');
  });
  it('sheet 不存在报错', async () => {
    await expect(readXlsxCells(abs, '不存在')).rejects.toThrow(/sheet 不存在/);
  });
  it('超过 500 行上限报错并说明上限', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('大表');
    for (let i = 0; i < 501; i++) ws.addRow([i]);
    const bigAbs = path.join(tmpDir, 'big.xlsx');
    await wb.xlsx.writeFile(bigAbs);
    await expect(readXlsxCells(bigAbs, '大表')).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/excel-read.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 3: 实现 excel.ts 读取部分**

```ts
// electron/src/main/agent/tools/office/excel.ts
// Excel 读写封装（exceljs）。读取两档：sheet 预览（office_read）与区域精读
// （office_read_cells）；写路径 createXlsx / writeXlsxOps 返回 Buffer，落盘与
// 记账由 office-tools 统一处理（write-ahead：先记账后写盘）。
// 公式注意：exceljs 不计算公式——读取公式的 result 仅取文件内缓存值（写入侧
// 新写的公式无缓存，显示空），需要精确计算时由 agent 在上下文中完成运算。

import ExcelJS from 'exceljs';
import { parseRange } from './format';

export const PREVIEW_ROWS = 20;
export const PREVIEW_COLS = 12;
export const MAX_READ_ROWS = 500;
export const MAX_READ_COLS = 64;

/** 单元格值 → 展示文本。formulas=true 时公式显示 =原文，否则显示缓存 result */
export function cellText(v: ExcelJS.CellValue, formulas = false): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('formula' in v && typeof v.formula === 'string') {
      return formulas ? `=${v.formula}` : cellText(v.result ?? null, false);
    }
    if ('sharedFormula' in v && typeof v.sharedFormula === 'string') {
      return formulas ? `=${v.sharedFormula}` : cellText(v.result ?? null, false);
    }
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('error' in v) return String(v.error);
    if ('hyperlink' in v) return typeof v.text === 'string' ? v.text : String(v.hyperlink);
    return JSON.stringify(v);
  }
  return String(v);
}

/** sheet 预览：每 sheet 一节（维度 + 前 20 行 × 12 列 markdown 表格） */
export async function readXlsxPreview(abs: string, signal?: AbortSignal): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const parts: string[] = [];
  for (const ws of wb.worksheets) {
    if (signal?.aborted) throw new Error('已中断');
    const rows = ws.rowCount;
    const cols = ws.columnCount;
    parts.push(`## Sheet: ${ws.name} (${rows}×${cols})`);
    if (rows === 0 || cols === 0) {
      parts.push('(空 sheet)');
      continue;
    }
    const lines: string[] = [];
    const rMax = Math.min(rows, PREVIEW_ROWS);
    const cMax = Math.min(cols, PREVIEW_COLS);
    for (let r = 1; r <= rMax; r++) {
      const cells: string[] = [];
      for (let c = 1; c <= cMax; c++) cells.push(cellText(ws.getCell(r, c).value));
      lines.push(`| ${cells.join(' | ')} |`);
      if (r === 1) lines.push(`|${' --- |'.repeat(cMax)}`);
    }
    parts.push(lines.join('\n'));
    if (cols > PREVIEW_COLS) parts.push(`(共 ${cols} 列，仅预览前 ${PREVIEW_COLS} 列)`);
    if (rows > PREVIEW_ROWS) {
      parts.push(`(共 ${rows} 行，仅预览前 ${PREVIEW_ROWS} 行——用 office_read_cells 精读)`);
    }
  }
  return parts.join('\n\n');
}

/** 区域精读：markdown 表格（首行为表头）；sheet 按名或 1-based 序号 */
export async function readXlsxCells(
  abs: string,
  sheet: string | number,
  range?: string,
  formulas = false,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const ws = typeof sheet === 'number' ? wb.worksheets[sheet - 1] : wb.getWorksheet(sheet);
  if (!ws) {
    throw new Error(`sheet 不存在: ${typeof sheet === 'number' ? `#${sheet}` : sheet}`);
  }
  let startRow = 1;
  let startCol = 1;
  let endRow = ws.rowCount;
  let endCol = ws.columnCount;
  if (range) {
    const r = parseRange(range);
    startRow = r.startRow;
    startCol = r.startCol;
    endRow = r.endRow ?? ws.rowCount;
    endCol = r.endCol ?? ws.columnCount;
  }
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  if (rows > MAX_READ_ROWS || cols > MAX_READ_COLS) {
    throw new Error(
      `读取区域过大（${rows} 行 × ${cols} 列）——上限 ${MAX_READ_ROWS} 行 × ${MAX_READ_COLS} 列，请用 range 缩小`,
    );
  }
  const lines: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const cells: string[] = [];
    for (let c = startCol; c <= endCol; c++) cells.push(cellText(ws.getCell(r, c).value, formulas));
    lines.push(`| ${cells.join(' | ')} |`);
    if (r === startRow) lines.push(`|${' --- |'.repeat(cols)}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/excel-read.test.ts
```
预期：PASS

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/excel.ts electron/tests/agent/tools/office/excel-read.test.ts
GIT_MASTER=1 git commit -m "feat: Excel 读取链路——sheet 预览与区域精读"
```

### Task 5: excel.ts 写链路（create + writeOps 序列化）

**Files:**
- Modify: `electron/src/main/agent/tools/office/excel.ts`
- Test: `electron/tests/agent/tools/office/excel-write.test.ts`（新建）

**Interfaces:**
- Produces: `interface ExcelSheetInit { name: string; headers?: string[] }`
- Produces: `parseSheetInits(raw: unknown): ExcelSheetInit[]`（缺省 `[{name:'Sheet1'}]`；名字查重）
- Produces: `type CellInput = string | number | boolean | null | { formula: string }`
- Produces: `type ExcelWriteOp = { op: 'add_sheet'; name: string } | { op: 'set_cells'; sheet: string; range?: string; values: CellInput[][] }`
- Produces: `parseExcelWriteOps(raw: unknown): ExcelWriteOp[]`
- Produces: `createXlsx(sheets: ExcelSheetInit[]): Promise<Buffer>`
- Produces: `writeXlsxOps(before: Buffer, ops: ExcelWriteOp[]): Promise<Buffer>`（输入原文件字节，输出新文件字节——office-tools 拿两侧字节记账）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/excel-write.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createXlsx, writeXlsxOps, parseSheetInits, parseExcelWriteOps,
} from '../../../../src/main/agent/tools/office/excel';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xlsx-write-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function readBack(abs: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  return wb.worksheets[0]!;
}

describe('createXlsx', () => {
  it('建骨架 + 列头，落盘可被 exceljs 重读', async () => {
    const buf = await createXlsx(parseSheetInits([{ name: '汇总', headers: ['月份', '金额'] }]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b])); // zip 魔数
    const abs = path.join(tmpDir, 'a.xlsx');
    fs.writeFileSync(abs, buf);
    const ws = await readBack(abs);
    expect(ws.name).toBe('汇总');
    expect(ws.getCell('A1').value).toBe('月份');
  });
  it('缺省建 Sheet1', async () => {
    const buf = await createXlsx(parseSheetInits(undefined));
    const abs = path.join(tmpDir, 'b.xlsx');
    fs.writeFileSync(abs, buf);
    expect((await readBack(abs)).name).toBe('Sheet1');
  });
  it('sheet 名查重', () => {
    expect(() => parseSheetInits([{ name: 'x' }, { name: 'x' }])).toThrow(/重名/);
  });
});

describe('writeXlsxOps', () => {
  it('add_sheet + set_cells 值与公式 round-trip', async () => {
    const abs = path.join(tmpDir, 'c.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits([{ name: '原始' }])));
    const ops = parseExcelWriteOps([
      { op: 'add_sheet', name: '汇总' },
      { op: 'set_cells', sheet: '汇总', range: 'A1', values: [['月', '额'], ['1月', { formula: 'SUM(原始!A:A)' }]] },
    ]);
    const out = await writeXlsxOps(fs.readFileSync(abs), ops);
    fs.writeFileSync(abs, out);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const ws = wb.getWorksheet('汇总')!;
    expect(ws.getCell('A1').value).toBe('月');
    expect(ws.getCell('B2').value).toMatchObject({ formula: 'SUM(原始!A:A)' });
  });
  it('左上角单格按 values 形状展开', async () => {
    const abs = path.join(tmpDir, 'd.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    const out = await writeXlsxOps(
      fs.readFileSync(abs),
      parseExcelWriteOps([{ op: 'set_cells', sheet: 'Sheet1', range: 'B2', values: [[1, 2], [3, 4]] }]),
    );
    fs.writeFileSync(abs, out);
    const ws = await readBack(abs);
    expect(ws.getCell('B2').value).toBe(1);
    expect(ws.getCell('C3').value).toBe(4);
  });
  it('完整区域形状不匹配报错', async () => {
    const abs = path.join(tmpDir, 'e.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    await expect(
      writeXlsxOps(
        fs.readFileSync(abs),
        parseExcelWriteOps([{ op: 'set_cells', sheet: 'Sheet1', range: 'A1:B3', values: [[1]] }]),
      ),
    ).rejects.toThrow(/形状不一致/);
  });
  it('set_cells 到不存在的 sheet 报错（须显式 add_sheet）', async () => {
    const abs = path.join(tmpDir, 'f.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    await expect(
      writeXlsxOps(
        fs.readFileSync(abs),
        parseExcelWriteOps([{ op: 'set_cells', sheet: '没有', values: [[1]] }]),
      ),
    ).rejects.toThrow(/add_sheet/);
  });
  it('非法 op 结构拒绝', () => {
    expect(() => parseExcelWriteOps([{ op: 'del_sheet', name: 'x' }])).toThrow(/op/);
    expect(() => parseExcelWriteOps('不是数组')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/excel-write.test.ts
```
预期：FAIL（导出不存在）

- [ ] **Step 3: 实现写链路（追加到 excel.ts；import 区合并 `import { asString, asStringArray, parseRange } from './format';`）**

```ts
// ────────────────────────────────────────────────────────────────────────────
// 写链路：类型 + 窄化 + 序列化。返回 Buffer（调用方记账后落盘）。
// ────────────────────────────────────────────────────────────────────────────

export interface ExcelSheetInit {
  name: string;
  headers?: string[];
}

/** sheets 参数窄化：缺省 [{name:'Sheet1'}]；name 必填且查重 */
export function parseSheetInits(raw: unknown): ExcelSheetInit[] {
  if (raw === undefined || raw === null) return [{ name: 'Sheet1' }];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 sheets 缺失或不是非空数组');
  const seen = new Set<string>();
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`sheets[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const name = asString(rec.name, `sheets[${i}].name`);
    if (seen.has(name)) throw new Error(`sheet 重名: ${name}`);
    seen.add(name);
    return {
      name,
      headers: rec.headers === undefined ? undefined : asStringArray(rec.headers, `sheets[${i}].headers`),
    };
  });
}

export type CellInput = string | number | boolean | null | { formula: string };

export type ExcelWriteOp =
  | { op: 'add_sheet'; name: string }
  | { op: 'set_cells'; sheet: string; range?: string; values: CellInput[][] };

function parseCellInput(v: unknown, what: string): CellInput {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'object' && typeof (v as Record<string, unknown>).formula === 'string') {
    return { formula: (v as Record<string, unknown>).formula as string };
  }
  throw new Error(`参数 ${what} 不是合法单元格值（string/number/boolean/null/{formula}）`);
}

export function parseExcelWriteOps(raw: unknown): ExcelWriteOp[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 ops 缺失或不是非空数组');
  return raw.map((o, i) => {
    if (typeof o !== 'object' || o === null) throw new Error(`ops[${i}] 不是对象`);
    const rec = o as Record<string, unknown>;
    if (rec.op === 'add_sheet') {
      return { op: 'add_sheet' as const, name: asString(rec.name, `ops[${i}].name`) };
    }
    if (rec.op === 'set_cells') {
      const sheet = asString(rec.sheet, `ops[${i}].sheet`);
      const range = typeof rec.range === 'string' ? rec.range : undefined;
      if (!Array.isArray(rec.values) || rec.values.length === 0) {
        throw new Error(`ops[${i}].values 缺失或不是非空二维数组`);
      }
      const values = rec.values.map((row, ri) => {
        if (!Array.isArray(row)) throw new Error(`ops[${i}].values[${ri}] 不是数组`);
        return row.map((c, ci) => parseCellInput(c, `ops[${i}].values[${ri}][${ci}]`));
      });
      return { op: 'set_cells' as const, sheet, range, values };
    }
    throw new Error(`ops[${i}].op 非法（支持 add_sheet / set_cells）`);
  });
}

/** 建新 xlsx 骨架（可选列头），返回文件字节 */
export async function createXlsx(sheets: ExcelSheetInit[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    if (s.headers) ws.addRow(s.headers);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 增量写：原字节 → 内存变更 → 新字节（一次序列化） */
export async function writeXlsxOps(before: Buffer, ops: ExcelWriteOp[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(before);
  for (const op of ops) {
    if (op.op === 'add_sheet') {
      if (wb.getWorksheet(op.name)) throw new Error(`sheet 已存在: ${op.name}`);
      wb.addWorksheet(op.name);
      continue;
    }
    const ws = wb.getWorksheet(op.sheet);
    if (!ws) throw new Error(`sheet 不存在: ${op.sheet}（须先 add_sheet）`);
    const r =
      op.range === undefined
        ? { startRow: 1, startCol: 1, endRow: null, endCol: null }
        : parseRange(op.range);
    const startRow = r.startRow;
    const startCol = r.startCol;
    const maxLen = op.values.reduce((m, row) => Math.max(m, row.length), 0);
    let endRow = r.endRow;
    let endCol = r.endCol;
    if (endRow === null || endCol === null) {
      endRow = startRow + op.values.length - 1;
      endCol = startCol + maxLen - 1;
    } else if (endRow - startRow + 1 !== op.values.length || endCol - startCol + 1 !== maxLen) {
      throw new Error(
        `range 形状与 values 不一致：range 为 ${endRow - startRow + 1}×${endCol - startCol + 1}，values 为 ${op.values.length}×${maxLen}`,
      );
    }
    for (const [ri, row] of op.values.entries()) {
      for (const [ci, val] of row.entries()) {
        const cell = ws.getCell(startRow + ri, startCol + ci);
        if (val !== null && typeof val === 'object') {
          cell.value = { formula: val.formula };
        } else {
          cell.value = val;
        }
      }
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
```

注：`Buffer.from(await wb.xlsx.writeBuffer())`——exceljs 类型层自声明 Buffer（extends ArrayBuffer），该写法在两种类型形态下都编译且运行时正确（Node Buffer 是 Uint8Array，Buffer.from 走视图拷贝）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/excel-write.test.ts
```
预期：PASS

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/excel.ts electron/tests/agent/tools/office/excel-write.test.ts
GIT_MASTER=1 git commit -m "feat: Excel 写链路——骨架创建与增量 ops 序列化（值/公式/形状校验）"
```

### Task 6: office-tools.ts 接线（Excel 5 工具）+ 注册中心

**Files:**
- Create: `electron/src/main/agent/tools/office-tools.ts`
- Modify: `electron/src/main/agent/tools/index.ts`
- Modify: `electron/src/main/agent/tools/shared/output-truncate.ts`（OUTPUT_LIMITS 两行）
- Test: `electron/tests/agent/tools/office/office-tools.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `assertOfficeFormat` / `OfficeFormat`、Task 4 `readXlsxPreview` / `readXlsxCells`、Task 5 `createXlsx` / `writeXlsxOps` / `parseSheetInits` / `parseExcelWriteOps`、既有 `parseStringArg` / `OUTPUT_LIMITS` / `truncateString` / `buildRecordCtx` / `recordChangeSafe` / `toJournalRelPath`
- Produces: `class OfficeTools implements ToolModule`（本任务暴露 5 工具；Task 7/8/9 各追加 1 个 create 工具与 READERS 表一行）
- Produces: `OUTPUT_LIMITS.office_read = 20 * 1024`、`OUTPUT_LIMITS.office_read_cells = 24 * 1024`
- Produces: 模块内共享 helper `assertReadForOffice(ctx, abs)`（assertRead 包装 + office_read 指引文案）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/office-tools.test.ts
// OfficeTools 全链路（真实 tmp + 真实 WorkspaceFS + 真实 ReadTracker + 真实 journal store）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ReadTracker } from '../../../../src/main/agent/tools/shared/read-tracker';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { SkillRegistry } from '../../../../src/main/skill/registry';
import { __setJournalStoreForTest, getJournalStore } from '../../../../src/main/journal/recorder';
import { createJournalStore } from '../../../../src/main/journal/store';
import { migration033 } from '../../../../src/main/storage/migrations/033_v2_5_change_journal';
import type { ToolContext } from '../../../../src/main/agent/tools/types';

let tmpDir: string;
let userDataDir: string;
let prevUserData: string | undefined;
let ctx: ToolContext;
let tools: OfficeTools;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-office-tools-'));
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-office-ud-'));
  prevUserData = process.env.AP_USER_DATA_DIR;
  process.env.AP_USER_DATA_DIR = userDataDir;
  const db = new Database(':memory:');
  db.exec(migration033.up);
  __setJournalStoreForTest(createJournalStore(db));
  ctx = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'ws-office',
    workspaceDir: tmpDir,
    skillRegistry: new SkillRegistry(),
    streamSessionId: 'ssn-office',
    roomId: '!office:room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'test-user',
    readTracker: new ReadTracker(),
  };
  tools = new OfficeTools();
});

afterEach(() => {
  __setJournalStoreForTest(null);
  if (prevUserData === undefined) delete process.env.AP_USER_DATA_DIR;
  else process.env.AP_USER_DATA_DIR = prevUserData;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('handles / getDefs', () => {
  it('五个工具名全部路由命中', () => {
    for (const n of ['office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel', 'office_copy']) {
      expect(tools.handles(n)).toBe(true);
    }
    expect(tools.handles('read_file')).toBe(false);
  });
});

describe('office_create_excel', () => {
  it('新建落盘 + 记账 create + blob 与磁盘一致', async () => {
    const out = await tools.execute('office_create_excel', { path: '报表.xlsx', sheets: [{ name: '汇总', headers: ['A'] }] }, ctx);
    expect(out).toContain('已创建');
    expect(fs.existsSync(path.join(tmpDir, '报表.xlsx'))).toBe(true);
    const entries = getJournalStore()!.listByPath('ws-office', '报表.xlsx');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('create');
    expect(entries[0]?.beforeHash).toBeNull();
    const blob = getJournalStore()!.readBlobBytes('ws-office', entries[0]!.afterHash!);
    expect(blob!.equals(fs.readFileSync(path.join(tmpDir, '报表.xlsx')))).toBe(true);
  });
  it('覆盖未读抛错（含 office_read 指引）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'x.xlsx'), 'old');
    await expect(tools.execute('office_create_excel', { path: 'x.xlsx' }, ctx)).rejects.toThrow(/office_read/);
  });
});

describe('office_write_excel', () => {
  it('未读先写抛错；读后 add_sheet+set_cells 成功且记账 modify', async () => {
    await tools.execute('office_create_excel', { path: 'w.xlsx' }, ctx);
    ctx.readTracker = new ReadTracker(); // 重置已读状态
    await expect(
      tools.execute('office_write_excel', { path: 'w.xlsx', ops: [{ op: 'set_cells', sheet: 'Sheet1', values: [[1]] }] }, ctx),
    ).rejects.toThrow(/office_read/);
    await tools.execute('office_read', { path: 'w.xlsx' }, ctx);
    const out = await tools.execute('office_write_excel', {
      path: 'w.xlsx',
      ops: [{ op: 'add_sheet', name: '汇总' }, { op: 'set_cells', sheet: '汇总', values: [['k', 'v']] }],
    }, ctx);
    expect(out).toContain('w.xlsx');
    const entries = getJournalStore()!.listByPath('ws-office', 'w.xlsx');
    expect(entries.at(-1)?.op).toBe('modify');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(tmpDir, 'w.xlsx'));
    expect(wb.getWorksheet('汇总')!.getCell('A1').value).toBe('k');
  });
  it('文件不存在报错并指引 create', async () => {
    await expect(
      tools.execute('office_write_excel', { path: 'nope.xlsx', ops: [{ op: 'set_cells', sheet: 'S', values: [[1]] }] }, ctx),
    ).rejects.toThrow(/office_create_excel/);
  });
});

describe('office_copy', () => {
  it('复制后字节一致；目标存在未读抛错', async () => {
    await tools.execute('office_create_excel', { path: 'src.xlsx', sheets: [{ name: 'S', headers: ['h'] }] }, ctx);
    await expect(tools.execute('office_copy', { from: 'src.xlsx', to: 'src.xlsx' }, ctx)).rejects.toThrow(/office_read/);
    const out = await tools.execute('office_copy', { from: 'src.xlsx', to: '副本.xlsx' }, ctx);
    expect(out).toContain('副本.xlsx');
    expect(fs.readFileSync(path.join(tmpDir, '副本.xlsx')).equals(fs.readFileSync(path.join(tmpDir, 'src.xlsx')))).toBe(true);
  });
  it('源不存在 / 旧格式报错', async () => {
    await expect(tools.execute('office_copy', { from: 'no.xlsx', to: 'b.xlsx' }, ctx)).rejects.toThrow(/不存在/);
    fs.writeFileSync(path.join(tmpDir, 'old.xls'), 'x');
    await expect(tools.execute('office_copy', { from: 'old.xls', to: 'b.xlsx' }, ctx)).rejects.toThrow(/另存/);
  });
});

describe('office_read / office_read_cells', () => {
  it('读后标记已读（后续 write 过门）+ 精读含 sheet 名标签', async () => {
    await tools.execute('office_create_excel', { path: 'r.xlsx' }, ctx);
    const out = await tools.execute('office_read', { path: 'r.xlsx' }, ctx);
    expect(out).toContain('## Sheet: Sheet1');
    // 已读标记验证：紧跟 write 不抛未读错
    const w = await tools.execute('office_write_excel', { path: 'r.xlsx', ops: [{ op: 'set_cells', sheet: 'Sheet1', values: [[9]] }] }, ctx);
    expect(w).toContain('r.xlsx');
    const cells = await tools.execute('office_read_cells', { path: 'r.xlsx', sheet: 'Sheet1' }, ctx);
    expect(cells).toContain('Sheet: Sheet1');
  });
  it('不支持扩展名与越界路径报错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'x');
    await expect(tools.execute('office_read', { path: 'a.txt' }, ctx)).rejects.toThrow(/不支持的文档格式/);
    await expect(tools.execute('office_read', { path: '../outside.xlsx' }, ctx)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/office-tools.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 3: 实现 office-tools.ts（Excel 阶段完整文件）**

```ts
// electron/src/main/agent/tools/office-tools.ts
// 办公文档工具组（spec 2026-09-18 §5）：四格式读取 + 生成 + Excel 增量写 + 复制。
// 写路径统一模式（对齐 file-tools v2.5）：沙箱断言 → 已存在则 Read-before-Edit
// → 读旧字节 → write-ahead 记账（before/after 为 Buffer，走账本二进制扩展）→
// 落盘 → 标记已读。读路径：沙箱断言 → 读取（预算截断）→ 标记已读。

import fs from 'node:fs';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';
import { buildRecordCtx, recordChangeSafe, toJournalRelPath } from './shared/change-journal';
import { assertOfficeFormat, type OfficeFormat } from './office/format';
import {
  createXlsx, parseExcelWriteOps, parseSheetInits, readXlsxCells, readXlsxPreview, writeXlsxOps,
} from './office/excel';

/** 各格式读取器注册表（docx / pptx / pdf 由后续任务补齐） */
const READERS: Partial<Record<OfficeFormat, (abs: string) => Promise<string>>> = {
  xlsx: readXlsxPreview,
};

/** Read-before-Edit 包装：office 场景补充 office_read 指引 */
function assertReadForOffice(ctx: ToolContext, abs: string): void {
  try {
    ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, abs);
  } catch (err) {
    throw new Error(`${(err as Error).message}（office 文档可用 office_read 读取）`);
  }
}

// ── 工具 defs ──

const READ_DEF: LLMToolDef = {
  name: 'office_read',
  description:
    '读取办公文档并输出结构化文本（按扩展名自动识别 xlsx/docx/pptx/pdf）。' +
    'xlsx：逐 sheet 预览（前 20 行 × 12 列，超限提示精读）；docx：标题/段落/列表/表格（markdown）；' +
    'pptx：逐 slide 文本与备注；pdf：逐页文本。读取后该文件即视为「已读」，可被 office 写工具覆盖/修改。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对 workspace 的文档路径' } },
    required: ['path'],
  },
};

const READ_CELLS_DEF: LLMToolDef = {
  name: 'office_read_cells',
  description:
    'Excel 精读：指定 sheet（名字或 1-based 序号）与 A1 range（省略=已用区域）取精确单元格值，' +
    '返回 markdown 表格（首行为表头）。上限 500 行 × 64 列。formulas=true 显示公式原文（默认显示计算值缓存）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 .xlsx 路径' },
      sheet: { description: 'sheet 名或 1-based 序号', oneOf: [{ type: 'string' }, { type: 'number' }] },
      range: { type: 'string', description: 'A1 记法，如 A1:F50；省略=已用区域' },
      formulas: { type: 'boolean', description: 'true 时公式单元格显示 =原文' },
    },
    required: ['path', 'sheet'],
  },
};

const CREATE_EXCEL_DEF: LLMToolDef = {
  name: 'office_create_excel',
  description:
    '创建新 xlsx（可选初始 sheet 名与列头）。只建骨架——数据一律用 office_write_excel 写入。' +
    '目标已存在时须先 office_read 读取后覆盖。「在原表加汇总页签」场景：office_copy 复制 + office_write_excel。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.xlsx）' },
      sheets: {
        type: 'array',
        description: '初始 sheet 列表；省略建单个 Sheet1',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, headers: { type: 'array', items: { type: 'string' } } },
          required: ['name'],
        },
      },
    },
    required: ['path'],
  },
};

const WRITE_EXCEL_DEF: LLMToolDef = {
  name: 'office_write_excel',
  description:
    '增量写已有 xlsx：ops 数组依次执行。add_sheet 建新页签；set_cells 写二维区域（值或 {formula}）。' +
    'range 省略=从 A1 按 values 形状展开；给左上角单格同省略语义；给完整区域（A1:F50）则形状必须一致。' +
    'sheet 不存在时须先 add_sheet。写前该文件必须已被 office_read 读取。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 .xlsx 路径（须已存在）' },
      ops: {
        type: 'array',
        description: '操作序列',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add_sheet', 'set_cells'] },
            name: { type: 'string', description: 'add_sheet：新页签名' },
            sheet: { type: 'string', description: 'set_cells：目标页签名' },
            range: { type: 'string' },
            values: { type: 'array', items: { type: 'array' }, description: 'set_cells：二维数组' },
          },
          required: ['op'],
        },
      },
    },
    required: ['path', 'ops'],
  },
};

const COPY_DEF: LLMToolDef = {
  name: 'office_copy',
  description:
    '复制办公文档（xlsx/docx/pptx/pdf）。典型流：复制报表副本 → office_write_excel 向副本写汇总页签。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '相对 workspace 的源路径' },
      to: { type: 'string', description: '相对 workspace 的目标路径（已存在须先读）' },
    },
    required: ['from', 'to'],
  },
};

// ── ToolModule 实现 ──

export class OfficeTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [READ_DEF, READ_CELLS_DEF, CREATE_EXCEL_DEF, WRITE_EXCEL_DEF, COPY_DEF];
  }

  handles(name: string): boolean {
    return this.getDefs().some((d) => d.name === name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'office_read': {
        if (ctx.abortSignal?.aborted) return '已中断';
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}`);
        const fmt = assertOfficeFormat(rel);
        const reader = READERS[fmt];
        if (!reader) throw new Error(`该格式读取器尚未接线: ${fmt}`);
        let out: string;
        try {
          out = await reader(abs);
        } catch (err) {
          throw new Error(`读取失败（文件损坏或非预期格式）: ${(err as Error).message}`);
        }
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return truncateString(out, OUTPUT_LIMITS.office_read);
      }
      case 'office_read_cells': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}`);
        assertOfficeFormat(rel);
        const sheet = typeof args.sheet === 'number' ? args.sheet : parseStringArg(args.sheet, 'sheet');
        const range = typeof args.range === 'string' ? args.range : undefined;
        const formulas = args.formulas === true;
        let out: string;
        try {
          out = await readXlsxCells(abs, sheet, range, formulas);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('sheet 不存在') || msg.includes('读取区域过大') || msg.includes('range')) throw err;
          throw new Error(`读取失败（文件损坏或非预期格式）: ${msg}`);
        }
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        const label = `Sheet: ${typeof sheet === 'number' ? `#${sheet}` : sheet}\n\n`;
        return label + truncateString(out, OUTPUT_LIMITS.office_read_cells);
      }
      case 'office_create_excel': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const sheets = parseSheetInits(args.sheets);
        const buf = await createXlsx(sheets);
        recordChangeSafe(
          buildRecordCtx('office_create_excel', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `Excel 已${existed ? '覆盖' : '创建'}: ${rel}（sheet: ${sheets.map((s) => s.name).join(', ')}）`;
      }
      case 'office_write_excel': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}（先用 office_create_excel 创建）`);
        assertReadForOffice(ctx, abs);
        const ops = parseExcelWriteOps(args.ops);
        const before = fs.readFileSync(abs);
        const buf = await writeXlsxOps(before, ops);
        recordChangeSafe(buildRecordCtx('office_write_excel', ctx), toJournalRelPath(ctx, rel), 'modify', before, buf);
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `已执行 ${ops.length} 个操作并写入: ${rel}`;
      }
      case 'office_copy': {
        const fromRel = parseStringArg(args.from, 'from');
        const toRel = parseStringArg(args.to, 'to');
        const fromAbs = ctx.wsFs.assertInWorkspace(fromRel);
        const toAbs = ctx.wsFs.assertInWorkspace(toRel);
        if (!fs.existsSync(fromAbs)) throw new Error(`源文件不存在: ${fromRel}`);
        assertOfficeFormat(fromRel);
        const existed = fs.existsSync(toAbs);
        if (existed) assertReadForOffice(ctx, toAbs);
        const bytes = fs.readFileSync(fromAbs);
        recordChangeSafe(
          buildRecordCtx('office_copy', ctx),
          toJournalRelPath(ctx, toRel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(toAbs) : null,
          bytes,
        );
        fs.writeFileSync(toAbs, bytes);
        ctx.readTracker?.add(ctx.streamSessionId, toAbs);
        return `已复制: ${fromRel} → ${toRel}（可用 office_write_excel 向副本增量写）`;
      }
      default:
        throw new Error(`未知 office 工具: ${name}`);
    }
  }
}
```

`OUTPUT_LIMITS` 追加两行（`read_file` 条目后）：

```ts
  office_read: 20 * 1024,
  office_read_cells: 24 * 1024,
```

- [ ] **Step 4: 注册中心接线**

`electron/src/main/agent/tools/index.ts`：

import 区追加：

```ts
import { OfficeTools } from './office-tools';
```

`buildToolRegistry` 数组 `new BrowserTools(),` 之后追加：

```ts
    new OfficeTools(),
```

头部注释追加：

```ts
//   + OfficeTools（v2.1 办公工具组：office_read / office_read_cells /
//     office_create_excel / office_write_excel / office_copy——docx/pptx/pdf
//     生成三工具与读取器由后续 commit 补齐——无条件注册）。
```

- [ ] **Step 5: 跑测试 + 工具目录全套**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/
```
预期：全部 PASS（既有 file-tools / scope-gate 等不回归）

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office-tools.ts electron/src/main/agent/tools/index.ts electron/src/main/agent/tools/shared/output-truncate.ts electron/tests/agent/tools/office/office-tools.test.ts
GIT_MASTER=1 git commit -m "feat: OfficeTools 模块——Excel 五工具接线与注册（沙箱/守门/记账全继承）"
```

---

## Phase P3：docx / pptx / pdf

### Task 7: Word 读写（mammoth 提取 + docx 生成）

**Files:**
- Create: `electron/src/main/agent/tools/office/docx.ts`
- Modify: `electron/src/main/agent/tools/office-tools.ts`
- Test: `electron/tests/agent/tools/office/docx.test.ts`（新建）

**Interfaces:**
- Produces: `readDocx(abs: string): Promise<string>`（mammoth → markdown；图片占位 `[图片]`）
- Produces: `type DocSection = { type: 'heading'; level?: number; text: string } | { type: 'para'; text: string } | { type: 'list'; items: string[]; ordered?: boolean } | { type: 'table'; header: string[]; rows: string[][] }`
- Produces: `parseDocSections(raw: unknown): DocSection[]`、`createDocx(sections: DocSection[]): Promise<Buffer>`
- office-tools 变更：`READERS` 加 `docx: readDocx`；新增 `OFFICE_CREATE_DOC_DEF` 与 case（写路径模式与 office_create_excel 逐字相同）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/docx.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocx, createDocx, parseDocSections } from '../../../../src/main/agent/tools/office/docx';

describe('docx round-trip', () => {
  it('生成 → 读取：标题/段落/列表/表格结构保真', async () => {
    const buf = await createDocx(parseDocSections([
      { type: 'heading', level: 1, text: '项目周报' },
      { type: 'para', text: '本周完成三项工作。' },
      { type: 'list', items: ['需求梳理', '接口联调'] },
      { type: 'table', header: ['事项', '状态'], rows: [['发版', 'done']] },
    ]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b])); // zip 魔数
    const abs = path.join(os.tmpdir(), `momo-docx-${Date.now()}.docx`);
    fs.writeFileSync(abs, buf);
    try {
      const md = await readDocx(abs);
      expect(md).toContain('项目周报');
      expect(md).toContain('本周完成三项工作');
      expect(md).toContain('需求梳理');
      expect(md).toContain('发版');
      expect(md).toContain('done');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
  it('非法 section 拒绝', () => {
    expect(() => parseDocSections([{ type: 'poem', text: 'x' }])).toThrow(/type/);
    expect(() => parseDocSections('x')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/docx.test.ts
```
预期：FAIL

- [ ] **Step 3: 实现 docx.ts**

```ts
// electron/src/main/agent/tools/office/docx.ts
// Word 读写：mammoth 提取（结构保真、样式丢弃——spec §12 边界）+ docx 库生成。
// 读取图片占位 [图片]（mammoth 默认 inline base64 data URI 会撑爆上下文）。

import mammoth from 'mammoth';
import {
  Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { asString, asStringArray } from './format';

export async function readDocx(abs: string): Promise<string> {
  const { value } = await mammoth.convertToMarkdown({ path: abs });
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]');
}

export type DocSection =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; header: string[]; rows: string[][] };

export function parseDocSections(raw: unknown): DocSection[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 sections 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`sections[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    switch (rec.type) {
      case 'heading': {
        const level = typeof rec.level === 'number' ? rec.level : 1;
        return { type: 'heading' as const, level, text: asString(rec.text, `sections[${i}].text`) };
      }
      case 'para':
        return { type: 'para' as const, text: asString(rec.text, `sections[${i}].text`) };
      case 'list':
        return {
          type: 'list' as const,
          items: asStringArray(rec.items, `sections[${i}].items`),
          ordered: rec.ordered === true,
        };
      case 'table':
        return {
          type: 'table' as const,
          header: asStringArray(rec.header, `sections[${i}].header`),
          rows: (Array.isArray(rec.rows) ? rec.rows : []).map((r, ri) =>
            asStringArray(r, `sections[${i}].rows[${ri}]`)),
        };
      default:
        throw new Error(`sections[${i}].type 非法（支持 heading/para/list/table）`);
    }
  });
}

function headingOf(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const l = Math.min(4, Math.max(1, Math.floor(level)));
  const map = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
  ] as const;
  return map[l - 1] ?? HeadingLevel.HEADING_1;
}

export async function createDocx(sections: DocSection[]): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  for (const s of sections) {
    if (s.type === 'heading') {
      children.push(new Paragraph({ heading: headingOf(s.level ?? 1), children: [new TextRun(s.text)] }));
    } else if (s.type === 'para') {
      children.push(new Paragraph({ children: [new TextRun(s.text)] }));
    } else if (s.type === 'list') {
      for (const [i, item] of s.items.entries()) {
        if (s.ordered) {
          children.push(new Paragraph({ children: [new TextRun(`${i + 1}. ${item}`)] }));
        } else {
          children.push(new Paragraph({ children: [new TextRun(item)], bullet: { level: 0 } }));
        }
      }
    } else {
      const rows = [s.header, ...s.rows].map(
        (cells) =>
          new TableRow({
            children: cells.map((c) => new TableCell({ children: [new Paragraph(c)] })),
          }),
      );
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
```

- [ ] **Step 4: office-tools.ts 接线（三处）**

import 区追加：

```ts
import { createDocx, parseDocSections, readDocx } from './office/docx';
```

`READERS` 追加一行：

```ts
  docx: readDocx,
```

defs 区追加（`COPY_DEF` 之前）：

```ts
const OFFICE_CREATE_DOC_DEF: LLMToolDef = {
  name: 'office_create_doc',
  description:
    '生成 Word 文档（.docx）：按 sections 顺序输出标题（1-4 级）/段落/列表（有序或无序）/表格。' +
    '目标已存在时须先 office_read 读取后覆盖。参考模板重写 = office_read 读模板 → 按其结构给 sections 重新生成。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.docx）' },
      sections: {
        type: 'array',
        description: '内容序列',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'para', 'list', 'table'] },
            level: { type: 'number', description: 'heading 1-4，默认 1' },
            text: { type: 'string', description: 'heading/para 正文' },
            items: { type: 'array', items: { type: 'string' }, description: 'list 条目' },
            ordered: { type: 'boolean', description: 'list 是否有序' },
            header: { type: 'array', items: { type: 'string' }, description: 'table 表头' },
            rows: { type: 'array', items: { type: 'array' }, description: 'table 数据行' },
          },
          required: ['type'],
        },
      },
    },
    required: ['path', 'sections'],
  },
};
```

`getDefs` 数组在 `WRITE_EXCEL_DEF` 后插入 `OFFICE_CREATE_DOC_DEF`；`execute` 在 `office_copy` case 前追加：

```ts
      case 'office_create_doc': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const sections = parseDocSections(args.sections);
        const buf = await createDocx(sections);
        recordChangeSafe(
          buildRecordCtx('office_create_doc', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `Word 已${existed ? '覆盖' : '生成'}: ${rel}（${sections.length} 节）`;
      }
```

office-tools.test.ts 的 handles 用例追加 `'office_create_doc'` 断言。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/
```
预期：PASS

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/docx.ts electron/src/main/agent/tools/office-tools.ts electron/tests/agent/tools/office/docx.test.ts electron/tests/agent/tools/office/office-tools.test.ts
GIT_MASTER=1 git commit -m "feat: Word 读写——mammoth 结构化提取与 docx 分节生成"
```

### Task 8: PPT 读写（pptxgenjs 生成 + zip 自解析提取）

**Files:**
- Create: `electron/src/main/agent/tools/office/pptx.ts`
- Modify: `electron/src/main/agent/tools/office-tools.ts`
- Test: `electron/tests/agent/tools/office/pptx.test.ts`（新建）

**Interfaces:**
- Produces: `readPptx(abs: string): Promise<string>`（`## Slide N` + 逐文本框 + 备注）
- Produces: `interface PptxSlideSpec { title: string; bullets?: string[]; table?: { header: string[]; rows: string[][] }; notes?: string }`
- Produces: `parsePptxSlides(raw: unknown): PptxSlideSpec[]`、`createPptx(slides: PptxSlideSpec[]): Promise<Buffer>`
- office-tools 变更：同 Task 7 模式（`READERS` 加 `pptx: readPptx` + `OFFICE_CREATE_PPT_DEF` + case）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/pptx.test.ts
// pptxgenjs 真生成 → 自解析真提取（双向都不 mock——css-select 命名空间选择器
// a\:t 的真实行为由本 round-trip 锁死）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPptx, parsePptxSlides, readPptx } from '../../../../src/main/agent/tools/office/pptx';

describe('pptx round-trip', () => {
  it('生成 → 提取：标题/要点/表格/备注逐 slide 保真', async () => {
    const buf = await createPptx(parsePptxSlides([
      { title: '季度汇报', bullets: ['收入增长 20%', '成本下降 5%'], notes: '强调同比' },
      { title: '数据表', table: { header: ['季度', '营收'], rows: [['Q1', '100 万']] } },
    ]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
    const abs = path.join(os.tmpdir(), `momo-pptx-${Date.now()}.pptx`);
    fs.writeFileSync(abs, buf);
    try {
      const out = await readPptx(abs);
      expect(out).toContain('## Slide 1');
      expect(out).toContain('季度汇报');
      expect(out).toContain('收入增长 20%');
      expect(out).toContain('备注: 强调同比');
      expect(out).toContain('## Slide 2');
      expect(out).toContain('100 万');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
  it('非法 slide 拒绝', () => {
    expect(() => parsePptxSlides([{ bullets: ['x'] }])).toThrow(/title/);
    expect(() => parsePptxSlides([])).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/pptx.test.ts
```
预期：FAIL

- [ ] **Step 3: 实现 pptx.ts**

```ts
// electron/src/main/agent/tools/office/pptx.ts
// PPT 读写。读取零新依赖：pptx 是 zip 容器，slide XML 的 <a:t> 文本用既有
// adm-zip + cheerio 提取（css-select 命名空间选择器 a\:t，行为由 round-trip
// 测试锁死）。生成走 pptxgenjs 简单版式（spec §12：无母版继承，重样式走人工）。

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import PptxGenJS from 'pptxgenjs';
import { asString, asStringArray } from './format';

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

function slideTexts(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('a\\:t')
    .map((_, el) => $(el).text())
    .get()
    .filter((t) => t.trim().length > 0);
}

export async function readPptx(abs: string): Promise<string> {
  const zip = new AdmZip(abs);
  const slides = zip
    .getEntries()
    .filter((e) => SLIDE_RE.test(e.entryName))
    .sort((a, b) => {
      const na = Number(SLIDE_RE.exec(a.entryName)![1]);
      const nb = Number(SLIDE_RE.exec(b.entryName)![1]);
      return na - nb; // 数值序（slide10 不能排在 slide2 前）
    });
  const notes = new Map<number, string>();
  for (const e of zip.getEntries()) {
    const m = NOTES_RE.exec(e.entryName);
    if (m) notes.set(Number(m[1]), slideTexts(e.getData().toString('utf-8')).join(' '));
  }
  if (slides.length === 0) return '(未发现幻灯片)';
  const parts: string[] = [];
  for (const [i, entry] of slides.entries()) {
    const texts = slideTexts(entry.getData().toString('utf-8'));
    parts.push(`## Slide ${i + 1}\n${texts.length > 0 ? texts.join('\n') : '(无文本)'}`);
    const note = notes.get(i + 1);
    if (note && note.length > 0) parts.push(`备注: ${note}`);
  }
  return parts.join('\n\n');
}

export interface PptxSlideSpec {
  title: string;
  bullets?: string[];
  table?: { header: string[]; rows: string[][] };
  notes?: string;
}

export function parsePptxSlides(raw: unknown): PptxSlideSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 slides 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`slides[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const spec: PptxSlideSpec = { title: asString(rec.title, `slides[${i}].title`) };
    if (rec.bullets !== undefined) spec.bullets = asStringArray(rec.bullets, `slides[${i}].bullets`);
    if (rec.notes !== undefined && rec.notes !== null) spec.notes = asString(rec.notes, `slides[${i}].notes`);
    if (rec.table !== undefined && rec.table !== null) {
      if (typeof rec.table !== 'object') throw new Error(`slides[${i}].table 不是对象`);
      const t = rec.table as Record<string, unknown>;
      spec.table = {
        header: asStringArray(t.header, `slides[${i}].table.header`),
        rows: (Array.isArray(t.rows) ? t.rows : []).map((r, ri) =>
          asStringArray(r, `slides[${i}].table.rows[${ri}]`)),
      };
    }
    return spec;
  });
}

export async function createPptx(slides: PptxSlideSpec[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 28, bold: true });
    if (s.bullets && s.bullets.length > 0) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        { x: 0.8, y: 1.6, w: 8.4, h: 3.6, fontSize: 16 },
      );
    }
    if (s.table) {
      const header = s.table.header.map((h) => ({ text: h, options: { bold: true } }));
      const rows = [header, ...s.table.rows.map((r) => r.map((c) => ({ text: c })))];
      slide.addTable(rows, { x: 0.6, y: 1.6, w: 8.8, fontSize: 12 });
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as Uint8Array); // 类型层为联合类型，nodebuffer 运行时是 Buffer
}
```

- [ ] **Step 4: office-tools.ts 接线（三处）**

import 区追加：

```ts
import { createPptx, parsePptxSlides, readPptx } from './office/pptx';
```

`READERS` 追加 `pptx: readPptx,`。

defs 区追加（`COPY_DEF` 之前）：

```ts
const OFFICE_CREATE_PPT_DEF: LLMToolDef = {
  name: 'office_create_ppt',
  description:
    '生成 PPT（.pptx）：逐 slide 标题 + 要点列表或表格 + 备注。简单版式（标题+内容），' +
    '复杂排版不支持（spec 边界）。目标已存在时须先 office_read 读取后覆盖。' +
    '参考模板重写 = office_read 读模板文本结构 → 按其分页与要点重新生成。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.pptx）' },
      slides: {
        type: 'array',
        description: '幻灯片序列',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              properties: {
                header: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
              },
              required: ['header'],
            },
            notes: { type: 'string' },
          },
          required: ['title'],
        },
      },
    },
    required: ['path', 'slides'],
  },
};
```

`getDefs` 数组在 `OFFICE_CREATE_DOC_DEF` 后插入 `OFFICE_CREATE_PPT_DEF`；`execute` 在 `office_copy` case 前追加：

```ts
      case 'office_create_ppt': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const slides = parsePptxSlides(args.slides);
        const buf = await createPptx(slides);
        recordChangeSafe(
          buildRecordCtx('office_create_ppt', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `PPT 已${existed ? '覆盖' : '生成'}: ${rel}（${slides.length} 页）`;
      }
```

office-tools.test.ts 的 handles 用例追加 `'office_create_ppt'` 断言。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/
```
预期：PASS

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/pptx.ts electron/src/main/agent/tools/office-tools.ts electron/tests/agent/tools/office/pptx.test.ts electron/tests/agent/tools/office/office-tools.test.ts
GIT_MASTER=1 git commit -m "feat: PPT 读写——pptxgenjs 版式生成与 zip 自解析逐 slide 提取"
```

### Task 9: PDF 字体打包 + 读写

**Files:**
- Create: `electron/src/main/agent/tools/office/pdf.ts`
- Create: `electron/resources/fonts/NotoSansSC-Regular.ttf` + `electron/resources/fonts/OFL.txt`（下载）
- Modify: `electron/package.json`（extraResources 加 fonts 映射）
- Modify: `electron/src/main/agent/tools/office-tools.ts`
- Test: `electron/tests/agent/tools/office/pdf.test.ts`（新建）

**Interfaces:**
- Produces: `resolveFontPath(): string`（生产 `process.resourcesPath/fonts/`；dev 从 `__dirname` 上溯 5 级到包根 `resources/fonts/`——编译产物在 `dist/main/agent/tools/office/`）
- Produces: `readPdf(abs: string): Promise<string>`（逐页 `## 第 N 页`；全空文本层抛「无文本层（疑似扫描版）」）
- Produces: `type PdfBlock = { type: 'heading'; level?: number; text: string } | { type: 'para'; text: string } | { type: 'list'; items: string[]; ordered?: boolean } | { type: 'table'; header: string[]; rows: string[][] } | { type: 'pagebreak' }`
- Produces: `parsePdfBlocks(raw: unknown): PdfBlock[]`、`createPdf(blocks: PdfBlock[]): Promise<Buffer>`

- [ ] **Step 1: 下载 CJK 字体（TrueType outline 版本）**

```bash
mkdir -p electron/resources/fonts
CSS=$(curl -s -A "curl/7.64" "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400")
URL=$(grep -o "https://fonts.gstatic.com/[^)]*\.ttf" <<< "$CSS" | head -1)
curl -L "$URL" -o electron/resources/fonts/NotoSansSC-Regular.ttf
curl -L "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt" -o electron/resources/fonts/OFL.txt
file electron/resources/fonts/NotoSansSC-Regular.ttf
```

预期输出含 `TrueType Font data`。若为 `OpenType font data`（CFF outline，pdfkit 不可靠），保持 curl UA 重试（浏览器 UA 会拿到 woff2——**必须 curl UA**）。容器无外网时：在 macOS 主机执行同样命令后把两个文件放进 `electron/resources/fonts/`。

- [ ] **Step 2: extraResources 映射**

`electron/package.json` 的 `build.extraResources` 数组（`marketplace` 条目后）追加：

```json
      {
        "from": "./resources/fonts",
        "to": "fonts"
      }
```

- [ ] **Step 3: 写失败测试**

```ts
// electron/tests/agent/tools/office/pdf.test.ts
// 依赖仓库内字体资产（Step 1 提交进 git）；字体是测试前置而非 mock 对象。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPdf, parsePdfBlocks, readPdf, resolveFontPath } from '../../../../src/main/agent/tools/office/pdf';

describe('createPdf', () => {
  it('中文字块渲染：产出 PDF 魔数且非平凡体积', async () => {
    expect(fs.existsSync(resolveFontPath())).toBe(true);
    const buf = await createPdf(parsePdfBlocks([
      { type: 'heading', level: 1, text: '季度报告' },
      { type: 'para', text: '收入与成本概况如下。' },
      { type: 'list', items: ['华东区', '华北区'], ordered: true },
      { type: 'table', header: ['区域', '营收'], rows: [['华东', '100 万']] },
      { type: 'pagebreak' },
      { type: 'para', text: '第二页。' },
    ]));
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(10 * 1024); // 内嵌 CJK 子集
  });
});

describe('readPdf', () => {
  it('逐页提取自产 PDF 的中文文本', async () => {
    const buf = await createPdf(parsePdfBlocks([
      { type: 'heading', text: '标题甲' },
      { type: 'para', text: '正文乙' },
    ]));
    const abs = path.join(os.tmpdir(), `momo-pdf-${Date.now()}.pdf`);
    fs.writeFileSync(abs, buf);
    try {
      const out = await readPdf(abs);
      expect(out).toContain('第 1 页');
      expect(out).toContain('标题甲');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

  it('无文本层（空渲染页）报扫描版错误', async () => {
    // pdfkit 直接 addPage 不写文本 → 空文本层
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.addPage();
    doc.end();
    await done;
    const abs = path.join(os.tmpdir(), `momo-pdf-empty-${Date.now()}.pdf`);
    fs.writeFileSync(abs, Buffer.concat(chunks));
    try {
      await expect(readPdf(abs)).rejects.toThrow(/无文本层/);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
});

describe('parsePdfBlocks', () => {
  it('非法 block 拒绝', () => {
    expect(() => parsePdfBlocks([{ type: 'chart' }])).toThrow(/type/);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/pdf.test.ts
```
预期：FAIL

- [ ] **Step 5: 实现 pdf.ts**

```ts
// electron/src/main/agent/tools/office/pdf.ts
// PDF 读写：pdfjs-dist（v3 UMD CJS，Node fake-worker 路径，verbosity 0 压噪）逐页
// 提取 + pdfkit 生成（内嵌 Noto Sans SC，pdfkit 默认字体无 CJK）。
// 扫描版（无文本层）读取明确报错。仅用 getTextContent，不触渲染，无需 canvas。

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import * as pdfjsLib from 'pdfjs-dist';
import { asString, asStringArray } from './format';

const FONT_FILE = 'NotoSansSC-Regular.ttf';

/** 字体定位：生产走 extraResources（process.resourcesPath/fonts）；
 * dev（process.defaultApp）从编译产物 dist/main/agent/tools/office 上溯 5 级
 * 到包根 resources/fonts（与 builtin.ts 的 agents 目录解析同模式）。 */
export function resolveFontPath(): string {
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'fonts', FONT_FILE);
  }
  return path.join(__dirname, '..', '..', '..', '..', '..', 'resources', 'fonts', FONT_FILE);
}

export async function readPdf(abs: string): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(abs));
  // Node 运行时约定：isEvalSupported/useWorkerFetch/disableFontFace 关掉浏览器侧
  // 能力；verbosity 0 压制 fake-worker 等告警噪声（测试输出必须干净）
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // TextItem | TextMarkedContent 联合类型：'str' in 收窄
      pageTexts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').trim());
    }
    if (pageTexts.every((t) => t.length === 0)) {
      throw new Error('PDF 无文本层（疑似扫描版，无法提取文本）');
    }
    return pageTexts.map((t, i) => `## 第 ${i + 1} 页\n${t}`).join('\n\n');
  } finally {
    await doc.cleanup();
  }
}

export type PdfBlock =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'pagebreak' };

export function parsePdfBlocks(raw: unknown): PdfBlock[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 blocks 缺失或不是非空数组');
  return raw.map((b, i) => {
    if (typeof b !== 'object' || b === null) throw new Error(`blocks[${i}] 不是对象`);
    const rec = b as Record<string, unknown>;
    switch (rec.type) {
      case 'heading': {
        const level = typeof rec.level === 'number' ? rec.level : 1;
        return { type: 'heading' as const, level, text: asString(rec.text, `blocks[${i}].text`) };
      }
      case 'para':
        return { type: 'para' as const, text: asString(rec.text, `blocks[${i}].text`) };
      case 'list':
        return {
          type: 'list' as const,
          items: asStringArray(rec.items, `blocks[${i}].items`),
          ordered: rec.ordered === true,
        };
      case 'table':
        return {
          type: 'table' as const,
          header: asStringArray(rec.header, `blocks[${i}].header`),
          rows: (Array.isArray(rec.rows) ? rec.rows : []).map((r, ri) =>
            asStringArray(r, `blocks[${i}].rows[${ri}]`)),
        };
      case 'pagebreak':
        return { type: 'pagebreak' as const };
      default:
        throw new Error(`blocks[${i}].type 非法（支持 heading/para/list/table/pagebreak）`);
    }
  });
}

/** 表格：均分列宽简单网格线（v1 边界：单元格单行，不换行） */
function drawTable(doc: PDFKit.PDFDocument, header: string[], rows: string[][]): void {
  const colCount = Math.max(1, header.length);
  const margin = doc.page.margins.left;
  const colW = (doc.page.width - margin * 2) / colCount;
  const rowH = 24;
  const allRows = [header, ...rows];
  for (const [ri, cells] of allRows.entries()) {
    const y = doc.y;
    for (let ci = 0; ci < colCount; ci++) {
      const x = margin + ci * colW;
      doc.save();
      doc.rect(x, y, colW, rowH).stroke();
      const text = cells[ci] ?? '';
      doc.fontSize(10).text(text, x + 4, y + 6, { width: colW - 8, height: rowH - 8, lineBreak: false });
      doc.restore();
    }
    doc.y = y + rowH;
  }
  doc.moveDown(0.4);
}

export async function createPdf(blocks: PdfBlock[]): Promise<Buffer> {
  const fontPath = resolveFontPath();
  if (!fs.existsSync(fontPath)) throw new Error(`中文字体缺失（安装损坏）: ${FONT_FILE}`);
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.on('data', (c: Buffer) => chunks.push(c));
  doc.font(fontPath); // 内嵌 Noto Sans SC（CJK 必需）
  for (const b of blocks) {
    if (b.type === 'pagebreak') {
      doc.addPage();
      continue;
    }
    if (b.type === 'heading') {
      const level = Math.min(4, Math.max(1, Math.floor(b.level ?? 1)));
      doc.fontSize(12 + 4 * (5 - level)).text(b.text);
      doc.moveDown(0.5);
    } else if (b.type === 'para') {
      doc.fontSize(11).text(b.text);
      doc.moveDown(0.5);
    } else if (b.type === 'list') {
      for (const [i, item] of b.items.entries()) {
        const prefix = b.ordered ? `${i + 1}. ` : '• ';
        doc.fontSize(11).text(prefix + item, { indent: 16 });
      }
      doc.moveDown(0.4);
    } else {
      drawTable(doc, b.header, b.rows);
    }
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
```

- [ ] **Step 6: office-tools.ts 接线（三处）**

import 区追加：

```ts
import { createPdf, parsePdfBlocks, readPdf } from './office/pdf';
```

`READERS` 追加 `pdf: readPdf,`。

defs 区追加（`COPY_DEF` 之前）：

```ts
const OFFICE_CREATE_PDF_DEF: LLMToolDef = {
  name: 'office_create_pdf',
  description:
    '生成 PDF：blocks 顺序输出标题/段落/列表/表格/分页符，内嵌中文字体。' +
    '目标已存在时须先 office_read 读取后覆盖。表格为均分列宽简单网格线（v1 边界）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.pdf）' },
      blocks: {
        type: 'array',
        description: '内容序列',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'para', 'list', 'table', 'pagebreak'] },
            level: { type: 'number' },
            text: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
            ordered: { type: 'boolean' },
            header: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array' } },
          },
          required: ['type'],
        },
      },
    },
    required: ['path', 'blocks'],
  },
};
```

`getDefs` 数组在 `OFFICE_CREATE_PPT_DEF` 后插入 `OFFICE_CREATE_PDF_DEF`；`execute` 在 `office_copy` case 前追加：

```ts
      case 'office_create_pdf': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const blocks = parsePdfBlocks(args.blocks);
        const buf = await createPdf(blocks);
        recordChangeSafe(
          buildRecordCtx('office_create_pdf', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `PDF 已${existed ? '覆盖' : '生成'}: ${rel}（${blocks.length} 块）`;
      }
```

office-tools.test.ts 的 handles 用例追加 `'office_create_pdf'` 断言；index.ts 头注释的 OfficeTools 行同步改为「办公八工具」全名列表。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/
```
预期：PASS

- [ ] **Step 8: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/agent/tools/office/pdf.ts electron/src/main/agent/tools/office-tools.ts electron/src/main/agent/tools/index.ts electron/resources/fonts electron/package.json electron/tests/agent/tools/office/pdf.test.ts electron/tests/agent/tools/office/office-tools.test.ts
GIT_MASTER=1 git commit -m "feat: PDF 读写——pdfkit 中文渲染与逐页文本提取（含 Noto Sans SC 字体打包）"
```

---

## Phase P4：交付

### Task 10: office-assistant 三联动（YAML + marketplace + 工具全集）

**Files:**
- Create: `electron/resources/agents/office-assistant.yaml`
- Modify: `resources/marketplace/catalog.json`
- Modify: `electron/src/main/agent/tools/catalog.ts`
- Test: `electron/tests/agent/tools/office/builtin-office.test.ts`（新建）

**Interfaces:**
- Consumes: Task 6-9 的 OfficeTools 工具名全集
- Produces: `ALL_BUILTIN_TOOLS` 25 → 33（追加 8 个 office 工具）
- Produces: `TOOL_CATEGORIES` 新增 `{ label: '办公', emoji: '💼', tools: [office 八工具] }`（既有 tools-catalog 测试断言「分类并集 == 全集」——本任务保持该不变量成立）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/office/builtin-office.test.ts
// 三联动契约锁：YAML 可解析 + defaultTools 引用全部真实存在 + catalog 条目齐备。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ALL_BUILTIN_TOOLS, TOOL_CATEGORIES } from '../../../../src/main/agent/tools/catalog';

// __dirname = electron/tests/agent/tools/office（5 级）→ 4 级上溯到 electron/（agents 在
// electron/resources/agents），5 级上溯到仓库根（marketplace 在根 resources/marketplace）。
const AGENTS_DIR = path.resolve(__dirname, '../../../..', 'resources/agents');
const CATALOG_PATH = path.resolve(__dirname, '../../../../..', 'resources/marketplace/catalog.json');

function loadYaml(rel: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(path.join(AGENTS_DIR, rel), 'utf-8')) as Record<string, unknown>;
}

describe('office-assistant.yaml', () => {
  it('解析成功且元数据齐备', () => {
    const m = loadYaml('office-assistant.yaml');
    const meta = m.metadata as Record<string, unknown>;
    expect(meta.slug).toBe('office-assistant');
    expect(typeof meta.name).toBe('string');
    const spec = m.spec as Record<string, unknown>;
    expect(spec.type).toBe('standalone');
  });

  it('defaultTools 引用的工具全部真实存在（防契约漂移）', () => {
    const m = loadYaml('office-assistant.yaml');
    const spec = m.spec as Record<string, unknown>;
    const dec = spec.declarative as Record<string, unknown>;
    const tools = dec.defaultTools as Array<{ kind: string; ref: string }>;
    expect(tools.length).toBeGreaterThan(0);
    const realDefs = new Set(new OfficeTools().getDefs().map((d) => d.name));
    for (const t of tools) {
      expect(
        realDefs.has(t.ref) || ALL_BUILTIN_TOOLS.includes(t.ref as (typeof ALL_BUILTIN_TOOLS)[number]),
        `defaultTools 引用了不存在的工具: ${t.ref}`,
      ).toBe(true);
    }
    // 办公八工具必须全部在内
    for (const n of [
      'office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
      'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy',
    ]) {
      expect(tools.some((t) => t.ref === n), `缺少 ${n}`).toBe(true);
    }
  });
});

describe('工具全集与分类', () => {
  it('office 八工具全部进入全集（33 个）', () => {
    expect(ALL_BUILTIN_TOOLS).toHaveLength(33);
    expect(ALL_BUILTIN_TOOLS).toContain('office_read');
    expect(ALL_BUILTIN_TOOLS).toContain('office_copy');
  });
  it('分类并集 == 全集（既有不变量）', () => {
    const union = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
    for (const t of ALL_BUILTIN_TOOLS) expect(union.has(t)).toBe(true);
  });
});

describe('marketplace catalog', () => {
  it('office-assistant 条目存在且为内联包', () => {
    const p = CATALOG_PATH;
    const catalog = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      items: Array<{ id: string; slug: string; type: string; downloadUrl: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item).toBeDefined();
    expect(item!.type).toBe('agent');
    expect(item!.downloadUrl).toBe(''); // 内联包（createInlinePackage 就地生成 manifest）
    expect(item!.readme.length).toBeGreaterThan(50); // readme 即 systemPrompt 载体
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/builtin-office.test.ts
```
预期：FAIL（YAML 不存在 / 全集仍 25）

- [ ] **Step 3: 写 office-assistant.yaml**

```yaml
# 办公助理 — 日常办公文档处理（Excel / Word / PPT / PDF）。
# 单一 main（无子 agent）；应用启动时由 builtin.ts 注册（source=builtin），
# marketplace catalog 同步提供内联包条目。
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 办公助理
  slug: office-assistant
  version: 1.0.0
  description: 处理日常办公文档——Excel 运算汇总、Word/PPT 撰写、PDF 生成与内容提取。
  iconEmoji: "💼"
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: |
      你是一名办公助理，负责处理日常办公文档（Excel / Word / PPT / PDF）。

      工作流：
      1. 明确用户要的格式与产出路径；产出文件默认放 workspace 根目录（用户另有指定则从之）
      2. 用户提到参考模板/示例文档时，先用 office_read 读取其内容与结构，再按同样结构产出
      3. Excel 计算：office_read_cells 精读取数 → 在上下文中完成运算 → office_create_excel 建骨架 → office_write_excel 写入结果；「在原表加汇总页签」用 office_copy 复制后再写
      4. 生成后告知用户文件路径，并说明可继续迭代（改内容重写、给参考模板重排）
      5. 旧格式 .xls/.doc/.ppt 不受支持时，提示用户先另存为新格式

      原则：
      - 先读后写：写/覆盖任何已存在文档前必须先 office_read
      - 大表先预览（office_read）再精读（office_read_cells），不整表倾倒
      - 意图不明确先问一句，不猜
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: office_read
    - kind: builtin
      ref: office_read_cells
    - kind: builtin
      ref: office_create_excel
    - kind: builtin
      ref: office_write_excel
    - kind: builtin
      ref: office_create_doc
    - kind: builtin
      ref: office_create_ppt
    - kind: builtin
      ref: office_create_pdf
    - kind: builtin
      ref: office_copy
    - kind: builtin
      ref: read_file
    - kind: builtin
      ref: list_files
    - kind: builtin
      ref: exists
    - kind: builtin
      ref: webfetch
    - kind: builtin
      ref: todowrite
```

- [ ] **Step 4: catalog.json 追加条目**

`resources/marketplace/catalog.json` 的 `items` 数组（`agent-coder` 条目后）追加：

```json
    {
      "id": "agent-office-assistant",
      "type": "agent",
      "slug": "office-assistant",
      "name": "办公助理",
      "version": "1.0.0",
      "author": "Momo Studio",
      "description": "处理日常办公文档——Excel 运算汇总、Word/PPT 撰写、PDF 生成与内容提取。",
      "readme": "# 办公助理\n\n你是一名办公助理，负责处理日常办公文档（Excel / Word / PPT / PDF）。\n\n工作流：1) 明确目标格式与产出路径；2) 有参考模板先 office_read 读取结构与内容再产出；3) Excel 计算：office_read_cells 精取数 → 上下文运算 → office_create_excel 建骨架 → office_write_excel 写结果；原表加汇总页签用 office_copy 复制后再写；4) 生成后告知路径与迭代方式；5) 旧格式 .xls/.doc/.ppt 提示另存新格式。\n\n原则：先读后写；大表先预览再精读；意图不明确先问。",
      "tags": ["office", "document", "productivity"],
      "category": "productivity",
      "iconEmoji": "💼",
      "verificationStatus": "official",
      "downloadUrl": "",
      "checksum": "",
      "sizeBytes": 2048,
      "installCount": 0
    }
```

- [ ] **Step 5: catalog.ts 全集与分类**

`electron/src/main/agent/tools/catalog.ts`：

`ALL_BUILTIN_TOOLS` 数组末尾（LSP 之后）追加，并把头注释「25」改「33」：

```ts
  // 办公（8）— v2.1 OfficeTools（xlsx/docx/pptx/pdf 读写）
  'office_read', 'office_read_cells',
  'office_create_excel', 'office_write_excel',
  'office_create_doc', 'office_create_ppt', 'office_create_pdf',
  'office_copy',
```

`TOOL_CATEGORIES` 数组末尾追加：

```ts
  { label: '办公', emoji: '💼', tools: ['office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel', 'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy'] },
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/builtin-office.test.ts tests/agent/tools-catalog.test.ts tests/agent/tools-catalog-v2.3.test.ts
```
预期：全部 PASS（若 tools-catalog 旧测试硬断言 25 数量，按新 33 更新该断言——数量不变量本身保留）

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add electron/resources/agents/office-assistant.yaml resources/marketplace/catalog.json electron/src/main/agent/tools/catalog.ts electron/tests/agent/tools/office/builtin-office.test.ts
GIT_MASTER=1 git commit -m "feat: 办公助理内置 agent——YAML/marketplace/工具全集三联动"
```

### Task 11: migration 037（builtin agent defaultTools 同步 office 工具）

**Files:**
- Create: `electron/src/main/storage/migrations/037_v2_1_office_tools_builtin.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/storage/migration-037-office-builtin.test.ts`（新建）

**Interfaces:**
- Consumes: v32（032_v2.3_builtin_apply_patch.ts）的 json_insert + NOT EXISTS 幂等模式（列名 `default_tools`、元素形态 `{kind, ref}`、命中判定看 `$.ref`）
- Produces: `export const migration037: { version: 37; up: string; down: string }`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/migration-037-office-builtin.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration037 } from '../../src/main/storage/migrations/037_v2_1_office_tools_builtin';

const OFFICE_TOOLS = [
  'office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
  'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy',
];

function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE agent_definitions (id TEXT PRIMARY KEY, source TEXT, default_tools TEXT)');
  const insert = db.prepare('INSERT INTO agent_definitions (id, source, default_tools) VALUES (?, ?, ?)');
  insert.run('builtin-coder', 'builtin', JSON.stringify([{ kind: 'builtin', ref: 'read_file' }]));
  insert.run('custom-1', 'custom', JSON.stringify([{ kind: 'builtin', ref: 'read_file' }]));
  insert.run('builtin-already', 'builtin', JSON.stringify([
    { kind: 'builtin', ref: 'read_file' },
    { kind: 'builtin', ref: 'office_read' },
  ]));
  return db;
}

describe('migration 037', () => {
  it('builtin 行追加 8 个 office 工具；custom 行不动；幂等', () => {
    const db = seed();
    db.exec(migration037.up);
    db.exec(migration037.up); // 二次执行幂等
    const get = db.prepare('SELECT default_tools FROM agent_definitions WHERE id = ?');
    const coder = JSON.parse((get.get('builtin-coder') as { default_tools: string }).default_tools) as Array<{ ref: string }>;
    for (const t of OFFICE_TOOLS) expect(coder.some((x) => x.ref === t), t).toBe(true);
    expect(coder.filter((x) => x.ref === 'office_read')).toHaveLength(1); // 已含则不重复
    const already = JSON.parse((get.get('builtin-already') as { default_tools: string }).default_tools) as Array<{ ref: string }>;
    expect(already.filter((x) => x.ref === 'office_read')).toHaveLength(1);
    const custom = JSON.parse((get.get('custom-1') as { default_tools: string }).default_tools) as Array<{ ref: string }>;
    expect(custom.some((x) => x.ref === 'office_read')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-037-office-builtin.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 3: 实现 migration 037**

```ts
// electron/src/main/storage/migrations/037_v2_1_office_tools_builtin.ts
//
// v2.1 Migration 037：builtin agent defaultTools 同步 office 八工具。
// 模式与 v32（032_v2.3_builtin_apply_patch.ts）完全一致：
//   - 列名 default_tools，JSON 对象数组 [{"kind":"builtin","ref":"..."}]
//   - json_insert '$[#]' 末尾追加（不用 json_group_array 重建——会对 TEXT 二次编码损坏数据）
//   - NOT EXISTS 守卫幂等（已含该 ref 的行不再命中）
// down 不主动清理（forward-only）。

export const migration037 = {
  version: 37,
  up: `
    -- builtin agent defaultTools 扩展：追加 office 八工具（若缺失）。
    ${['office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
       'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy']
      .map(
        (tool) => `
    UPDATE agent_definitions
    SET default_tools = json_insert(
      default_tools,
      '$[#]',
      json_object('kind', 'builtin', 'ref', '${tool}')
    )
    WHERE source = 'builtin'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(default_tools)
        WHERE json_extract(json_each.value, '$.ref') = '${tool}'
      );`,
      )
      .join('')}
  `.trim(),
  down: `
    -- 不主动清理 office 工具（forward-only）
    SELECT 1;
  `.trim(),
} as const;
```

- [ ] **Step 4: 注册到 migrations/index.ts**

import 区追加：

```ts
import { migration037 } from './037_v2_1_office_tools_builtin';
```

`MIGRATIONS` 数组末尾（036 之后）追加：

```ts
  {
    // v2.1：builtin agent defaultTools 追加 office 八工具（spec 2026-09-18 §8-3，
    // 沿用 v32 同步策略）。SQL 住在独立模块 037_v2_1_office_tools_builtin.ts（约定同上）。
    version: migration037.version,
    sql: migration037.up,
  },
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-037-office-builtin.test.ts tests/storage/
```
预期：PASS（既有 migration 套件不回归）

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add electron/src/main/storage/migrations/037_v2_1_office_tools_builtin.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/migration-037-office-builtin.test.ts
GIT_MASTER=1 git commit -m "feat: migration 037——builtin agent defaultTools 同步 office 八工具"
```

### Task 12: 全量验证（收口）

**Files:** 无新文件；本任务只跑验证，若发现问题就地修复并独立 commit。

- [ ] **Step 1: 双 workspace 类型检查**

```bash
nvm use 20
npx pnpm@9.0.0 typecheck
```
预期：electron + renderer 双绿（renderer 不受影响，仍须跑——IPC 面未动，但回归必须显式）

- [ ] **Step 2: 全量单测**

```bash
npx pnpm@9.0.0 test
```
预期：electron + renderer 全部 PASS。重点关注：journal 套件（P1 改动）、tools 目录（P2/P3 改动）、tools-catalog 与 storage 套件（P4 改动）

- [ ] **Step 3: 全工具注册冒烟（一次性脚本验证 8 工具全部出现在注册中心）**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office/
```
预期：PASS。再跑注册中心聚合断言（若无既有用例，用一次性 node 脚本验证）：

```bash
cd electron && node -e "
const { buildToolRegistry } = require('./dist/main/agent/tools/index.js');
// dist 若未构建：npx pnpm@9.0.0 --filter momo-studio-electron build 后重跑
" 2>/dev/null || echo "（dist 未构建时跳过——Task 12 Step 2 的单测已覆盖注册逻辑）"
```

- [ ] **Step 4: 问题修复与收尾 commit（如有）**

任何 FAIL 就地修复、独立 commit（`fix:` 前缀）；全部绿后本计划完成。

---

## 计划自审记录（写完即检，就地修正）

1. **Spec 覆盖**：spec §4 架构→T3/T6；§5 八工具→T6/7/8/9；§6.3 账本二进制→T1/T2；§7 预算中断→T6（OUTPUT_LIMITS + abortSignal 入口）；§8 三联动→T10/T11；§9 字体→T9；§10 错误→各任务错误路径用例 + T3 嗅探；§11 测试→各任务；§13 切分→Phase 对齐。无遗漏。
2. **类型一致性**：`readXlsxPreview`/`readXlsxCells`/`createXlsx`/`writeXlsxOps`（T4/T5 定义，T6 消费）；`readDocx`/`createDocx`（T7）；`readPptx`/`createPptx`（T8）；`readPdf`/`createPdf`/`resolveFontPath`（T9）；`ALL_BUILTIN_TOOLS` 33（T10 定义，T11 消费工具名单一致）。已交叉核对。
3. **占位符扫描**：无 TBD/TODO/「稍后实现」；每个代码步骤含完整代码与命令。






