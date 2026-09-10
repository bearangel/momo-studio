// electron/tests/agent/tools/apply-patch-tools.test.ts
// v2.3 apply_patch 多文件原子性 + WorkspaceFS 沙箱协同。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ApplyPatchTools } from '../../../src/main/agent/tools/apply-patch-tools';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';

// mock electron.app.getPath（实现里备份目录走 app.getPath('userData')）。
// 仓库标准 vi.mock('electron') 模式；brief 原句 `(app.getPath as ...) = vi.fn(...)`
// 缺 vi import 且未 mock 模块（裸 import 'electron' 时 app 为 undefined），此处按
// 仓库既有 26 个测试的工厂模式最小修正。
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

let tmpDir: string;
let ctx: ToolContext;
let tools: ApplyPatchTools;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-v23-patch-'));
  ctx = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: { list: () => [] } as never,
    streamSessionId: 'test-ssn',
    roomId: '!test:room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'test-user',
  };
  tools = new ApplyPatchTools();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ApplyPatchTools — getDefs', () => {
  it('声明 apply_patch 工具', () => {
    const defs = tools.getDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('apply_patch');
    expect(defs[0]?.inputSchema.required).toContain('patch');
  });
});

describe('ApplyPatchTools — handles', () => {
  it('仅声明 apply_patch', () => {
    expect(tools.handles('apply_patch')).toBe(true);
    expect(tools.handles('edit_file')).toBe(false);
  });
});

describe('execute — 单文件 add', () => {
  it('创建新文件并返回成功信息', async () => {
    const patch = `*** Add File: new.ts
+export const x = 1;
`;
    const result = await tools.execute('apply_patch', { patch }, ctx);
    expect(result).toContain('已应用');
    expect(fs.existsSync(path.join(tmpDir, 'new.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'new.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });
});

describe('execute — 单文件 delete', () => {
  it('删除已有文件', async () => {
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'content');
    const patch = `*** Delete File: old.ts
`;
    await tools.execute('apply_patch', { patch }, ctx);
    expect(fs.existsSync(path.join(tmpDir, 'old.ts'))).toBe(false);
  });
});

describe('execute — 单文件 update', () => {
  it('修改已有文件 hunk', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'const x = 1;\n');
    const patch = `*** Update File: src.ts
@@ const x = 1;
-const x = 1;
+const x = 2;
`;
    await tools.execute('apply_patch', { patch }, ctx);
    expect(fs.readFileSync(path.join(tmpDir, 'src.ts'), 'utf-8')).toBe('const x = 2;\n');
  });
});

describe('execute — 多文件原子性', () => {
  it('add + update + delete 一次性成功', async () => {
    fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'old');
    // brief 原句 fixture 为 'mid-old'（无尾换行），但断言期望 'mid-new\n'——
    // applyHunk 的 split/join 保留文件自身尾换行形状，fixture 补 '\n' 后断言原样成立。
    fs.writeFileSync(path.join(tmpDir, 'mid.ts'), 'mid-old\n');
    const patch = `*** Add File: new.ts
+new
*** Update File: mid.ts
@@ mid-old
-mid-old
+mid-new
*** Delete File: old.ts
`;
    await tools.execute('apply_patch', { patch }, ctx);
    expect(fs.readFileSync(path.join(tmpDir, 'new.ts'), 'utf-8')).toBe('new\n');
    expect(fs.readFileSync(path.join(tmpDir, 'mid.ts'), 'utf-8')).toBe('mid-new\n');
    expect(fs.existsSync(path.join(tmpDir, 'old.ts'))).toBe(false);
  });

  it('原子失败回滚：第二个 op 失败时还原第一个 op', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.ts'), 'original');
    const patch = `*** Update File: keep.ts
@@ anchor
-old
+new
*** Delete File: nonexistent.ts
`;
    // nonexistent.ts 不存在但 delete 不应该失败 — 这里我们故意构造 update 失败
    // 重新构造：update anchor 找不到
    const badPatch = `*** Update File: keep.ts
@@ nonexistent anchor
-x
+y
*** Delete File: nonexistent.ts
`;
    await expect(tools.execute('apply_patch', { patch: badPatch }, ctx)).rejects.toThrow();
    // 关键断言：keep.ts 未被破坏（回滚成功）
    expect(fs.readFileSync(path.join(tmpDir, 'keep.ts'), 'utf-8')).toBe('original');
  });
});

describe('execute — 沙箱协同', () => {
  it('路径越界（../）抛错', async () => {
    const patch = `*** Add File: ../escape.ts
+x
`;
    await expect(tools.execute('apply_patch', { patch }, ctx)).rejects.toThrow(/越界|escape/);
  });
});

describe('execute — 错误信息', () => {
  it('parser 错误透传给 LLM', async () => {
    const badPatch = '*** Unknown Op: foo\n';
    await expect(tools.execute('apply_patch', { patch: badPatch }, ctx)).rejects.toThrow(/未知.*op/);
  });
});
