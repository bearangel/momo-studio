// electron/tests/agent/tools/file-tools-read-gate.test.ts
// v2.3 Read-before-Edit：edit_file / write_file（覆盖场景）必须先 read_file。
// 走 FileTools.execute 全链路（真实 tmp 目录 + 真实 WorkspaceFS + 真实 ReadTracker）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { FileTools } from '../../../src/main/agent/tools/file-tools';
import { ReadTracker } from '../../../src/main/agent/tools/shared/read-tracker';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { SkillRegistry } from '../../../src/main/skill/registry';
import type { ToolContext } from '../../../src/main/agent/tools/types';

let tmpDir: string;
let ctx: ToolContext;
let tools: FileTools;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v23-readgate-'));
  ctx = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: new SkillRegistry(),
    streamSessionId: 'test-ssn',
    roomId: '!test:room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'test-user',
    readTracker: new ReadTracker(),
  };
  tools = new FileTools();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('edit_file — Read-before-Edit 强阻塞', () => {
  it('未 read_file 直接 edit_file 抛错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await expect(tools.execute('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }, ctx)).rejects.toThrow(/未读取/);
  });

  it('read_file 后再 edit_file 成功', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await tools.execute('read_file', { path: 'a.ts' }, ctx);
    await expect(tools.execute('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }, ctx)).resolves.toContain('已编辑');
  });

  it('readTracker 未注入时不阻塞（向后兼容）', async () => {
    const ctxNoTracker = { ...ctx, readTracker: undefined };
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await expect(tools.execute('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }, ctxNoTracker)).resolves.toContain('已编辑');
  });

  it('子 agent（parentStreamSessionId 非空）永远 fresh，edit_file 抛错', async () => {
    const childCtx = { ...ctx, streamSessionId: 'child', parentStreamSessionId: 'parent' };
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    await expect(tools.execute('edit_file', { path: 'a.ts', oldString: 'const x = 1;', newString: 'const x = 2;' }, childCtx)).rejects.toThrow(/未读取/);
  });
});

describe('write_file — Read-before-Edit（仅覆盖场景）', () => {
  it('新文件 write_file 不需先 Read（豁免）', async () => {
    await expect(tools.execute('write_file', { path: 'new.ts', content: 'export const x = 1;' }, ctx)).resolves.toContain('已写入');
  });

  it('已有文件未 Read 时 write_file 抛错', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old');
    await expect(tools.execute('write_file', { path: 'existing.ts', content: 'new' }, ctx)).rejects.toThrow(/未读取/);
  });

  it('已有文件 read_file 后再 write_file 成功', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'old');
    await tools.execute('read_file', { path: 'existing.ts' }, ctx);
    await expect(tools.execute('write_file', { path: 'existing.ts', content: 'new' }, ctx)).resolves.toContain('已写入');
  });

  it('write_file 成功后自动标记为已读（让后续 edit_file 通过守门）', async () => {
    // 注：brief 原稿此处对「已有未读文件」直接 write_file，与上一用例「已有文件未读抛错」矛盾；
    // 按用例名语义改为「新文件写入（豁免守门）→ 后续 edit_file 无需 read_file 即通过」，
    // 专门锁定 write_file 成功后自动标记已读的行为。
    await expect(tools.execute('write_file', { path: 'fresh.ts', content: 'new' }, ctx)).resolves.toContain('已写入');
    await expect(tools.execute('edit_file', { path: 'fresh.ts', oldString: 'new', newString: 'newer' }, ctx)).resolves.toContain('已编辑');
  });
});
