// electron/src/main/memory/extraction.ts
//
// v2.2 记忆 P2 Task 3：自动提取管线核心 + 会话压缩（spec §6.4 / §6.5）。
//
// 设计要点：
//   - LLM 解析链复刻 session-naming 的 fire-and-forget 范本（findReceptionAgent →
//     getAgentDefinition → getProvider → resolveApiKey → createLLMProvider → chat）。
//   - ADD-only prompt（Mem0 模式）：只产出候选，不下达更新/删除指令，降低幻觉成本。
//   - 9 步行为（spec §6.4 逐条）：gate → debounce → window → single LLM chat →
//     ADD-only JSON → fault-tolerant parse → BM25 dedup → insertMemory(source='auto') →
//     session_summaries upsert + covered_until cursor。
//   - 铁律（spec §8）：绝不阻塞会话/任务主链路。runExtraction 自身有 try/catch 兜底，
//     scheduleExtraction 再包一层 catch（双保险，logger 降级）。
//   - 失败不占去抖窗口：失败路径 delete debounce mark，下个触发点自然重试（spec §8）。
//   - memoryExtractionEnabled 字段由 Task 5 正式接入 GlobalSettings；本模块按
//     `(getGlobalSettings() as GlobalSettings & { memoryExtractionEnabled?: boolean })`
//     防御性读取 + 缺省 true。getGlobalSettings 当前会丢弃未知字段——Task 5 落地后
//     crud.ts 返回该字段，此处零改动即工作。
import { getDb } from '../storage/db';
import { getSession } from '../storage/sessions/repo';
import { getAgentDefinition } from '../agent/crud';
import { getProvider } from '../agent/provider-crud';
import { resolveApiKey } from '../agent/spawn-helpers';
import { createLLMProvider, type LLMMessage, type LLMProvider } from '../agent/llm-provider';
import { getGlobalSettings, type GlobalSettings } from '../settings/crud';
import { insertMemory } from '../storage/memories/repo';
import { getMemoryProvider } from './index';
import type { ConversationContext, ContextMessage } from './types';
import { logger } from '../logger';

/** 同会话两次提取间最短间隔（毫秒；spec §6.4 去抖） */
export const EXTRACTION_DEBOUNCE_MS = 10 * 60 * 1000;
/** 会话压缩阈值：会话总消息数超过此值时要求 LLM 顺带产出 session_summary */
export const SESSION_COMPRESS_THRESHOLD = 40;
/** 触发点轮次间隔（任务收尾 / 用户消息 % 此值 === 0；供 Task 4 接线引用） */
export const TRIGGER_TURN_INTERVAL = 20;

/** 对话窗口条数上限（spec §6.4 拉取窗口「最近 50 条」） */
const WINDOW_LIMIT = 50;
/** 进入 LLM 流程所需的窗口内最小用户消息数 */
const MIN_USER_MESSAGES = 2;
/** 去重前缀长度：取候选 content 前 N 字作为 BM25 检索的 query */
const DEDUP_PREFIX_LEN = 40;
/** 去重重叠判定长度：首条命中与候选的前 N 字包含关系 */
const OVERLAP_LEN = 20;
/** 自动提取产出的固定 confidence（spec §5.3：自动 0.7） */
const AUTO_CONFIDITY = 0.7;
/** 单条消息正文在 prompt 中的截断上限：防止 50×大消息打爆 LLM 上下文 */
const TRANSCRIPT_LINE_MAX = 1000;
/** session_summary 文本上限：spec §6.4 要求「200 字以内」；此处 500 为防 LLM 异常超长输出的安全硬帽 */
const SUMMARY_MAX_LEN = 500;

/** 模块级去抖表：sessionId → 上次成功启动提取的时间戳（毫秒） */
const lastRunAtBySession = new Map<string, number>();

/** 测试用：清空去抖表与重置相关模块级状态（每个用例 fresh 起跑） */
export function __resetExtractionStateForTest(): void {
  lastRunAtBySession.clear();
}

/**
 * fire-and-forget 调度包装。void + 全 catch + logger.warn，
 * 永不向调用方抛出/拒绝（spec §8：绝不阻塞会话/任务主链路）。
 */
export function scheduleExtraction(sessionId: string, opts?: { taskId?: string | null }): void {
  void runExtraction(sessionId, opts).catch((err: unknown) => {
    logger.warn('记忆提取未捕获异常（不影响会话）', {
      sessionId,
      taskId: opts?.taskId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * 主入口：执行一次完整提取 + 会话压缩流程。导出供触发接线（Task 4）与测试调用。
 *
 * 行为（spec §6.4 逐条，编号对应 plan 步骤）：
 *  1. gate：memoryEnabled && memoryExtractionEnabled 任一为假 → 直接返回
 *  2. 去抖：同会话 10 分钟内已启动 → 跳过
 *  3. 窗口：getConversationContext(sessionId, {limit:50})；用户消息 <2 → 跳过
 *  4. LLM：一次 chat() 调用，system prompt 要求 JSON-only（ADD-only）
 *  5. 解析容错：平衡块 → 失败 → 逐对象扫描 salvage；非白名单 kind 丢弃
 *  6. 去重：searchMemories(contentPrefix40, {workspaceId, sessionId:null})；
 *           首条命中与候选前 20 字包含关系 → 跳过
 *  7. 落库：insertMemory({source:'auto', pinned:0, confidence:0.7, tags})
 *  8. 会话压缩：总消息数 >40 且 session_summary 非空 → upsert session_summaries
 *  9. logger.info 计数（提取 N / 跳过 M / 压缩 yes|no）
 *
 * 失败语义：catch 兜底（spec §8）；失败路径 delete debounce mark，下个触发点自然重试。
 * 注意 runExtraction 本身不向调用方抛错，但导出 async 是为了测试用 await 串行断言；
 * scheduleExtraction 是真实生产入口（fire-and-forget）。
 */
export async function runExtraction(sessionId: string, opts?: { taskId?: string | null }): Promise<void> {
  try {
    await runExtractionInner(sessionId, opts);
  } catch (err) {
    // 失败不占去抖窗口（spec §8：下个触发点自然重试）
    lastRunAtBySession.delete(sessionId);
    logger.error('记忆提取失败（不影响会话/任务）', {
      sessionId,
      taskId: opts?.taskId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── 内部实现 ────────────────────────────────────────────────────────────────

async function runExtractionInner(sessionId: string, opts?: { taskId?: string | null }): Promise<void> {
  // 1. gate：总开关 + 提取开关（后者 Task 5 落地；当前缺省视为启用）
  const settings = getGlobalSettings() as GlobalSettings & { memoryExtractionEnabled?: boolean };
  if (!settings.memoryEnabled) return;
  if (!(settings.memoryExtractionEnabled ?? true)) return;

  // 2. 去抖
  const now = Date.now();
  const last = lastRunAtBySession.get(sessionId);
  if (last !== undefined && now - last < EXTRACTION_DEBOUNCE_MS) return;

  // 3. 窗口与会话上下文
  const session = getSession(sessionId);
  if (!session) {
    logger.warn('记忆提取：会话不存在，跳过', { sessionId });
    return;
  }
  // 取最近 WINDOW_LIMIT 条窗口（spec §6.4「最近 50 条」语义）。
  // 直接 DESC LIMIT 取最新 50 条，再反转保 ASC 时间序（与 provider getConversationContext
  // 返回形态对齐）；reviewer 初版建议的 `beforeTs: MAX+1` 实测 ASC LIMIT 仍返回最早 50
  // （ASC + 上界 = 过滤后取最小），无法实现「最近 50」意图。本实现走 SQL 直读，复用
  // messageToContext 做 sender→role 映射（与 sqlite-provider 同款语义）。
  const ctx = await fetchLatestWindow(sessionId);
  const userMsgCount = ctx.messages.filter((m) => m.role === 'user').length;
  if (userMsgCount < MIN_USER_MESSAGES) return;

  const totalMessages = countSessionMessages(sessionId);
  const compressing = totalMessages > SESSION_COMPRESS_THRESHOLD;
  const priorSummary = compressing ? readPriorSummary(sessionId) : null;

  // 通过 gate + 窗口后立即占用去抖 mark：防同会话并发双跑；
  // 后续 LLM/解析/落库任一抛错由 runExtraction 兜底并 delete 本 mark。
  lastRunAtBySession.set(sessionId, Date.now());

  // 4. LLM：解析链复刻 session-naming（leader → def → provider → key → chat）
  const llm = await resolveSessionLlm(sessionId);
  if (!llm) return; // resolveSessionLlm 已 warn；不解 mark——10 分钟内的重复触发同样会因同一 leader
  // / provider 配置缺失而失败，连续打满错误日志与无谓 DB 查询；防锤击有意保留去抖 mark。
  const res = await llm.chat(buildExtractionMessages(ctx.messages, compressing, priorSummary));

  // 5. 解析容错
  const parsed = parseExtractionOutput(res.content);

  // 6+7. 去重 + 落库（单候选 try/catch：单条异常不中断批处理）
  let extracted = 0;
  let skipped = 0;
  for (const cand of parsed.candidates) {
    try {
      if (await isDuplicate(cand, session.workspaceId)) {
        skipped++;
        logger.info('记忆提取：去重跳过候选', {
          sessionId,
          kind: cand.kind,
          scope: cand.scope,
          contentPrefix: cand.content.slice(0, OVERLAP_LEN),
        });
        continue;
      }
      insertMemory({
        scope: cand.scope,
        workspaceId: cand.scope === 'workspace' ? session.workspaceId : null,
        sessionId: null, // 自动提取不落会话层（spec §6.4）
        kind: cand.kind,
        content: cand.content,
        tags: cand.tags,
        pinned: false,
        source: 'auto',
        sourceDetail: `extraction${opts?.taskId ? `:task:${opts.taskId}` : ''}`,
        confidence: AUTO_CONFIDITY,
      });
      extracted++;
    } catch (err) {
      logger.error('候选记忆落库失败，跳过该条', {
        sessionId,
        kind: cand.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 8. 会话压缩：仅 >40 且 LLM 返回非空 session_summary 时 upsert
  let compressed = false;
  if (compressing && parsed.sessionSummary && parsed.sessionSummary.trim()) {
    const coveredUntil = ctx.messages[ctx.messages.length - 1]?.timestamp ?? now;
    const summary = parsed.sessionSummary.trim().slice(0, SUMMARY_MAX_LEN);
    getDb()
      .prepare(
        `INSERT INTO session_summaries (session_id, summary, covered_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary = excluded.summary,
           covered_until = excluded.covered_until,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, summary, coveredUntil, Date.now());
    compressed = true;
  }

  // 9. 完成日志
  logger.info('记忆提取完成', {
    sessionId,
    taskId: opts?.taskId ?? null,
    totalMessages,
    extracted,
    skipped,
    compressed: compressed ? 'yes' : 'no',
  });
}

// ─── LLM 解析链（复刻 session-naming） ────────────────────────────────────────

interface ReceptionAgent {
  instanceId: string;
  agentDefinitionId: string;
}

/** 接待成员 = session_members.is_leader JOIN 出 def 引用（与 session-naming.findReceptionAgent 同源） */
function findReceptionAgent(sessionId: string): ReceptionAgent | null {
  const row = getDb()
    .prepare(
      `SELECT m.instance_id AS instanceId, a.agent_definition_id AS agentDefinitionId
       FROM session_members m
       JOIN workspace_agent_members a ON m.instance_id = a.instance_id
       WHERE m.session_id = ? AND m.is_leader = 1
       ORDER BY m.added_at ASC
       LIMIT 1`,
    )
    .get(sessionId) as ReceptionAgent | undefined;
  return row ?? null;
}

/**
 * 复刻 session-naming.generateLlmTitle 的解析链（findReceptionAgent → getAgentDefinition →
 * getProvider → resolveApiKey → createLLMProvider）。任一环节缺失/抛错返回 null 并 warn，
 * 调用方据此静默跳过本轮提取。
 */
async function resolveSessionLlm(sessionId: string): Promise<LLMProvider | null> {
  const reception = findReceptionAgent(sessionId);
  if (!reception) {
    logger.warn('记忆提取：会话无接待成员（is_leader），跳过', { sessionId });
    return null;
  }
  const def = getAgentDefinition(reception.agentDefinitionId);
  if (!def?.modelProviderId) {
    logger.warn('记忆提取：接待 agent 缺失或未配置供应商，跳过', {
      sessionId,
      instanceId: reception.instanceId,
    });
    return null;
  }
  const provider = getProvider(def.modelProviderId);
  if (!provider) {
    logger.warn('记忆提取：供应商不存在（ghost provider），跳过', {
      sessionId,
      providerId: def.modelProviderId,
    });
    return null;
  }
  try {
    const apiKey = await resolveApiKey(reception.instanceId, def.modelProviderId);
    return createLLMProvider(
      { provider: provider.platform, model: def.modelName, baseUrl: provider.baseUrl },
      apiKey,
    );
  } catch (err) {
    logger.warn('记忆提取：解析 API key 失败，跳过', {
      sessionId,
      providerId: def.modelProviderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── prompt 拼装 ─────────────────────────────────────────────────────────────

function buildExtractionMessages(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  compressing: boolean,
  priorSummary: string | null,
): LLMMessage[] {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, TRANSCRIPT_LINE_MAX)}`)
    .join('\n');

  const summaryField = compressing ? ',"session_summary":"..."' : '';
  const summaryRules = compressing
    ? `- session_summary：用不超过 200 字的中文总结整个会话（目标/已做决策/未完成事项/关键文件与标识符）
- 若提供了既有摘要，请在既有基础上融合续写为一份完整摘要（不是追加两段独立摘要）`
    : '本会话消息数未达压缩阈值，不要输出 session_summary 字段';

  const system =
    `你是记忆提取器，分析对话窗口提取值得长期保留的用户偏好与新知识${compressing ? '，并为长会话生成滚动摘要' : ''}。
只输出一个 JSON 对象，不要任何解释、Markdown 代码块或其他文本，格式：
{"memories":[{"kind":"preference|knowledge|summary","content":"...","tags":["..."],"scope":"global"|"workspace"}]${summaryField}}
提取规则（ADD-only）：
- 只提取新信息：只产候选记忆，绝不输出更新或删除既有记忆的指令
- kind 白名单：preference=用户偏好；knowledge=事实知识；summary=任务/阶段要点
- scope：跨项目通用的偏好/知识选 global，仅与当前项目相关选 workspace（缺省 workspace）
- content 为简洁中文陈述句；没有值得提取的内容时 memories 为空数组
${summaryRules}`;

  const userSections: string[] = [];
  if (priorSummary) {
    userSections.push(`既有会话摘要（融合续写基础）：\n${priorSummary}`);
  }
  userSections.push(`对话窗口（按时间升序，共 ${messages.length} 条）：\n${transcript}`);
  if (compressing) {
    userSections.push('请同时输出 session_summary 字段。');
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: userSections.join('\n\n') },
  ];
}

// ─── 解析（平衡块 + 逐对象扫描 salvage） ─────────────────────────────────────

interface ExtractedCandidate {
  kind: 'preference' | 'knowledge' | 'summary';
  content: string;
  tags: string[];
  scope: 'global' | 'workspace';
}

interface ParsedExtraction {
  candidates: ExtractedCandidate[];
  sessionSummary: string | null;
}

const ALLOWED_KINDS: ReadonlySet<ExtractedCandidate['kind']> = new Set([
  'preference',
  'knowledge',
  'summary',
]);

function parseExtractionOutput(raw: string): ParsedExtraction {
  // 优先：首个平衡 {...} 块直接 JSON.parse（覆盖纯 JSON 与含噪声的合法 JSON）
  const block = extractFirstBalancedBlock(raw);
  if (block !== null) {
    try {
      const obj = JSON.parse(block) as unknown;
      if (isRecord(obj)) {
        const memories = Array.isArray(obj.memories) ? obj.memories : [];
        const sessionSummary =
          typeof obj.session_summary === 'string' && obj.session_summary.trim()
            ? obj.session_summary
            : null;
        return {
          candidates: memories.flatMap(coerceCandidate).filter((c): c is ExtractedCandidate => c !== null),
          sessionSummary,
        };
      }
    } catch {
      // 平衡块 parse 失败 → 落 fallback 逐对象扫描（spec §6.4 解析容错）
    }
  }
  // fallback：扫描所有平衡对象，挑选含 kind 的（内层 memory 对象）
  const scanned = scanBalancedObjects(raw).flatMap((obj) => {
    const cand = isRecord(obj) ? coerceCandidate(obj) : null;
    return cand ? [cand] : [];
  });
  return { candidates: scanned, sessionSummary: null };
}

/** 抽取首个顶层平衡 {...} 块（含 JSON 字符串转义处理） */
function extractFirstBalancedBlock(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 扫描全文中所有平衡 {...} 块并尝试 JSON.parse 每一个（fault-tolerant salvage）。
 *
 * 实现要点：对每个 `{` 位置独立计算其深度归零的闭合位置（最近 `}`）。
 * 外层对象 close 会包裹内层对象——内层 slice 落在外层 slice 内部——但每个 slice
 * 独立 JSON.parse，外层坏 JSON 不会污染内层合法对象的提取。
 * 重复扫描同样安全（同一内层对象至多贡献一次有效结果）。
 */
function scanBalancedObjects(text: string): unknown[] {
  const results: unknown[] = [];
  const seen: Set<number> = new Set();
  let idxStart = 0;
  while (idxStart < text.length) {
    const start = text.indexOf('{', idxStart);
    if (start === -1) break;
    if (seen.has(start)) { idxStart = start + 1; continue; }
    const close = matchClosingBrace(text, start);
    if (close === -1) break;
    seen.add(start);
    const slice = text.slice(start, close + 1);
    try {
      const parsed = JSON.parse(slice) as unknown;
      if (isRecord(parsed)) results.push(parsed);
    } catch {
      // 单块坏 JSON 静默丢弃，继续
    }
    idxStart = start + 1;
  }
  return results;
}

/** 找与 text[start] 匹配的 '}' 位置（处理字符串与转义） */
function matchClosingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验并归一化单个候选：kind 白名单、content 非空、tags 字符串数组、scope 缺省 workspace */
function coerceCandidate(raw: unknown): ExtractedCandidate | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind as ExtractedCandidate['kind'])) return null;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) return null;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const scope: ExtractedCandidate['scope'] = raw.scope === 'global' ? 'global' : 'workspace';
  return { kind: kind as ExtractedCandidate['kind'], content, tags, scope };
}

// ─── 去重（BM25 + 包含关系） ─────────────────────────────────────────────────

async function isDuplicate(cand: ExtractedCandidate, workspaceId: string): Promise<boolean> {
  const prefix = cand.content.slice(0, DEDUP_PREFIX_LEN);
  if (!prefix) return false;
  const hits = await getMemoryProvider().searchMemories(prefix, { workspaceId, sessionId: null });
  if (hits.length === 0) return false;
  const first = hits[0]!;
  const candHead = cand.content.slice(0, OVERLAP_LEN);
  const firstHead = first.content.slice(0, OVERLAP_LEN);
  return first.content.includes(candHead) || cand.content.includes(firstHead);
}

// ─── 直接 SQL 辅助（spec §6.4 需要的 totalMessages / priorSummary） ───────────

function countSessionMessages(sessionId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as { n: number };
  return row.n;
}

function readPriorSummary(sessionId: string): string | null {
  const row = getDb()
    .prepare('SELECT summary FROM session_summaries WHERE session_id = ?')
    .get(sessionId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

/**
 * 取最近 WINDOW_LIMIT 条会话消息（spec §6.4「最近 50 条」窗口），保持 ASC 时间序。
 * 实现：直接 SQL `ORDER BY created_at DESC LIMIT WINDOW_LIMIT` 取最新 N 条，
 * 再反转保 ASC 与 provider getConversationContext 同款形态。sender → role 映射
 * 复用 sqlite-provider.messageToContext 同款启发式（owner=user / 其他=assistant）。
 */
async function fetchLatestWindow(sessionId: string): Promise<ConversationContext> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages WHERE session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(sessionId, WINDOW_LIMIT) as Array<{
      id: string; session_id: string; sender: string; event_type: string; body: string;
      created_at: number; updated_at: number;
    }>;
  const messages: ContextMessage[] = rows
    .reverse()
    .map((r) => ({
      role: r.sender === 'owner' ? ('user' as const) : ('assistant' as const),
      content: r.body,
      timestamp: r.created_at,
      sender: r.sender,
    }));
  return { messages };
}