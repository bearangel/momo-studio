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
  it('全部工具名全部路由命中', () => {
    for (const n of ['office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel', 'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy']) {
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
    ctx.readTracker = new ReadTracker(); // 重置已读状态（create 落盘即标记已读，自复制目标须构造为未读）
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

describe('office_create_doc', () => {
  it('office_create_doc 覆盖已读目标：modify 记账且 beforeHash 非空、before blob 字节一致', async () => {
    await tools.execute('office_create_doc', { path: 'd.docx', sections: [{ type: 'para', text: 'v1' }] }, ctx);
    const v1Bytes = fs.readFileSync(path.join(tmpDir, 'd.docx'));
    await tools.execute('office_read', { path: 'd.docx' }, ctx);
    await tools.execute('office_create_doc', { path: 'd.docx', sections: [{ type: 'para', text: 'v2' }] }, ctx);
    const entries = getJournalStore()!.listByPath('ws-office', 'd.docx');
    const mod = entries.filter((e) => e.op === 'modify');
    expect(mod).toHaveLength(1);
    expect(mod[0]?.beforeHash).not.toBeNull();
    const beforeBlob = getJournalStore()!.readBlobBytes('ws-office', mod[0]!.beforeHash!);
    expect(beforeBlob).not.toBeNull(); // v1 文件字节（docx zip）
    expect(beforeBlob!.equals(v1Bytes)).toBe(true);
  });
});
