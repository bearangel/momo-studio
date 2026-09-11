// electron/src/main/journal/recorder.ts
//
// 变更账本记账层（v2.5 变更账本与撤销，Task 2）：五 op 记账 API。
//
// 设计定位：纯组装（hash → writeBlob → insert），**不修改工作区文件**——
// 工具层（file-tools / apply-patch-tools）先调 recordChange 完成记账，再做
// 实际写盘。recordDeleteTree 仅 fs walk 读取待删文件以 hash 出 before 内容
// 并落 blob（撤销时恢复用），不删除文件本身；其多条目经 insertMany 单事务
// 原子落库。recordChange 尾部挂 maybeEnforceQuota 配额节流（Task 6）。
//
// 存储注入：模块级 JournalStore 单例（与 memory/sandbox 同模式）。生产 boot
// 期由启动链调 setJournalStore 注入；测试经 __setJournalStoreForTest 注入
// 真实 createJournalStore(getDb())——mock store 会掩盖 hashContent sha256
// 真实语义与 blob 落盘路径漂移（momo-test-rules 铁律 1 + 5）。

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';
import { maybeEnforceQuota } from './quota';
import type { JournalStore } from './store';
import type { JournalEntry, JournalOp } from './types';

/** 记账上下文：调用方在工具执行入口一次性构造，避免每条 record 重复传 */
export interface RecordCtx {
  workspaceId: string;
  /** 可空：快速会话无任务 */
  taskId: string | null;
  /** 可空：取自记账时 ctx.roomId */
  sessionId: string | null;
  /** 归组键：消息行流 */
  streamSessionId: string;
  /** write_file / edit_file / apply_patch / rm / mv / undo */
  toolName: string;
}

let store: JournalStore | null = null;

/** 单调时钟：同毫秒紧凑记账（撤销对称条目、rollbackFileBefore 严格比较）依赖
 *  created_at 全序。Date.now() 连续调用可能同值，last 记录器内上一次值，
 *  保证严格递增。生产路径唯一时间源；测试 fakeTimers 场景单独走 vi 推进。 */
let lastCreatedAt = 0;
function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

/**
 * 生产接线：boot 链调用 setJournalStore(createJournalStore(getDb())) 完成注入。
 * 允许多次设置（运行期 store 重启场景）；传入 null 表示清空（主要用于测试）。
 */
export function setJournalStore(s: JournalStore | null): void {
  store = s;
}

/**
 * 测试接线：与 setJournalStore 同行为。命名遵循仓库惯例（__set*ForTest），
 * 测试 in-place 替换 store，无需重启 boot 链。
 */
export function __setJournalStoreForTest(s: JournalStore | null): void {
  store = s;
}

/**
 * 读取已注入的 store（revert 层消费同一注入源，保证记账与撤销看同一实例）；
 * 未注入返回 null，由调用方决定 fail-fast 语义。
 */
export function getJournalStore(): JournalStore | null {
  return store;
}

function requireStore(): JournalStore {
  if (!store) {
    throw new Error('journal store 未注入（生产：boot 链调用 setJournalStore；测试：__setJournalStoreForTest）');
  }
  return store;
}

/** sha256 hex 内容寻址；与 store.writeBlob 内容寻址存储契约一致 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 记一笔变更。先 hash before/after 字符串（null 跳过对应 blob 落盘），再写
 * 条目入 state.db。返回插入的 entry（带生成 id 与 createdAt），便于工具层
 * 在同一调用栈内联引用或回传。
 *
 * op 矩阵契约：
 *   - create：before=null, after=新内容
 *   - modify：before=旧内容, after=新内容
 *   - delete：before=待删内容, after=null
 *   - rename：before=旧路径内容, after=null, oldPath=旧路径
 *     （内容未变，故 afterHash=null；撤销只需旧内容）
 */
export function recordChange(
  rc: RecordCtx,
  filePath: string,
  op: JournalOp,
  before: string | null,
  after: string | null,
  oldPath?: string,
): JournalEntry {
  const s = requireStore();
  const entry = assembleEntry(rc, filePath, op, before, after, oldPath);
  s.insert(entry);
  // 配额节流：每 50 次记账触发一次滚动清理（失败只 warn，见 quota.ts）
  maybeEnforceQuota(rc.workspaceId);
  return entry;
}

/**
 * 组装一条条目：hash before/after（null 跳过对应 blob 落盘）并生成 entry 对象，
 * **不 insert**。recordChange 单条路径与 recordDeleteTree 批量路径共用，
 * 保证 op 校验与 blob 落盘语义单点。
 */
function assembleEntry(
  rc: RecordCtx,
  filePath: string,
  op: JournalOp,
  before: string | null,
  after: string | null,
  oldPath?: string,
): JournalEntry {
  const s = requireStore();

  if (op === 'rename' && oldPath == null) {
    throw new Error('rename 记账必须提供 oldPath');
  }

  let beforeHash: string | null = null;
  if (before !== null) {
    beforeHash = hashContent(before);
    s.writeBlob(rc.workspaceId, beforeHash, before);
  }

  let afterHash: string | null = null;
  if (after !== null) {
    afterHash = hashContent(after);
    s.writeBlob(rc.workspaceId, afterHash, after);
  }

  return {
    id: `je_${randomUUID()}`,
    workspaceId: rc.workspaceId,
    taskId: rc.taskId,
    sessionId: rc.sessionId,
    streamSessionId: rc.streamSessionId,
    toolName: rc.toolName,
    path: filePath,
    op,
    beforeHash,
    afterHash,
    oldPath: oldPath ?? null,
    createdAt: nextCreatedAt(),
  };
}

/**
 * 递归 walker：walk absRoot 下所有文件，回调每对 (abs, rel) 路径。
 * 空目录自然不回调（无文件可遍历）。不追踪符号链接——production 防御在
 * WorkspaceFS 层，recorder 只读工作区内路径，不引入新的越权面。
 */
function walkFiles(
  absRoot: string,
  relRoot: string,
  cb: (absPath: string, relPath: string) => void,
): void {
  for (const name of fs.readdirSync(absRoot)) {
    const abs = nodePath.join(absRoot, name);
    const rel = relRoot === '' ? name : nodePath.join(relRoot, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      walkFiles(abs, rel, cb);
    } else {
      cb(abs, rel);
    }
  }
}

/**
 * 递归 walk 一棵目录树，为每个文件记一条 delete 条目（含 before 内容 hash 与
 * blob 落盘）。工具层（rm 工具）随后再做实际删除——recorder 仅记账。
 *
 * 多条目经 insertMany 单事务原子落库（T4 review 移交）：整树 delete 记账
 * all-or-nothing，避免中途失败留下半棵树的撤销链。节流计数按条数累计。
 *
 * 边界：
 *   - relDir 不存在 → 返回空数组（不抛错）
 *   - relDir 是空目录 → 返回空数组（无文件可 hash）
 *   - relDir 是单文件 → 1 条 delete（walker 自然收敛）
 */
export function recordDeleteTree(
  rc: RecordCtx,
  workspaceDir: string,
  relDir: string,
): JournalEntry[] {
  // fail-fast：未注入立即抛错（即便 relDir 不存在也短路在 fs 之前）
  requireStore();
  const absDir = nodePath.join(workspaceDir, relDir);
  if (!fs.existsSync(absDir)) return [];

  const stat = fs.statSync(absDir);
  const files: Array<{ rel: string; content: string }> = [];
  if (stat.isDirectory()) {
    walkFiles(absDir, relDir, (abs, rel) => {
      files.push({ rel, content: fs.readFileSync(abs, 'utf8') });
    });
  } else {
    // 单文件边界：直接 1 条 delete
    files.push({ rel: relDir, content: fs.readFileSync(absDir, 'utf8') });
  }

  const entries = files.map((f) => assembleEntry(rc, f.rel, 'delete', f.content, null));
  if (entries.length > 0) {
    const s = requireStore();
    s.insertMany(entries);
    maybeEnforceQuota(rc.workspaceId, entries.length);
  }
  return entries;
}
