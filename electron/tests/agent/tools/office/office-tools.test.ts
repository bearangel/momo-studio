// OfficeTools 读侧全链路（spec 2026-11-03 §6 下线生成后：读/精读/复制三件；真实 tmp +
// 真实 WorkspaceFS + 真实 ReadTracker + 真实 journal store）。夹具经插件 vendor 生成库构造。
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
  it('只读三件全命中；已下线生成类不再命中（spec 2026-11-03 §6）', () => {
    for (const n of ['office_read', 'office_read_cells', 'office_copy']) {
      expect(tools.handles(n)).toBe(true);
    }
    for (const gone of ['office_create_excel', 'office_write_excel', 'office_create_doc', 'office_create_ppt', 'office_fill_ppt_template', 'office_create_pdf', 'read_file']) {
      expect(tools.handles(gone)).toBe(false);
    }
    expect(tools.getDefs().map((d) => d.name).sort()).toEqual(['office_copy', 'office_read', 'office_read_cells']);
  });
});



async function writeXlsxFixture(rel: string, sheetName = 'Sheet1'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(['数量']);
  ws.addRow([1]);
  await wb.xlsx.writeFile(path.join(tmpDir, rel));
}

describe('office_copy', () => {
  it('复制后字节一致；目标存在未读抛错', async () => {
    await writeXlsxFixture('src.xlsx');
    ctx.readTracker = new ReadTracker();
    fs.writeFileSync(path.join(tmpDir, 'dst.xlsx'), fs.readFileSync(path.join(tmpDir, 'src.xlsx')));
    await expect(tools.execute('office_copy', { from: 'src.xlsx', to: 'dst.xlsx' }, ctx)).rejects.toThrow(/office_read/);
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
  it('预览含 sheet 名标签；精读返回区域数据', async () => {
    await writeXlsxFixture('r.xlsx');
    const out = await tools.execute('office_read', { path: 'r.xlsx' }, ctx);
    expect(out).toContain('## Sheet: Sheet1');
    const cells = await tools.execute('office_read_cells', { path: 'r.xlsx', sheet: 'Sheet1' }, ctx);
    expect(cells).toContain('Sheet: Sheet1');
  });

  it('不支持扩展名与越界路径报错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'x');
    await expect(tools.execute('office_read', { path: 'a.txt' }, ctx)).rejects.toThrow(/不支持的文档格式/);
    await expect(tools.execute('office_read', { path: '../outside.xlsx' }, ctx)).rejects.toThrow();
  });

  it('预置 abortSignal：office_read 与 read_cells 立即返回已中断', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const abortedCtx = { ...ctx, abortSignal: ctl.signal };
    await writeXlsxFixture('a.xlsx');
    await expect(tools.execute('office_read', { path: 'a.xlsx' }, abortedCtx)).resolves.toBe('已中断');
    await expect(tools.execute('office_read_cells', { path: 'a.xlsx', sheet: 'Sheet1' }, abortedCtx)).resolves.toBe('已中断');
  });
});

// ── B 方案收口：密文安全闸（通道读 + 明确报错，不做垃圾解析）──

describe('office 密文安全闸（B 方案收口）', () => {
  const CIPHER_HEAD = Buffer.from(
    '62142365DA00260100000001452D536166654E65740000004C4F434B',
    'hex',
  );

  it('office_read 密文文档 → 明确报错（非「文件损坏」垃圾解析错误）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.xlsx'), CIPHER_HEAD);
    await expect(tools.execute('office_read', { path: 'Enc.xlsx' }, ctx)).rejects.toThrow(
      /加密[\s\S]*Enc\.xlsx/,
    );
  });

  it('office_read_cells 密文文档 → 同样明确报错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.xlsx'), CIPHER_HEAD);
    await expect(
      tools.execute('office_read_cells', { path: 'Enc.xlsx', sheet: 1 }, ctx),
    ).rejects.toThrow(/加密[\s\S]*Enc\.xlsx/);
  });

  it('office_copy 密文源 → 拒绝复制，目标不产生', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.xlsx'), CIPHER_HEAD);
    await expect(
      tools.execute('office_copy', { from: 'Enc.xlsx', to: 'copy.xlsx' }, ctx),
    ).rejects.toThrow(/加密[\s\S]*Enc\.xlsx/);
    expect(fs.existsSync(path.join(tmpDir, 'copy.xlsx'))).toBe(false);
  });

  it('office_copy 目标为密文 → journal before=null，复制照常', async () => {
    await writeXlsxFixture('src.xlsx');
    fs.writeFileSync(path.join(tmpDir, 'dst.xlsx'), CIPHER_HEAD);
    // 覆盖场景守门放行：tracker 指纹与磁盘密文字节同源
    ctx.readTracker = new ReadTracker();
    ctx.readTracker.add('!office:room', path.join(tmpDir, 'dst.xlsx'), undefined, CIPHER_HEAD);
    const out = await tools.execute('office_copy', { from: 'src.xlsx', to: 'dst.xlsx' }, ctx);
    expect(out).toContain('已复制');
    const entries = getJournalStore()?.listByStream('ws-office', ctx.streamSessionId) ?? [];
    const e = entries.find((x) => x.op === 'modify');
    expect(e?.beforeHash).toBeNull();
  });
});
