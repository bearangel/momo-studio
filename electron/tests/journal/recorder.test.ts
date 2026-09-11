// electron/tests/journal/recorder.test.ts
//
// journal recorder 测试：五 op 记账 API（v2.5 变更账本 Task 2）。
//
// recorder 是纯组装层（hash → writeBlob → insert），只记账不碰工作区文件；
// recordDeleteTree 仅 fs walk 读取待删文件以 hash（不变更文件系统）。
//
// fixture 照 tests/journal/store.test.ts：
//   - tmpRoot 作为 AP_USER_DATA_DIR（resolveJournalDir 走 resolveUserDataDir）
//   - runMigrations() 真实建库（含 v33）
//   - __setJournalStoreForTest 注入 createJournalStore(getDb())——刻意不 mock
//     store，简化 mock 会掩盖 hashContent 真实 sha256 语义与 blob 落盘路径漂移
//     （momo-test-rules 铁律 1 + 5）
//
// 断言清单（task brief Step 1）：
//   1) hashContent：同内容同 hash + 64 字符 hex
//   2) 五 op 矩阵：create / modify / delete / rename + recordDeleteTree 3 文件 = 3 条
//   3) blob 落盘可读回（writeBlob 幂等在 T1 已测；此处只验内容往返）
//   4) 条目字段逐一对（含 RecordCtx 全字段透传 + id/createdAt 形态）
//   5) 边界：空目录 / relDir 不存在 / 未注入 store 抛错
//
// hash 用真实 sha256（与生产 hashContent 同款）；id 验证 je_<uuid> 前缀。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore } from '../../src/main/journal/store';
import type { JournalStore } from '../../src/main/journal/store';
import {
  hashContent,
  recordChange,
  recordDeleteTree,
  __setJournalStoreForTest,
} from '../../src/main/journal/recorder';
import type { RecordCtx } from '../../src/main/journal/recorder';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-recorder-${process.pid}-${Date.now()}`);
let store: JournalStore;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  store = createJournalStore(getDb());
  __setJournalStoreForTest(store);
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 标准 RecordCtx 工厂（所有字段显式以便覆盖断言） */
function ctxOf(overrides: Partial<RecordCtx> = {}): RecordCtx {
  return {
    workspaceId: 'ws-A',
    taskId: 'T-1',
    sessionId: 'sess-1',
    streamSessionId: 'stream-1',
    toolName: 'write_file',
    ...overrides,
  };
}

describe('hashContent', () => {
  it('同内容同 hash；不同内容不同 hash；输出 64 字符 hex', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('world'));
    expect(hashContent('hello')).toMatch(/^[0-9a-f]{64}$/);
    // 与 node:crypto 真实 sha256 一致（接口契约 = 复用 crypto）
    // 已知固定值：sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hashContent('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('空字符串 hash 有效（与生产 sha256 一致）', () => {
    expect(hashContent('')).toMatch(/^[0-9a-f]{64}$/);
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashContent('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('recordChange 五 op 矩阵', () => {
  it('create: before=null after=content → beforeHash=null, afterHash=hash(content)', () => {
    const content = 'new file content\nline2';
    const entry = recordChange(ctxOf(), 'src/new.ts', 'create', null, content);

    expect(entry.op).toBe('create');
    expect(entry.beforeHash).toBeNull();
    expect(entry.afterHash).toBe(hashContent(content));
    expect(entry.oldPath).toBeNull();
    expect(entry.path).toBe('src/new.ts');

    // blob 落盘可读回（writeBlob 幂等性 T1 已验；此处仅端到端断言）
    expect(store.readBlob('ws-A', entry.afterHash as string)).toBe(content);
    // 未写 before blob（beforeHash=null 即无对应落盘）
    expect(store.readBlob('ws-A', 'nonexistent-hash')).toBeNull();
  });

  it('modify: before/after 双 hash，两个 blob 都可读回', () => {
    const before = 'old content\nline2';
    const after = 'new content\nline2\nline3';
    const entry = recordChange(ctxOf(), 'src/mod.ts', 'modify', before, after);

    expect(entry.op).toBe('modify');
    expect(entry.beforeHash).toBe(hashContent(before));
    expect(entry.afterHash).toBe(hashContent(after));
    expect(entry.oldPath).toBeNull();

    // 两个 blob 都落盘
    expect(store.readBlob('ws-A', entry.beforeHash as string)).toBe(before);
    expect(store.readBlob('ws-A', entry.afterHash as string)).toBe(after);
  });

  it('delete: before=content after=null → beforeHash 有值，afterHash=null', () => {
    const before = 'file to delete\nline2';
    const entry = recordChange(ctxOf(), 'src/del.ts', 'delete', before, null);

    expect(entry.op).toBe('delete');
    expect(entry.beforeHash).toBe(hashContent(before));
    expect(entry.afterHash).toBeNull();
    expect(entry.oldPath).toBeNull();

    // only before blob 落盘
    expect(store.readBlob('ws-A', entry.beforeHash as string)).toBe(before);
  });

  it('rename: oldPath + before 内容；path 是新路径；afterHash=null', () => {
    const before = 'moved content\nline2';
    const entry = recordChange(
      ctxOf({ toolName: 'mv' }),
      'src/new-name.ts',
      'rename',
      before,
      null,
      'src/old-name.ts',
    );

    expect(entry.op).toBe('rename');
    expect(entry.path).toBe('src/new-name.ts'); // 新路径（path 参数）
    expect(entry.oldPath).toBe('src/old-name.ts'); // 旧路径
    expect(entry.beforeHash).toBe(hashContent(before));
    expect(entry.afterHash).toBeNull(); // 内容未变，撤销只需旧内容
    expect(entry.toolName).toBe('mv');

    expect(store.readBlob('ws-A', entry.beforeHash as string)).toBe(before);
  });

  it('rename: 不传 oldPath → 抛错（fail-fast：撤销缺旧路径无法定位）', () => {
    expect(() =>
      recordChange(ctxOf(), 'src/x.ts', 'rename', 'content', null),
    ).toThrow(/rename 记账必须提供 oldPath/);
  });
});

describe('recordChange 字段透传', () => {
  it('RecordCtx 全部字段 → 条目字段逐一对（含 null 边界 + id/createdAt 形态）', () => {
    const fastCtx = ctxOf({
      taskId: null, // 快速会话
      sessionId: null,
      streamSessionId: 'stream-fast-007',
      toolName: 'apply_patch',
    });
    const before = Date.now();
    const entry = recordChange(fastCtx, 'src/x.ts', 'modify', 'old', 'new');
    const after = Date.now();

    // id = je_<uuid>（与 store 测试 fixture 同约定）
    expect(entry.id).toMatch(/^je_[0-9a-f-]{36}$/);
    // workspaceId / taskId / sessionId 全透传（含 null）
    expect(entry.workspaceId).toBe('ws-A');
    expect(entry.taskId).toBeNull();
    expect(entry.sessionId).toBeNull();
    expect(entry.streamSessionId).toBe('stream-fast-007');
    expect(entry.toolName).toBe('apply_patch');
    expect(entry.path).toBe('src/x.ts');
    expect(entry.op).toBe('modify');
    // createdAt = Date.now()，落在调用前后窗口
    expect(typeof entry.createdAt).toBe('number');
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);

    // store 内已落库（listByPath 查回完整字段——含 hash 都从插入形态还原）
    const fetched = store.listByPath('ws-A', 'src/x.ts');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toEqual(entry);

    // streamSessionId 透传到 listByStream（归组键契约）
    expect(store.listByStream('ws-A', 'stream-fast-007')).toHaveLength(1);
  });

  it('多次 recordChange 同 stream → 全部落库并按 createdAt 升序（fakeTimers 验证 ORDER BY 区分度；生产单调时钟是单独用例）', () => {
    // 此用例刻意走 fakeTimers 推进 Date.now()，验证落库 SQL ORDER BY created_at
    // 排序字段确有区分度；生产 createdAt 严格全序由 recorder 模块级 nextCreatedAt
    // 单调时钟保证（独立用例覆盖），不在此处复测。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    try {
      const rctx = ctxOf({ streamSessionId: 'stream-multi' });
      recordChange(rctx, 'a.ts', 'create', null, 'A');
      vi.advanceTimersByTime(1);
      recordChange(rctx, 'b.ts', 'create', null, 'B');
      vi.advanceTimersByTime(1);
      recordChange(rctx, 'c.ts', 'create', null, 'C');

      const entries = store.listByStream('ws-A', 'stream-multi');
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
      // createdAt 严格单调递增（验证 ORDER BY 排序字段确有区分度）
      expect(entries[1]!.createdAt).toBeGreaterThan(entries[0]!.createdAt);
      expect(entries[2]!.createdAt).toBeGreaterThan(entries[1]!.createdAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('生产单调时钟：同 stream 连调 recordChange 两次（无 fakeTimers）→ createdAt 严格递增', () => {
    // 不走 vi 推进，直接连调——验证 recorder 模块级 nextCreatedAt 单调时钟在
    // 真实 Date.now() 同毫秒返回时仍能产生严格递增 createdAt。下游 T3 对称记账
    // 与 T7 rollbackFileBefore 严格比较依赖此全序。
    const rctx = ctxOf({ streamSessionId: 'stream-mono' });
    const e1 = recordChange(rctx, 'x.ts', 'modify', 'old', 'new');
    const e2 = recordChange(rctx, 'x.ts', 'modify', 'new', 'newer');
    expect(e2.createdAt).toBeGreaterThan(e1.createdAt);

    const entries = store.listByStream('ws-A', 'stream-mono');
    expect(entries).toHaveLength(2);
    expect(entries[1]!.createdAt).toBeGreaterThan(entries[0]!.createdAt);
  });
});

describe('recordDeleteTree 递归 walk', () => {
  it('3 文件（嵌套）= 3 条 delete 条目；相对路径正确；blob 可读回', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.writeFileSync(path.join(wsDir, 'a.ts'), 'aaa');
      fs.mkdirSync(path.join(wsDir, 'sub'));
      fs.writeFileSync(path.join(wsDir, 'sub', 'b.ts'), 'bbb');
      fs.writeFileSync(path.join(wsDir, 'c.txt'), 'ccc');

      const entries = recordDeleteTree(ctxOf({ toolName: 'rm' }), wsDir, '');

      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.op === 'delete')).toBe(true);

      // 相对路径正确（含嵌套 sub/b.ts）
      const paths = entries.map((e) => e.path).sort();
      expect(paths).toEqual(['a.ts', 'c.txt', path.join('sub', 'b.ts')]);

      // 每条都 hash 了 before 内容；afterHash = null
      const expectedContent: Record<string, string> = {
        'a.ts': 'aaa',
        'c.txt': 'ccc',
        [path.join('sub', 'b.ts')]: 'bbb',
      };
      for (const e of entries) {
        expect(e.beforeHash).toBe(hashContent(expectedContent[e.path] as string));
        expect(e.afterHash).toBeNull();
        expect(store.readBlob('ws-A', e.beforeHash as string)).toBe(
          expectedContent[e.path],
        );
      }
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('relDir 嵌套子目录（spec 真实场景：从根删 sub/）', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.mkdirSync(path.join(wsDir, 'sub'));
      fs.writeFileSync(path.join(wsDir, 'sub', 'a.ts'), 'aaa');
      fs.writeFileSync(path.join(wsDir, 'sub', 'b.ts'), 'bbb');

      const entries = recordDeleteTree(ctxOf({ toolName: 'rm' }), wsDir, 'sub');

      expect(entries).toHaveLength(2);
      const paths = entries.map((e) => e.path).sort();
      // 路径前缀包含 relDir（不是裸文件名）
      expect(paths).toEqual([path.join('sub', 'a.ts'), path.join('sub', 'b.ts')]);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('空目录 → 返回空数组，不报错', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.mkdirSync(path.join(wsDir, 'empty'));

      const entries = recordDeleteTree(ctxOf(), wsDir, 'empty');
      expect(entries).toEqual([]);
      expect(store.countAll()).toBe(0);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('relDir 不存在 → 返回空数组（不抛错）', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      const entries = recordDeleteTree(ctxOf(), wsDir, 'nonexistent-dir');
      expect(entries).toEqual([]);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('relDir 指向单文件 → 1 条 delete 条目（边界）', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.writeFileSync(path.join(wsDir, 'single.ts'), 'single');

      const entries = recordDeleteTree(ctxOf({ toolName: 'rm' }), wsDir, 'single.ts');

      expect(entries).toHaveLength(1);
      expect(entries[0]?.op).toBe('delete');
      expect(entries[0]?.path).toBe('single.ts');
      expect(entries[0]?.beforeHash).toBe(hashContent('single'));
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('RecordCtx 全部字段（除 path/oldPath）透传到每条 delete 条目', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.writeFileSync(path.join(wsDir, 'a.ts'), 'aaa');
      fs.writeFileSync(path.join(wsDir, 'b.ts'), 'bbb');

      const rctx = ctxOf({
        taskId: null,
        sessionId: null,
        streamSessionId: 'stream-del-007',
        toolName: 'rm',
      });
      const entries = recordDeleteTree(rctx, wsDir, '');

      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e.workspaceId).toBe('ws-A');
        expect(e.taskId).toBeNull();
        expect(e.sessionId).toBeNull();
        expect(e.streamSessionId).toBe('stream-del-007');
        expect(e.toolName).toBe('rm');
        expect(e.oldPath).toBeNull();
      }

      // stream 归组命中
      expect(store.listByStream('ws-A', 'stream-del-007')).toHaveLength(2);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('walker 接受 ./ 前缀相对路径（越界防御在 WorkspaceFS 层，见注释）', () => {
    // 真实 rm 工具走 WorkspaceFS 防御，这里只验证 walker 不抛错 + 不越权；
    // workspaceDir 在 walker 内部只作为基址参与 join，不做规范化（生产防御在
    // WorkspaceFS 层）。此用例仅验证 walker 输入接受相对路径时不炸。
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-journal-ws-'));
    try {
      fs.writeFileSync(path.join(wsDir, 'safe.ts'), 'safe');

      // relDir 含 ./ 等价路径不抛错
      const entries = recordDeleteTree(ctxOf(), wsDir, './');
      expect(entries.map((e) => e.path)).toEqual(['safe.ts']);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

describe('recorder 模块注入', () => {
  it('未注入 store 时 recordChange 抛错（防生产裸调）', () => {
    __setJournalStoreForTest(null);
    expect(() => recordChange(ctxOf(), 'a.ts', 'modify', 'x', 'y')).toThrow(
      /journal store 未注入/,
    );
  });

  it('未注入 store 时 recordDeleteTree 抛错', () => {
    __setJournalStoreForTest(null);
    expect(() => recordDeleteTree(ctxOf(), '/tmp', 'x')).toThrow(/journal store 未注入/);
  });

  it('hashContent 不依赖 store（纯函数）', () => {
    __setJournalStoreForTest(null);
    expect(() => hashContent('x')).not.toThrow();
    expect(hashContent('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
