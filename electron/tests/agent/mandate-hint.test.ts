// electron/tests/agent/mandate-hint.test.ts
//
// turn mandate 尾段（spec §2）：本轮用户授权的结构化呈现。每轮重写 messages[0]
// 时调用——「中途补充」与「未完成项」保持实时。未完成项只列 source=user 且非
// completed 的条目（agent 自发项不进授权节）。

import { describe, it, expect, beforeEach } from 'vitest';
import { buildMandateHint } from '../../src/main/agent/prompt-hints';
import { __setTodosForTest } from '../../src/main/agent/tools/todo-tools';
import type { TodoItem } from '../../src/main/agent/tools/todo-types';

function todo(subject: string, status: TodoItem['status'], source: TodoItem['source']): TodoItem {
  return { id: `id-${subject}`, subject, status, source };
}

describe('buildMandateHint', () => {
  beforeEach(() => __setTodosForTest('sid-m', []));

  it('含用户消息原文与授权约束；无补充无未完成项时两节均显式标注', () => {
    const hint = buildMandateHint({ userBody: '帮我重构X模块', steers: [], streamSessionId: 'sid-m' });
    expect(hint).toContain('帮我重构X模块');
    expect(hint).toContain('本轮用户授权');
    expect(hint).toContain('无');
    expect(hint).toContain('勿据此发起新工作');
  });

  it('中途补充与未完成 user 项实时反映', () => {
    __setTodosForTest('sid-m', [todo('主任务', 'in_progress', 'user'), todo('扩展', 'pending', 'agent')]);
    const hint = buildMandateHint({
      userBody: '帮我重构X模块',
      steers: ['顺便把第二个任务改成pwd'],
      streamSessionId: 'sid-m',
    });
    expect(hint).toContain('顺便把第二个任务改成pwd');
    expect(hint).toContain('主任务');
    expect(hint).not.toContain('扩展'); // agent 项不进「用户请求的未完成项」节
  });
});