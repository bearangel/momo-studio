// electron/src/main/im/session-naming.ts
//
// 会话动态命名服务（v25 Task 8，spec §4.5 / D4）——两段式命名：
//   1. applyFirstMessageTitle：首条用户消息落库后，截断占位
//      （去换行后前 20 字）。只在「占位态」（title=新会话 且 title_auto=1）
//      生效；title_auto 保持 1，给 LLM 替换留通道（截断标题本身也是占位）。
//   2. scheduleLlmTitle：接待 agent（is_leader 快照）首次 final 后 fire-and-forget，
//      用接待成员的 provider/model 生成 ≤12 字中文标题替换；
//      rename 守卫 `WHERE title_auto=1` 是竞态锁——changes=0 即用户已手动
//      改名 / 另一次命名已生效，放弃。
//
// 接线说明：两函数的调用点（消息落库后 / 首次 final 后）由 Task 9 路由改造接入，
// 本模块只负责命名语义本身。
import { getDb } from '../storage/db';
import { getSession } from '../storage/sessions/repo';
import { getMessage, listMessagesBySession } from '../storage/messages/repo';
import { getAgentDefinition } from '../agent/crud';
import { getProvider } from '../agent/provider-crud';
import { resolveApiKey } from '../agent/spawn-helpers';
import { createLLMProvider, type LLMMessage } from '../agent/llm-provider';
import { logger } from '../logger';

/** 占位标题：与 session-ops 同源 re-export（单一真相，防两处字面量漂移） */
export { PLACEHOLDER_TITLE } from './session-ops';
import { PLACEHOLDER_TITLE } from './session-ops';

/** 截断占位长度（spec §4.5：首条消息前 20 字符） */
const TRUNCATE_LIMIT = 20;
/** 首次回复摘录长度（仅控制 prompt 体积） */
const REPLY_EXCERPT_LIMIT = 200;

/**
 * 首条用户消息截断占位。守卫语义（AND，缺一不可）：
 *   - title_auto=1：用户未手动改名、LLM 未替换过
 *   - title=占位：截断尚未发生过（首条消息语义，重复调用不覆盖）
 * 两个条件同时满足才更新；title_auto 保持 1（LLM 仍可接管替换）。
 */
export function applyFirstMessageTitle(sessionId: string, body: string): void {
  const truncated = truncateForTitle(body);
  if (!truncated) return; // 空消息保持占位（空串/纯空白/纯换行）
  getDb()
    .prepare(
      `UPDATE sessions SET title = ?, updated_at = ?
       WHERE id = ? AND title_auto = 1 AND title = ?`,
    )
    .run(truncated, Date.now(), sessionId, PLACEHOLDER_TITLE);
}

/** 去换行后取前 20 字符；首尾空白剔除，结果为空则返回空串（调用方跳过） */
function truncateForTitle(body: string): string {
  return body
    .replace(/[\r\n]/g, '')
    .slice(0, TRUNCATE_LIMIT)
    .trim();
}

/**
 * LLM 异步命名（fire-and-forget）。内部 catch 全部错误静默（logger.warn），
 * 永不向调用方抛出/拒绝——命名失败不影响会话主流程。
 */
export function scheduleLlmTitle(sessionId: string): void {
  void generateLlmTitle(sessionId).catch((err: unknown) => {
    logger.warn('LLM 会话命名失败（不影响会话）', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function generateLlmTitle(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || !session.titleAuto) return; // 会话不存在 / 用户已命名 → 无需 LLM

  const reception = findReceptionAgent(sessionId);
  if (!reception) {
    logger.warn('LLM 会话命名：会话无接待成员（is_leader），跳过', { sessionId });
    return;
  }

  const def = getAgentDefinition(reception.agentDefinitionId);
  if (!def?.modelProviderId) {
    logger.warn('LLM 会话命名：接待 agent 定义缺失或未配置供应商，跳过', {
      sessionId,
      instanceId: reception.instanceId,
    });
    return;
  }
  const provider = getProvider(def.modelProviderId);
  if (!provider) {
    logger.warn('LLM 会话命名：供应商不存在（ghost provider），跳过', {
      sessionId,
      providerId: def.modelProviderId,
    });
    return;
  }

  const messages = listMessagesBySession(sessionId);
  const firstUser = messages.find((m) => m.sender === 'owner');
  if (!firstUser) {
    logger.warn('LLM 会话命名：无首条用户消息，跳过', { sessionId });
    return;
  }
  const firstReply = messages.find((m) => m.sender !== 'owner');

  // 接待成员的模型链：def(modelName) → model_providers(platform/baseUrl)；
  // key 解析复用生产 resolveApiKey（override ?? provider key）
  const apiKey = await resolveApiKey(reception.instanceId, def.modelProviderId);
  const llm = createLLMProvider(
    { provider: provider.platform, model: def.modelName, baseUrl: provider.baseUrl },
    apiKey,
  );
  const res = await llm.chat(buildTitleMessages(firstUser.body, firstReply?.body ?? null));

  const title = sanitizeLlmTitle(res.content);
  if (!title) return; // LLM 输出空白 → 视为无效，放弃

  // 竞态锁：title_auto 已被置 0（用户手动改名 / 另一次命名已生效）则 0 行命中，放弃
  getDb()
    .prepare(
      `UPDATE sessions SET title = ?, title_auto = 0, updated_at = ?
       WHERE id = ? AND title_auto = 1`,
    )
    .run(title, Date.now(), sessionId);
}

/**
 * 接待成员 final 钩子（Task 9 接线入口，spec §4.5「接待 agent 首次回复 final 后」）：
 * stream-relay 在 eventType='final' 事件落库后回调（router-bootstrap 注册）。
 * 仅当该 final 所属消息的 sender 是会话 leader 成员的 agent_user_id 时触发
 * scheduleLlmTitle——@ 直答成员 / dispatch 子 agent 的 final 不触发。
 * scheduleLlmTitle 内部守卫（title_auto=1 等）保证重复触发幂等、成功后不再覆盖。
 * 本函数永不抛错（DB 异常仅 warn）——命名失败不影响会话主流程。
 */
export function onLeaderFinal(messageId: string): void {
  try {
    const msg = getMessage(messageId);
    if (!msg) return;
    const leader = getDb()
      .prepare(
        `SELECT a.agent_user_id AS agentUserId
         FROM session_members m
         JOIN workspace_agent_members a ON m.instance_id = a.instance_id
         WHERE m.session_id = ? AND m.is_leader = 1
         ORDER BY m.added_at ASC
         LIMIT 1`,
      )
      .get(msg.sessionId) as { agentUserId: string } | undefined;
    if (!leader || msg.sender !== leader.agentUserId) return;
    scheduleLlmTitle(msg.sessionId);
  } catch (err) {
    logger.warn('接待 final 命名钩子失败（不影响会话）', {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 接待成员 = session_members.is_leader 建会快照（spec §3.3），JOIN 出 def 引用 */
function findReceptionAgent(
  sessionId: string,
): { instanceId: string; agentDefinitionId: string } | null {
  const row = getDb()
    .prepare(
      `SELECT m.instance_id AS instanceId, a.agent_definition_id AS agentDefinitionId
       FROM session_members m
       JOIN workspace_agent_members a ON m.instance_id = a.instance_id
       WHERE m.session_id = ? AND m.is_leader = 1
       ORDER BY m.added_at ASC
       LIMIT 1`,
    )
    .get(sessionId) as { instanceId: string; agentDefinitionId: string } | undefined;
  return row ?? null;
}

/** 极简 prompt：首条用户消息 + 首次回复摘录 → ≤12 字中文标题，只输出标题 */
function buildTitleMessages(userBody: string, replyBody: string | null): LLMMessage[] {
  const excerpt =
    replyBody === null
      ? null
      : replyBody.replace(/[\r\n]/g, '').slice(0, REPLY_EXCERPT_LIMIT);
  const content =
    excerpt === null
      ? `用户消息：${userBody}`
      : `用户消息：${userBody}\n首次回复：${excerpt}`;
  return [
    {
      role: 'system',
      content: '为以下对话生成一个不超过12个字的中文标题，只输出标题本身，不要解释、引号或标点。',
    },
    { role: 'user', content },
  ];
}

/** LLM 输出规整：trim + 折叠空白；空结果返回空串（调用方放弃） */
function sanitizeLlmTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : '';
}
