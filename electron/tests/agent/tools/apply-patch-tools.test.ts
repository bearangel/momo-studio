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

  it('add-then-fail：add 成功后 update 失败时，新增文件被回滚删除（严格 all-or-nothing）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'existing.ts'), 'original\n');
    // 构造 add → update(anchor 找不到) → add 的序列；update 失败触发回滚
    const patch = `*** Add File: new.ts
+content
*** Update File: existing.ts
@@ nonexistent anchor
-x
+y
*** Add File: another.ts
+another content
`;
    await expect(tools.execute('apply_patch', { patch }, ctx)).rejects.toThrow(/回滚/);
    // 关键断言：第一个 add 成功产生的 new.ts 必须被回滚删除（spec §6.1）
    expect(fs.existsSync(path.join(tmpDir, 'new.ts'))).toBe(false);
    // 第三个 add 在 update 失败后未执行，another.ts 本就不该存在
    expect(fs.existsSync(path.join(tmpDir, 'another.ts'))).toBe(false);
    // update 目标 existing.ts 走备份恢复，原始内容完整保留
    expect(fs.readFileSync(path.join(tmpDir, 'existing.ts'), 'utf-8')).toBe('original\n');
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

describe('execute — Add File 目标已存在守卫（回滚洞修复，终审 I1）', () => {
  it('Add 目标已存在：拒绝并报"已存在"，原文件内容不变', async () => {
    fs.writeFileSync(path.join(tmpDir, 'exists.ts'), 'original content');
    const patch = `*** Add File: exists.ts
+overwritten
`;
    await expect(tools.execute('apply_patch', { patch }, ctx)).rejects.toThrow(/已存在.*Update File/);
    // 关键断言：原文件未被覆盖
    expect(fs.readFileSync(path.join(tmpDir, 'exists.ts'), 'utf-8')).toBe('original content');
  });

  it('多 op patch 中任一 Add 目标已存在：验证阶段整体拒绝，先前的 add 未执行（无部分状态）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'dup.ts'), 'original');
    fs.writeFileSync(path.join(tmpDir, 'other.ts'), 'keep\n');
    const patch = `*** Add File: brand-new.ts
+x
*** Add File: dup.ts
+y
*** Update File: other.ts
@@ keep
-keep
+changed
`;
    await expect(tools.execute('apply_patch', { patch }, ctx)).rejects.toThrow(/已存在/);
    // 验证阶段拦截 → 排在 dup.ts 之前的 brand-new.ts 也未被创建（无部分状态）
    expect(fs.existsSync(path.join(tmpDir, 'brand-new.ts'))).toBe(false);
    // other.ts 未被 update 触碰
    expect(fs.readFileSync(path.join(tmpDir, 'other.ts'), 'utf-8')).toBe('keep\n');
    expect(fs.readFileSync(path.join(tmpDir, 'dup.ts'), 'utf-8')).toBe('original');
  });
});

describe('execute — 错误信息', () => {
  it('parser 错误透传给 LLM', async () => {
    const badPatch = '*** Unknown Op: foo\n';
    await expect(tools.execute('apply_patch', { patch: badPatch }, ctx)).rejects.toThrow(/未知.*op/);
  });
});
