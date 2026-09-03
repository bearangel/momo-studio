// electron/tests/memory/context-map.test.ts
// messageToContext 共享映射（P3 M-7 消双实现）：sender→role 启发式单点定义——
// owner=user / 其余（agent-* 新身份与 @bot:* 旧身份）=assistant。
// 两消费方（extraction.fetchLatestWindow / sqlite-provider.getConversationContext）
// 的端到端行为各自被 sqlite-provider.test.ts 与 extraction.test.ts 锁定；
// 此处锁映射模块自身契约（结构透传 + 身份边界）。
import { describe, it, expect } from 'vitest';
import { messageToContext } from '../../src/main/memory/context-map';

describe('messageToContext（共享映射）', () => {
  it("sender='owner' → role user，content/timestamp/sender 原样透传", () => {
    expect(messageToContext({ sender: 'owner', body: '你好', createdAt: 123 })).toEqual({
      role: 'user',
      content: '你好',
      timestamp: 123,
      sender: 'owner',
    });
  });

  it("sender='agent-coder-a1b2c3'（v2 新身份，不含 bot 子串）→ role assistant", () => {
    const m = messageToContext({ sender: 'agent-coder-a1b2c3', body: 'hi', createdAt: 1 });
    expect(m.role).toBe('assistant');
  });

  it("sender='@bot:home'（v1 旧身份）→ role assistant", () => {
    expect(messageToContext({ sender: '@bot:home', body: 'hi', createdAt: 1 }).role).toBe('assistant');
  });
});
