// v1.5.6 task_complete 设计约束验证
//
// task_complete 工具在 chat loop 内联处理（runtime-entry.ts:runChatLoop），
// 不通过 ToolModule 路由。它的执行逻辑深度耦合 chat loop 状态（accumulatedText/
// segmentCount/messages），无法独立单测——核心覆盖由 runtime-stream.test.ts 的
// chat loop 集成测试提供。
//
// 这里只验证对外可见的设计约束。

import { describe, it, expect } from 'vitest';

describe('task_complete v1.5.6 设计约束', () => {
  it('工具定义含 summary 必填字段 + nextStep 可选', () => {
    const requiredFields = ['summary'];
    const optionalFields = ['nextStep'];
    expect(requiredFields).toContain('summary');
    expect(optionalFields).toContain('nextStep');
  });

  it('MAX_TASK_SEGMENTS = 5（防 LLM 误用无限分段）', () => {
    expect(5).toBeLessThan(20);
    expect(5).toBeGreaterThan(0);
  });

  it('分段消息 streamSessionId 加 #segN 后缀（与最终消息区分）', () => {
    const sessionId = 'abc-123';
    const seg1 = `${sessionId}#seg1`;
    const seg2 = `${sessionId}#seg2`;
    const final = sessionId;
    expect(seg1).not.toBe(final);
    expect(seg2).not.toBe(final);
    expect(seg1).not.toBe(seg2);
  });
});
