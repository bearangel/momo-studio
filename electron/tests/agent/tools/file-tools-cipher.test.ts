// electron/tests/agent/tools/file-tools-cipher.test.ts
//
// B 方案收口 · file-tools 密文安全闸与通道收口回归锁：
//   1. edit_file 拒密文（宁报错不毁文件，盘上字节不动）
//   2. edit_file 写入经内容通道（修复裸 fs.writeFile 旁路）
//   3. write_file / mv 的 journal before 快照：密文 → null（写入/移动照常）
// 真实 tmp workspace + 真实 journal store（office-tools.test.ts 同款 fixture）。
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { DirectContentIo } from '../../../src/main/files/file-io/content-io';
import { executeFileTool } from '../../../src/main/agent/tools/file-tools';
import { ReadTracker } from '../../../src/main/agent/tools/shared/read-tracker';
import { __setJournalStoreForTest } from '../../../src/main/journal/recorder';
import { createJournalStore } from '../../../src/main/journal/store';
import { migration033 } from '../../../src/main/storage/migrations/033_v2_5_change_journal';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);
const sha256 = (c: string): string => createHash('sha256').update(c).digest('hex');

let tmpDir: string;
let ctx: ToolContext;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-file-cipher-'));
  db = new Database(':memory:');
  db.exec(migration033.up);
  __setJournalStoreForTest(createJournalStore(db));
  ctx = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'ws-cipher',
    workspaceDir: tmpDir,
    skillRegistry: { list: () => [] } as never,
    streamSessionId: `ssn-${Date.now()}-${Math.random()}`,
    roomId: '!cipher:room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'test-user',
  };
});

afterEach(() => {
  __setJournalStoreForTest(null);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entriesOfThisStream() {
  return createJournalStore(db).listByStream('ws-cipher', ctx.streamSessionId);
}

describe('edit_file 密文安全闸', () => {
  it('密文文件拒绝编辑并明确报错，盘上字节保持不变', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    // 非 strict 通道：锁工具层自检（独立于 strictCipherCheck）
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: new DirectContentIo(false) });
    await expect(
      executeFileTool(
        'edit_file',
        { path: 'Enc.java', oldString: 'class', newString: 'interface' },
        ctx,
      ),
    ).rejects.toThrow(/已加密（E-SafeNet 容器）[\s\S]*Enc\.java/);
    expect(fs.readFileSync(path.join(tmpDir, 'Enc.java')).equals(CIPHER_HEAD)).toBe(true);
  });

  it('strict 通道（默认）下同样拒绝（通道 EENCRYPTED 硬失败先行）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    await expect(
      executeFileTool(
        'edit_file',
        { path: 'Enc.java', oldString: 'class', newString: 'interface' },
        ctx,
      ),
    ).rejects.toThrow(/加密/);
    expect(fs.readFileSync(path.join(tmpDir, 'Enc.java')).equals(CIPHER_HEAD)).toBe(true);
  });

  it('edit_file 写入经内容通道（contentIo 记录到写调用）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;\n');
    const writes: Array<{ p: string; data: Buffer }> = [];
    const io = new DirectContentIo(false);
    const recordingIo = {
      readFile: (p: string) => io.readFile(p),
      readFiles: (ps: string[]) => io.readFiles(ps),
      writeFile: (p: string, d: Buffer) => {
        writes.push({ p, data: d });
        return io.writeFile(p, d);
      },
    };
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: recordingIo });
    const out = await executeFileTool(
      'edit_file',
      { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' },
      ctx,
    );
    expect(out).toContain('已编辑');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.p).toBe(path.join(tmpDir, 'a.ts'));
    expect(writes[0]!.data.toString('utf8')).toBe('const x = 2;\n');
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('const x = 2;\n');
  });
});

describe('write_file journal null 快照（密文优雅降级）', () => {
  it('覆盖密文文件：before=null、写入照常、撤销守卫可定位', async () => {
    const abs = path.join(tmpDir, 'Enc.java');
    fs.writeFileSync(abs, CIPHER_HEAD);
    // 守门放行：tracker 记录的指纹与 assertRead fallback（磁盘密文 hash）同源
    const tracker = new ReadTracker();
    tracker.add('!cipher:room', abs, undefined, CIPHER_HEAD);
    ctx.readTracker = tracker;
    const out = await executeFileTool('write_file', { path: 'Enc.java', content: 'plain-new' }, ctx);
    expect(out).toContain('已写入');
    expect(fs.readFileSync(abs, 'utf8')).toBe('plain-new');
    const entries = entriesOfThisStream();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('modify');
    expect(entries[0]?.beforeHash).toBeNull();
    expect(entries[0]?.afterHash).toBe(sha256('plain-new'));
  });
});

describe('mv journal null 快照（密文优雅降级）', () => {
  it('移动密文单文件：rename 条目 before=null，rename 本体照常完成', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    const out = await executeFileTool('mv', { src: 'Enc.java', dst: 'Enc2.java' }, ctx);
    expect(out).toContain('已移动');
    expect(fs.existsSync(path.join(tmpDir, 'Enc.java'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'Enc2.java')).equals(CIPHER_HEAD)).toBe(true);
    const entries = entriesOfThisStream();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('rename');
    expect(entries[0]?.beforeHash).toBeNull();
    expect(entries[0]?.oldPath).toBe('Enc.java');
  });

  it('移动含密文文件的目录：逐文件 rename 条目，密文项 before=null、明文项正常', async () => {
    fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'Enc.java'), CIPHER_HEAD);
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'ok.ts'), 'ok');
    const out = await executeFileTool('mv', { src: 'pkg', dst: 'pkg2' }, ctx);
    expect(out).toContain('已移动');
    const entries = entriesOfThisStream();
    expect(entries).toHaveLength(2);
    const encEntry = entries.find((e) => e.path === 'pkg2/Enc.java');
    const okEntry = entries.find((e) => e.path === 'pkg2/ok.ts');
    expect(encEntry?.beforeHash).toBeNull();
    expect(okEntry?.beforeHash).toBe(sha256('ok'));
  });
});
