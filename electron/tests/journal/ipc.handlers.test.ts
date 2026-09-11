// electron/tests/journal/ipc.handlers.test.ts
//
// journal 命名空间 4 通道（list / revert / scan / rollbackFileBefore）IPC 接线测试
// （v2.5 变更账本 Task 7）。
//
// mock 形态照抄 tests/sandbox/ipc.handlers.test.ts（vi.hoisted + ipcMain.handle
// Map 捕获 + logger 打桩）；数据面全真实（momo-test-rules 铁律 1/4/5）：
//   - 真实 SQLite（AP_USER_DATA_DIR 临时目录 + runMigrations）
//   - 真实 store——由 registerJournalIpc() 注册时注入（T3 移交的主进程注入行，
//     本文件刻意不调 __setJournalStoreForTest 注入，afterEach 仅置 null 清理——
//     「注册即注入」由此文件的 boot 冒烟用例锁定）
//   - 真实 workspace（createWorkspace 生产路径：建目录 + git init + DB 行）
//   - 条目一律经真实 recordChange 生产（先记账后写盘的 §5.3 生产语义）
//
// 断言清单（plan Task 7 Step 1 + 四项移交）：
//   四通道注册 / list 两 scope + 内容截断 100KB + null hash 侧文本 null /
//   revert 透传 force + 合成 ctx 条目落账（toolName='undo' +
//   streamSessionId='journal-revert-ui'）/ rollbackFileBefore 组合序（A、B 同文件
//   → 逆序 B→A）/ scan 透传（真实 repo 差集 + 损坏 .git degraded）/
//   boot 冒烟：registerJournalIpc() 后 getJournalStore() 非 null（T4 移交）/
//   boot enforceQuota 接线源码锁（T6 移交）/ 错误路径：workspace 不存在 /
//   scope 两键皆空 / 锚点条目不存在 / 锚点 path 不一致

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// vi.mock 会被提升到所有 import 之前；被工厂引用的 mock 必须用 vi.hoisted 提前声明。
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerJournalIpc } from '../../src/main/journal/ipc.handlers';
import { getJournalStore, recordChange, __setJournalStoreForTest } from '../../src/main/journal/recorder';
import type { RecordCtx } from '../../src/main/journal/recorder';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { Workspace } from '../../src/main/workspace/types';
import type { JournalEntry, JournalEntryView } from '../../src/main/journal/types';
import type { RevertOutcome } from '../../src/main/journal/revert';
import type { ScanResult } from '../../src/main/journal/detector';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-ipc-${process.pid}-${Date.now()}`);
/** 每用例真实 workspace 目录（afterEach 统一清理） */
const wsDirs: string[] = [];

beforeEach(() => {
  fsSync.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // 同一 db 文件跨用例复用——显式清空，保证用例间零耦合
  getDb().prepare('DELETE FROM journal_entries').run();
  getDb().prepare('DELETE FROM workspace_members').run();
  getDb().prepare('DELETE FROM workspaces').run();
  ipcHandlers.clear();
  registerJournalIpc();
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  for (const d of wsDirs) fsSync.rmSync(d, { recursive: true, force: true });
  wsDirs.length = 0;
  fsSync.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 真实建 workspace（生产路径：mkdtemp 目录 + git init + owner 成员行） */
async function mkWorkspace(name: string): Promise<{ ws: Workspace; dir: string }> {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ipc-ws-'));
  wsDirs.push(dir);
  const ws = await createWorkspace({ name, directoryPath: dir }, 'owner');
  return { ws, dir };
}

/** 标准 RecordCtx 工厂（生产语义：工具层记账上下文） */
function rcOf(wsId: string, overrides: Partial<RecordCtx> = {}): RecordCtx {
  return {
    workspaceId: wsId,
    taskId: 'T-1',
    sessionId: 'sess-1',
    streamSessionId: 'stream-1',
    toolName: 'write_file',
    ...overrides,
  };
}

/** 工具层「先记账后写盘」仿真（§5.3 生产语义，照 revert.test.ts 模式） */
function journaledCreate(rc: RecordCtx, dir: string, rel: string, content: string): JournalEntry {
  const e = recordChange(rc, rel, 'create', null, content);
  fsSync.writeFileSync(path.join(dir, rel), content, 'utf8');
  return e;
}

function journaledModify(
  rc: RecordCtx,
  dir: string,
  rel: string,
  before: string,
  after: string,
): JournalEntry {
  const e = recordChange(rc, rel, 'modify', before, after);
  fsSync.writeFileSync(path.join(dir, rel), after, 'utf8');
  return e;
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`通道未注册: ${channel}`);
  return Promise.resolve(handler({}, ...args) as T);
}

describe('journal/ipc.handlers 通道注册 + boot 冒烟', () => {
  it('注册 journal:list / revert / scan / rollbackFileBefore 四通道', () => {
    expect(ipcHandlers.has('journal:list')).toBe(true);
    expect(ipcHandlers.has('journal:revert')).toBe(true);
    expect(ipcHandlers.has('journal:scan')).toBe(true);
    expect(ipcHandlers.has('journal:rollbackFileBefore')).toBe(true);
  });

  it('boot 冒烟回归锁（T4 移交）：registerJournalIpc() 注册即注入主进程 store——getJournalStore() 非 null', () => {
    // 本文件从不自行注入 store——非 null 只能来自 registerJournalIpc 内的
    // setJournalStore(createJournalStore(getDb())) 注入行；该行被无声删除时此用例红。
    expect(getJournalStore()).not.toBeNull();
  });

  it('boot 接线源码锁（T6 移交）：main/index.ts 在 registerIpcHandlers( 后逐 workspace enforceQuota', () => {
    // main/index.ts 无测试入口（Electron 入口），照 sandbox 120s 回归锁先例做源码扫描——
    // 锁「store 注入（registerIpcHandlers 内）先于配额清理执行」的接线次序。
    // v2.7 T10 起 registerIpcHandlers 带 workspace:switch 回调实参（浏览器切换钩子）。
    const src = fsSync.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf-8');
    const ipcCallIdx = src.indexOf('registerIpcHandlers({');
    const quotaCallIdx = src.indexOf('enforceQuota(');
    expect(ipcCallIdx).toBeGreaterThan(-1);
    expect(quotaCallIdx).toBeGreaterThan(ipcCallIdx);
    expect(src).toMatch(/listWorkspaces/);
  });
});

describe('journal:list', () => {
  it('task scope：只返回该任务条目（created_at 升序）+ beforeText/afterText 取自 blob', async () => {
    const { ws, dir } = await mkWorkspace('ws-list-task');
    const rc = rcOf(ws.id);
    journaledCreate(rc, dir, 'a.md', 'v0');
    journaledModify(rc, dir, 'a.md', 'v0', 'v1');
    recordChange(rcOf(ws.id, { taskId: 'T-2', streamSessionId: 'stream-2' }), 'b.md', 'create', null, 'other');

    const views = await call<JournalEntryView[]>('journal:list', { workspaceId: ws.id, taskId: 'T-1' });

    expect(views).toHaveLength(2);
    expect(views.map((v) => v.taskId)).toEqual(['T-1', 'T-1']);
    expect(views[0]!.createdAt).toBeLessThanOrEqual(views[1]!.createdAt);
    // 视图文本：create 侧 before=null；modify 双侧皆有内容
    expect(views[0]!.beforeText).toBeNull();
    expect(views[0]!.afterText).toBe('v0');
    expect(views[1]!.beforeText).toBe('v0');
    expect(views[1]!.afterText).toBe('v1');
    expect(views[1]!.op).toBe('modify');
  });

  it('stream scope：只返回该 streamSessionId 条目（ChangesChip 消费面）', async () => {
    const { ws, dir } = await mkWorkspace('ws-list-stream');
    journaledCreate(rcOf(ws.id, { streamSessionId: 'stream-x' }), dir, 'x.md', 'xx');
    journaledCreate(rcOf(ws.id, { streamSessionId: 'stream-y' }), dir, 'y.md', 'yy');

    const views = await call<JournalEntryView[]>('journal:list', {
      workspaceId: ws.id,
      streamSessionId: 'stream-x',
    });

    expect(views).toHaveLength(1);
    expect(views[0]!.streamSessionId).toBe('stream-x');
    expect(views[0]!.path).toBe('x.md');
    expect(views[0]!.afterText).toBe('xx');
  });

  it('错误路径：taskId 与 streamSessionId 皆缺 → 空数组（不猜全量）', async () => {
    const { ws } = await mkWorkspace('ws-list-empty');
    const views = await call<JournalEntryView[]>('journal:list', { workspaceId: ws.id });
    expect(views).toEqual([]);
  });

  it('内容截断：超 100KB 的 blob 文本截到 100*1024 字符，前缀保真', async () => {
    const { ws, dir } = await mkWorkspace('ws-list-cap');
    const big = 'x'.repeat(100 * 1024 + 500);
    journaledCreate(rcOf(ws.id), dir, 'big.txt', big);

    const views = await call<JournalEntryView[]>('journal:list', {
      workspaceId: ws.id,
      taskId: 'T-1',
    });

    expect(views).toHaveLength(1);
    expect(views[0]!.afterText).toHaveLength(100 * 1024);
    expect(views[0]!.afterText).toBe(big.slice(0, 100 * 1024));
  });

  it('delete 条目 afterText 为 null（hash=null 侧文本为 null）', async () => {
    const { ws, dir } = await mkWorkspace('ws-list-null');
    const rc = rcOf(ws.id);
    journaledCreate(rc, dir, 'd.md', 'will-delete');
    const e = recordChange(rc, 'd.md', 'delete', 'will-delete', null);
    fsSync.rmSync(path.join(dir, 'd.md'));

    const views = await call<JournalEntryView[]>('journal:list', { workspaceId: ws.id, taskId: 'T-1' });
    const del = views.find((v) => v.id === e.id);
    expect(del).toBeDefined();
    expect(del!.beforeText).toBe('will-delete');
    expect(del!.afterText).toBeNull();
  });
});

describe('journal:revert', () => {
  it('force 透传：漂移默认 skipped-diverged；force=true 强制写回 before', async () => {
    const { ws, dir } = await mkWorkspace('ws-revert-force');
    const rc = rcOf(ws.id);
    journaledCreate(rc, dir, 'a.md', 'v1');
    const m = journaledModify(rc, dir, 'a.md', 'v1', 'v2');
    // 手工漂移（不经记账）——模拟记账后其他变更修改
    fsSync.writeFileSync(path.join(dir, 'a.md'), 'v3', 'utf8');

    const skipped = await call<RevertOutcome[]>('journal:revert', ws.id, [m.id]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.result).toBe('skipped-diverged');
    expect(fsSync.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('v3');

    const forced = await call<RevertOutcome[]>('journal:revert', ws.id, [m.id], { force: true });
    expect(forced[0]!.result).toBe('reverted');
    expect(forced[0]!.detail).toContain('强制');
    expect(fsSync.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('v1');
  });

  it('合成 ctx 落账（T3 移交裁定）：对称条目 toolName=undo + streamSessionId=journal-revert-ui + taskId=null', async () => {
    const { ws, dir } = await mkWorkspace('ws-revert-ctx');
    const rc = rcOf(ws.id);
    journaledCreate(rc, dir, 'a.md', 'v1');
    const m = journaledModify(rc, dir, 'a.md', 'v1', 'v2');

    const outcomes = await call<RevertOutcome[]>('journal:revert', ws.id, [m.id]);
    expect(outcomes[0]!.result).toBe('reverted');

    const store = getJournalStore()!;
    const undoEntries = store
      .listByPath(ws.id, 'a.md')
      .filter((e) => e.streamSessionId === 'journal-revert-ui');
    expect(undoEntries.length).toBeGreaterThanOrEqual(1);
    for (const e of undoEntries) {
      expect(e.toolName).toBe('undo');
      expect(e.taskId).toBeNull();
      expect(e.sessionId).toBeNull();
    }
    // 对称条目语义：modify 撤回记 modify（before=撤回前内容 v2，after=写回内容 v1）
    expect(undoEntries[0]!.op).toBe('modify');
    expect(undoEntries[0]!.beforeHash).not.toBeNull();
    expect(undoEntries[0]!.afterHash).not.toBeNull();
  });

  it('错误路径：workspace 不存在 → invoke 拒绝（中文错误）', async () => {
    await expect(call('journal:revert', 'ws-不存在', ['je_x'])).rejects.toThrow('工作空间不存在');
  });
});

describe('journal:rollbackFileBefore', () => {
  it('组合逆序：A、B 同文件，rollback 到 A 之前 → 先撤 B 再撤 A，终态=A.before', async () => {
    const { ws, dir } = await mkWorkspace('ws-rollback');
    const rc = rcOf(ws.id);
    // 基线文件（未记账的既有内容）→ A → B
    fsSync.writeFileSync(path.join(dir, 'f.md'), 'base\n', 'utf8');
    const a = journaledModify(rc, dir, 'f.md', 'base\n', 'A');
    const b = journaledModify(rc, dir, 'f.md', 'A', 'B');

    const outcomes = await call<RevertOutcome[]>('journal:rollbackFileBefore', ws.id, 'f.md', a.id);

    expect(outcomes).toHaveLength(2);
    // 执行序 = 返回序：B（较新）先撤，A 后撤
    expect(outcomes[0]!.id).toBe(b.id);
    expect(outcomes[0]!.result).toBe('reverted');
    expect(outcomes[1]!.id).toBe(a.id);
    expect(outcomes[1]!.result).toBe('reverted');
    expect(fsSync.readFileSync(path.join(dir, 'f.md'), 'utf8')).toBe('base\n');
    // 组合同样带合成 ctx（裁定：与 revert 同源）
    const store = getJournalStore()!;
    const undoCount = store
      .listByPath(ws.id, 'f.md')
      .filter((e) => e.streamSessionId === 'journal-revert-ui' && e.toolName === 'undo').length;
    expect(undoCount).toBe(2);
  });

  it('错误路径：锚点条目不存在（可能已被配额清理）→ no-op 如实汇报', async () => {
    const { ws } = await mkWorkspace('ws-rollback-miss');
    const outcomes = await call<RevertOutcome[]>('journal:rollbackFileBefore', ws.id, 'f.md', 'je_不存在');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBe('no-op');
    expect(outcomes[0]!.detail).toContain('不存在');
  });

  it('错误路径：锚点 path 与传入 path 不一致 → no-op（不越 path 撤销）', async () => {
    const { ws, dir } = await mkWorkspace('ws-rollback-mismatch');
    const rc = rcOf(ws.id);
    journaledCreate(rc, dir, 'a.md', 'v1');

    const store = getJournalStore()!;
    const anchor = store.listByPath(ws.id, 'a.md')[0]!;
    const outcomes = await call<RevertOutcome[]>('journal:rollbackFileBefore', ws.id, 'other.md', anchor.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBe('no-op');
    expect(outcomes[0]!.detail).toContain('不一致');
  });
});

describe('journal:scan', () => {
  it('透传真实扫描：untracked 差集正确（journaled 入账 / unjournaled 账外）', async () => {
    const { ws, dir } = await mkWorkspace('ws-scan-ok');
    // j.txt 记账（create）且真实存在 → git 变更 ∩ 账本；out.txt 手工写不记账 → 账外
    journaledCreate(rcOf(ws.id), dir, 'j.txt', 'journaled');
    fsSync.writeFileSync(path.join(dir, 'out.txt'), 'untracked', 'utf8');

    const r = await call<ScanResult>('journal:scan', ws.id, null);

    expect(r.degraded).toBe(false);
    expect(r.journaled).toEqual(['j.txt']);
    expect(r.unjournaled).toEqual(['out.txt']);
    expect(r.repos[0]).toBe(dir);
  });

  it('透传 degraded：仓损坏（git status 非零退出）→ degraded=true + 三列空', async () => {
    const { ws, dir } = await mkWorkspace('ws-scan-degraded');
    // .git 存在（discoverRepos 会发现根仓）但 HEAD 损坏 → git status 非零 → 降级
    fsSync.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fsSync.writeFileSync(path.join(dir, '.git', 'HEAD'), 'garbage-not-a-ref', 'utf8');

    const r = await call<ScanResult>('journal:scan', ws.id, null);

    expect(r.degraded).toBe(true);
    expect(r.journaled).toEqual([]);
    expect(r.unjournaled).toEqual([]);
    expect(r.repos).toEqual([]);
  });

  it('错误路径：workspace 不存在 → invoke 拒绝', async () => {
    await expect(call('journal:scan', 'ws-不存在', null)).rejects.toThrow('工作空间不存在');
  });
});
