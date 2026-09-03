// electron/src/main/memory/context-map.ts
// messages 行 → ContextMessage 的共享映射（P3 M-7 消双实现）。
// 此前 sender→role 启发式在 sqlite-provider.ts（getConversationContext）与
// extraction.ts（fetchLatestWindow 最近窗口直读 SQL）各写一份——映射语义
// 单点化后两处 import 本模块，改启发式只动这里。
import type { ContextMessage } from './types';

/**
 * 映射输入的最小结构形状（MessageRow 的子集——extraction 的 SQL 直读行
 * 经列别名后同样结构满足，无需依赖 repo 层类型）。
 */
export interface MessageContextSource {
  sender: string;
  body: string;
  /** ms epoch */
  createdAt: number;
}

/**
 * sender→role 启发式映射（唯一 owner）：
 *   - sender === 'owner' → user（用户在 v2 会话里的固定身份字符串）
 *   - 其余（含旧 '@bot:home' 与新 'agent-<slug>-<suffix>'）→ assistant
 *
 * 历史教训：曾用 `m.sender.includes('bot')` 子串判定——v2 新身份
 * 'agent-coder-a1b2c3' 不含 'bot'，导致 agent 历史被注入为 role 'user'，
 * LLM 上下文错乱。改为只认唯一的 'owner' 标识，其余一律 assistant。
 * 后续若引入更多用户身份字符串，再扩展 allowlist（不引入黑名单
 * 'bot' 等不可靠字符串匹配）。
 */
export function messageToContext(m: MessageContextSource): ContextMessage {
  const isBot = m.sender !== 'owner';
  return {
    role: isBot ? 'assistant' : 'user',
    content: m.body,
    timestamp: m.createdAt,
    sender: m.sender,
  };
}
