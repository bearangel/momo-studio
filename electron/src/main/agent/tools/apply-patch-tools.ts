// electron/src/main/agent/tools/apply-patch-tools.ts
// v2.3 结构化 patch 工具（V4A 语法 + Lark-style parser + 多文件原子执行）。
// 与 FileTools 并存：edit_file / write_file 保留为简单场景 fallback。

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parsePatch, type PatchOp } from './apply-patch-parser';

export class ApplyPatchTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'apply_patch',
        description:
          '应用结构化 V4A patch：可一次原子操作多个文件（add / update / delete）。' +
          '失败自动回滚已应用部分。' +
          '适用场景：多文件协同修改；精准字符串替换（update_file）失败时的替代方案。',
        inputSchema: {
          type: 'object',
          properties: {
            patch: { type: 'string', description: 'V4A patch 文本（含 add/update/delete header）' },
          },
          required: ['patch'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === 'apply_patch';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name !== 'apply_patch') throw new Error(`未知 apply_patch 工具: ${name}`);
    const patchText = typeof args.patch === 'string' ? args.patch : '';
    return executePatch(patchText, ctx);
  }
}

async function executePatch(patchText: string, ctx: ToolContext): Promise<string> {
  const ast = parsePatch(patchText);

  // 1. 路径校验：所有 op 路径走 assertInWorkspace
  for (const op of ast.ops) {
    ctx.wsFs.assertInWorkspace(op.path);
  }

  // 2. 快照受影响文件到 Electron userData/apply-patch-tmp/<uuid>/
  const backupDir = path.join(app.getPath('userData'), 'apply-patch-tmp', randomUUID());
  fs.mkdirSync(backupDir, { recursive: true });
  for (const op of ast.ops) {
    if (op.kind === 'update' || op.kind === 'delete') {
      await snapshotFile(ctx, op.path, backupDir);
    }
  }

  // 3. 逐 op 执行
  let applied = 0;
  // 跟踪 add 成功的新文件路径——回滚时需删除（spec §6.1 严格 all-or-nothing）
  const addedFiles: string[] = [];
  try {
    for (const op of ast.ops) {
      await applyOp(op, ctx, addedFiles);
      applied++;
    }
  } catch (err) {
    // 4. 失败回滚
    await restoreFromBackup(backupDir, ctx);
    // 删除 add 成功但后续 op 失败产生的新文件——恢复备份不覆盖这部分
    for (const relPath of addedFiles) {
      const abs = ctx.wsFs.assertInWorkspace(relPath);
      if (fs.existsSync(abs)) fs.rmSync(abs);
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`apply_patch 失败，已回滚（已应用 ${applied}/${ast.ops.length} ops）: ${msg}`);
  }

  // 5. 成功清理
  fs.rmSync(backupDir, { recursive: true, force: true });
  return `已应用 ${applied} 个文件`;
}

async function snapshotFile(ctx: ToolContext, relPath: string, backupDir: string): Promise<void> {
  const abs = ctx.wsFs.assertInWorkspace(relPath);
  if (!fs.existsSync(abs)) return; // 文件不存在（delete 不需快照）
  const target = path.join(backupDir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(abs, target);
}

async function restoreFromBackup(backupDir: string, ctx: ToolContext): Promise<void> {
  if (!fs.existsSync(backupDir)) return;
  for (const file of walkDir(backupDir)) {
    const relPath = path.relative(backupDir, file);
    const target = path.join(ctx.workspaceDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
}

function* walkDir(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else yield full;
  }
}

async function applyOp(op: PatchOp, ctx: ToolContext, addedFiles: string[]): Promise<void> {
  switch (op.kind) {
    case 'add':
      await ctx.wsFs.writeFile(op.path, op.content);
      addedFiles.push(op.path);
      break;
    case 'update':
      {
        const current = (await ctx.wsFs.readFile(op.path)).toString('utf-8');
        const updated = applyHunk(current, op.hunk);
        await ctx.wsFs.writeFile(op.path, updated);
      }
      break;
    case 'delete': {
      const abs = ctx.wsFs.assertInWorkspace(op.path);
      await fs.promises.unlink(abs);
      break;
    }
  }
}

function applyHunk(content: string, hunk: { anchor: string; changes: Array<{ kind: ' ' | '-' | '+'; text: string }> }): string {
  // 简化版 hunk 应用：基于 anchor 找到第一个匹配行，按顺序应用 changes
  const lines = content.split('\n');
  const anchorIdx = lines.findIndex(line => line.includes(hunk.anchor));
  if (anchorIdx === -1) {
    throw new Error(`hunk anchor "${hunk.anchor}" 在文件中未找到`);
  }
  // 应用：从 anchor 行开始，按 changes 顺序处理
  // 简化：先验证所有 '-' 行在文件中存在；再替换为 '+' 行
  const result: string[] = [...lines];
  let offset = anchorIdx;
  for (const change of hunk.changes) {
    if (change.kind === ' ') {
      offset++;
    } else if (change.kind === '-') {
      if (result[offset] !== change.text) {
        throw new Error(`hunk 不匹配：期望 "${change.text}"，实际 "${result[offset]}"`);
      }
      result.splice(offset, 1);
    } else if (change.kind === '+') {
      result.splice(offset, 0, change.text);
      offset++;
    }
  }
  return result.join('\n');
}
