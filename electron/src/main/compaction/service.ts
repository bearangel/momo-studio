// electron/src/main/compaction/service.ts
//
// 主进程 CompactionService（spec §4.3，压缩改造 Task 3）：
//   - generateCompaction：结构化摘要生成（prior 自读 session_compactions 滚动合并）
//   - upsertSessionCompaction / getSessionCompaction：session_compactions 表读写
//     （migration v30；与 session_summaries 的 extraction 背景摘要语义分离）
//
// 设计要点：
//   - 失败一律 throw 中文错误（显式路径显式反馈）——/compact 命令路径直接透传给
//     renderer；子进程 IPC 路径由 runtime-spawner 分支捕获后回写 ok:false
//   - covered_until 由调用方决定（/compact 命令传最后被覆盖消息 createdAt；子进程
//     请求自带尾部起始消息 createdAt）——本模块不猜测游标语义
//   - LLM 解析链复用 extraction 的 resolveSessionLlm（会话 leader 模型，与记忆
//     提取/会话命名同源，spec §1 非目标「不引入 compaction 专用模型」）

import { getDb } from '../storage/db';
import { resolveSessionLlm } from '../memory/extraction';
import { buildCompactionPrompt } from './prompt';

/**
 * 结构化压缩摘要长度帽（spec §4.3 — 五节结构化摘要）。
 *
 * 解耦于 extraction 背景摘要的 SUMMARY_MAX_LEN = 500——结构化模板要求保留精确
 * 路径/符号/命令/错误串（spec §4.1），需要更大预算；extraction 的「背景摘要」
 * 是用户偏好摘要，不约束上述字段。两个常量并存，按用途各取。
 */
export const COMPACTION_SUMMARY_MAX_LEN = 4_000;

/** 会话压缩摘要行（session_compactions 单行 upsert 的读形状） */
export interface SessionCompaction {
  summary: string;
  /** 已被摘要覆盖的最后一条消息 createdAt（毫秒）——历史收缩游标 */
  coveredUntil: number;
}

/** 主进程 → 子进程的压缩结果线协议形状（spec §4.4；消费方 runtime-entry 按宽松形状解析） */
export interface CompactionResultMsg {
  type: 'compaction:result';
  /** 配对键：compaction:request 生成并由结果原样回传（单点生成沿线透传） */
  streamSessionId: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

/**
 * 读取会话压缩摘要（prior）。不存在返回 null。
 */
export function getSessionCompaction(sessionId: string): SessionCompaction | null {
  const row = getDb()
    .prepare('SELECT summary, covered_until AS coveredUntil FROM session_compactions WHERE session_id = ?')
    .get(sessionId) as SessionCompaction | undefined;
  return row ?? null;
}

/**
 * 会话压缩摘要 upsert（每会话单行；ON CONFLICT 整行替换）。
 * summary 落库前截断到 COMPACTION_SUMMARY_MAX_LEN 硬帽（防 LLM 异常超长输出）。
 */
export function upsertSessionCompaction(sessionId: string, summary: string, coveredUntil: number): void {
  getDb()
    .prepare(
      `INSERT INTO session_compactions (session_id, summary, covered_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         covered_until = excluded.covered_until,
         updated_at = excluded.updated_at`,
    )
    .run(sessionId, summary.slice(0, COMPACTION_SUMMARY_MAX_LEN), coveredUntil, Date.now());
}

/**
 * 生成结构化压缩摘要（spec §4.3）。
 *
 * 流程：读 prior（getSessionCompaction）→ resolveSessionLlm（null → throw 指向
 * 模型服务配置）→ buildCompactionPrompt（prior 滚动合并指令）→ llm.chat →
 * 空/失败 throw → slice(0, COMPACTION_SUMMARY_MAX_LEN) 硬帽。
 *
 * 注意：本函数只生成不落库——covered_until 由调用方决定后自行 upsert。
 */
export async function generateCompaction(input: {
  sessionId: string;
  /** 已序列化的头部对话（serializeMessages 产出） */
  conversation: string;
}): Promise<{ summary: string }> {
  const prior = getSessionCompaction(input.sessionId);

  const llm = await resolveSessionLlm(input.sessionId);
  if (!llm) {
    throw new Error('未配置可用模型服务（设置 → 模型服务），无法生成压缩摘要');
  }

  const prompt = buildCompactionPrompt({
    conversation: input.conversation,
    ...(prior ? { previousSummary: prior.summary } : {}),
  });

  let summary: string;
  try {
    const res = await llm.chat([{ role: 'user', content: prompt }]);
    summary = res.content.trim();
  } catch (err) {
    throw new Error(`压缩摘要生成失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!summary) {
    throw new Error('压缩摘要生成为空，请重试');
  }

  return { summary: summary.slice(0, COMPACTION_SUMMARY_MAX_LEN) };
}
