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
  hashContent,
  recordChange,
  recordDeleteTree,
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

describe('recordDeleteTree 二进制记账（Task 1 审查追补）', () => {
  it('rm 前记账：非 utf-8 文件的 before blob 与原字节一致', () => {
    // OLE2 复合文档头 + 非 utf-8 序列（旧 utf-8 文本读法必损坏）
    const bytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0xff, 0xfe]);
    fs.writeFileSync(path.join(wsDir, '旧报表.xls'), bytes);
    const entries = recordDeleteTree(rc, wsDir, '旧报表.xls');
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    const back = getJournalStore()!.readBlobBytes('ws-bin2', entry.beforeHash!);
    expect(back).not.toBeNull();
    expect(back!.equals(bytes)).toBe(true);
  });

  it('readBlobBytes 不存在的 hash 返回 null（Task 1 Minor 备案）', () => {
    // hashContent 保证是合法 hash 形状，但从未落过 blob
    const missingHash = hashContent('content-never-recorded');
    expect(getJournalStore()!.readBlobBytes('ws-bin2', missingHash)).toBeNull();
  });
});
