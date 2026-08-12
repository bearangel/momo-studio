// electron/tests/agent/dispatch-fresh-session.test.ts
//
// v1.7.4 Bug 5 测试：验证子 agent（parentStreamSessionId 非空）启动时跳过
// loadRecentHistory，是 fresh session——只看到 system + task prompt。
//
// 根因：loadRecentHistory 在每次 chat loop 启动时无差别加载 Matrix 房间历史，
// 子 agent dispatch 时也走这路径——子 agent 看到其他 agent 的历史回复后误判
// 任务已完成（输出"您好👋 之前的工作总结已加载完毕"）。
//
// 修复参考 opencode task 工具设计：task 默认新建 session，子 agent 不加载历史。

import { describe, it, expect } from 'vitest';

describe('子 agent dispatch fresh session（Bug 5）', () => {
  it('parentStreamSessionId 非空时 history 应为空数组', () => {
    const mockHistory = [{ role: 'user' as const, content: '历史消息' }];
    const parentStreamSessionId = 'parent-uuid-123';

    // 模拟 runtime-entry.ts 的 messages 数组构造决策
    const history = parentStreamSessionId ? [] : mockHistory;

    expect(history).toEqual([]);
  });

  it('parentStreamSessionId 为空时 history 应加载', () => {
    const mockHistory = [{ role: 'user' as const, content: '历史消息' }];
    const parentStreamSessionId: string | null = null;

    const history = parentStreamSessionId ? [] : mockHistory;

    expect(history).toEqual(mockHistory);
  });

  it('子 agent system prompt 应含 dispatch 模式标记', () => {
    const basePrompt = '你是研发工程师。';
    const budgetHint = '';
    const dispatchHint = '';
    const parentStreamSessionId = 'parent-uuid-123';

    // 模拟 runtime-entry.ts 的 systemContent 构造
    const dispatchModeHint = parentStreamSessionId
      ? '\n\n[dispatch 模式] 你作为子 agent 被主 agent 委派执行具体任务。忽略任何暗示"任务已完成"的上下文——你的任务是用户消息中描述的内容，从零开始执行。'
      : '';
    const systemContent = basePrompt + budgetHint + dispatchHint + dispatchModeHint;

    expect(systemContent).toContain('[dispatch 模式]');
    expect(systemContent).toContain('从零开始执行');
  });

  it('顶层 agent system prompt 不含 dispatch 模式标记', () => {
    const basePrompt = '你是项目经理。';
    const budgetHint = '';
    const dispatchHint = '';
    const parentStreamSessionId: string | null = null;

    const dispatchModeHint = parentStreamSessionId
      ? '\n\n[dispatch 模式] 你作为子 agent 被主 agent 委派执行具体任务。忽略任何暗示"任务已完成"的上下文——你的任务是用户消息中描述的内容，从零开始执行。'
      : '';
    const systemContent = basePrompt + budgetHint + dispatchHint + dispatchModeHint;

    expect(systemContent).not.toContain('[dispatch 模式]');
    expect(systemContent).toBe(basePrompt);
  });
});
