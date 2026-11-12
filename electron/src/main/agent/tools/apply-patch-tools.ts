// electron/src/main/agent/tools/apply-patch-tools.ts
// v2.3 结构化 patch 工具（V4A 语法 + Lark-style parser + 多文件原子执行）。
// 与 FileTools 并存：edit_file / write_file 保留为简单场景 fallback。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import { parsePatch, type PatchOp } from './apply-patch-parser';
import type { RecordCtx } from '../../journal/recorder';
import {
  buildRecordCtx,
  toJournalRelPath,
  recordChangeSafe,
} from './shared/change-journal';
import { assertNotCipher } from './shared/cipher-gate';
import { runWithWriteGrant } from './write-grant-tool';

// 类外常量（Tier 划分见 spec §3）：
const APPLY_PATCH_CATALOG_META: Record<string, ToolMeta> = {
  apply_patch: { displayName: '结构化补丁', category: '原子补丁', categoryEmoji: '🧩', defaultOn: false, riskNote: '多文件批量修改' },
};

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

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), APPLY_PATCH_CATALOG_META);
  }

  handles(name: string): boolean {
    return name === 'apply_patch';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name !== 'apply_patch') throw new Error(`未知 apply_patch 工具: ${name}`);
    const patchText = typeof args.patch === 'string' ? args.patch : '';
    // 首个 op 路径作上报预览（解析失败留空——非法 patch 由 executePatch 原样抛）
    let firstPath = '';
    try {
      firstPath = parsePatch(patchText).ops[0]?.path ?? '';
    } catch {
      /* 非法 patch：不进门控，直接走原执行路径抛解析错误 */
    }
    return runWithWriteGrant(ctx, 'apply_patch', firstPath, () => executePatch(patchText, ctx));
  }
}

async function executePatch(patchText: string, ctx: ToolContext): Promise<string> {
  const ast = parsePatch(patchText);

  // 1. 路径校验：所有 op 路径走 assertInWorkspace；
  //    Add File 目标已存在 → 整个 patch 拒绝（V4A 语义，对齐 Codex：Add 只创建新文件）。
  //    必须在执行阶段之前拦截——否则 add-overwrite 成功后若后续 op 失败，回滚的
  //    addedFiles 清理会删掉被覆盖的原文件且无备份（终审 I1 回滚洞）
  //    update / delete 补 Read-before-Edit 守门（2026-09-26 对齐 file-tools：
  //    原先完全旁路——未读文件可经 patch 改删）；add 创建新文件豁免
  //    B 方案收口：update / delete 目标现内容在此经通道读取 + 密文安全闸
  //    （密文 → 拒绝整个 patch，宁报错不毁文件）；读到的字节缓存给 applyOp
  //    复用（hunk 应用 / delete 记账 / 守门指纹同源，消除同文件二次读）
  const currentBuffers = new Map<string, Buffer>();
  for (const op of ast.ops) {
    const abs = ctx.wsFs.assertInWorkspace(op.path);
    if (op.kind === 'add' && fs.existsSync(abs)) {
      throw new Error(`apply_patch 失败: Add File 目标已存在: ${op.path}（如需修改请用 Update File）`);
    }
    if (op.kind !== 'add') {
      let cur: Buffer | null = null;
      if (fs.existsSync(abs)) {
        cur = await ctx.wsFs.readFile(op.path);
        assertNotCipher(cur, op.path);
        currentBuffers.set(op.path, cur);
      }
      ctx.readTracker?.assertRead(ctx.roomId, ctx.parentStreamSessionId, abs, cur ?? undefined);
    }
  }

  // 2. 快照受影响文件到 <userDataDir|tmpdir>/apply-patch-tmp/<uuid>/。
  //    本工具在 runtime 子进程执行（无 electron API，顶层 import 即崩）——
  //    userData 路径由主进程经 AGENT_CONFIG 定型注入 ctx.userDataDir，
  //    缺省（测试直调 / 旧配置）回退 os.tmpdir()
  const backupDir = path.join(ctx.userDataDir ?? os.tmpdir(), 'apply-patch-tmp', randomUUID());
  fs.mkdirSync(backupDir, { recursive: true });
  for (const op of ast.ops) {
    if (op.kind === 'update' || op.kind === 'delete') {
      await snapshotFile(ctx, op.path, backupDir);
    }
  }

  // 3. 逐 op 执行（applyOp 返回写后内容——add/update 供第 5 步注册读取指纹）
  let applied = 0;
  // 跟踪 add 成功的新文件路径——回滚时需删除（spec §6.1 严格 all-or-nothing）
  const addedFiles: string[] = [];
  // v2.5 变更账本：单次 patch 共用一个 RecordCtx，逐 op 写前记账（applyOp 内）；
  // 失败回滚产生的孤儿条目由 revert 的 no-op 守卫兜底（内容已还原 → hash==beforeHash）
  const jrc = buildRecordCtx('apply_patch', ctx);
  const finalContents: Array<string | null> = [];
  try {
    for (const op of ast.ops) {
      finalContents.push(await applyOp(op, ctx, addedFiles, jrc, currentBuffers));
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

  // 5. 成功清理 + 写后注册读取指纹（add/update 产物 agent 已知晓内容，
  //    后续 edit_file 免重读；delete 无文件可注册。B 方案收口：内容直接
  //    来自 applyOp 产物，无二次磁盘回读）
  fs.rmSync(backupDir, { recursive: true, force: true });
  ast.ops.forEach((op, i) => {
    if (op.kind === 'add' || op.kind === 'update') {
      const content = finalContents[i];
      if (content !== null && content !== undefined) {
        ctx.readTracker?.add(
          ctx.roomId,
          ctx.wsFs.assertInWorkspace(op.path),
          ctx.parentStreamSessionId,
          content,
        );
      }
    }
  });
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

/** 单 op 执行。返回写后内容（add=patch 内容、update=hunk 产物；delete=null），
 *  供成功后注册读取指纹。currentBuffers 是第 1 步缓存的通道读字节（防二次读）。 */
async function applyOp(
  op: PatchOp,
  ctx: ToolContext,
  addedFiles: string[],
  jrc: RecordCtx,
  currentBuffers: Map<string, Buffer>,
): Promise<string | null> {
  switch (op.kind) {
    case 'add':
      // v2.5：add 的 after 即写入内容；Add 已在路径校验阶段拦截目标已存在
      recordChangeSafe(jrc, toJournalRelPath(ctx, op.path), 'create', null, op.content);
      await ctx.wsFs.writeFile(op.path, op.content);
      addedFiles.push(op.path);
      return op.content;
    case 'update':
      {
        // 缓存未命中（理论上仅竞态窗口）退化为通道读，语义与第 1 步一致
        const currentBuf = currentBuffers.get(op.path) ?? (await ctx.wsFs.readFile(op.path));
        assertNotCipher(currentBuf, op.path);
        const current = currentBuf.toString('utf-8');
        const updated = applyHunk(current, op.hunk);
        // v2.5：hunk 应用成功后、写盘前记账（before=快照循环同源的旧内容）
        recordChangeSafe(jrc, toJournalRelPath(ctx, op.path), 'modify', current, updated);
        await ctx.wsFs.writeFile(op.path, updated);
        return updated;
      }
    case 'delete': {
      const abs = ctx.wsFs.assertInWorkspace(op.path);
      // v2.5：删除前读内容记账（快照循环只 copyFile 供回滚，账本需要字符串内容）；
      // 内容优先取第 1 步缓存（B 方案收口：经通道读 + 已过密文闸）；
      // 目标不存在时 deletePath 原样抛 ENOENT（既有行为），不产生条目
      const beforeBuf =
        currentBuffers.get(op.path) ??
        (fs.existsSync(abs) ? await ctx.wsFs.readFile(op.path) : null);
      if (beforeBuf !== null) {
        assertNotCipher(beforeBuf, op.path);
        recordChangeSafe(jrc, toJournalRelPath(ctx, op.path), 'delete', beforeBuf.toString('utf-8'), null);
      }
      await ctx.wsFs.deletePath(op.path);
      return null;
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
