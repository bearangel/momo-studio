// electron/tests/agent/mandate-hint.test.ts
//
// turn mandate 尾段（spec §2）：本轮用户授权的结构化呈现。每轮重写 messages[0]
// 时调用——「中途补充」与「未完成项」保持实时。未完成项只列 source=user 且非
// completed 的条目（agent 自发项不进授权节）。

import { describe, it, expect, beforeEach } from 'vitest';
import { buildMandateHint, formatClockHint, formatDispatchHint, formatWorkspaceHygieneHint } from '../../src/main/agent/prompt-hints';
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

  it('中途补充与未完成 user 项实时反映；agent 项不进授权节', () => {
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

  it('F1a：in_progress 与 pending 分级标注，且进行中项带「切勿重做」提示', () => {
    __setTodosForTest('sid-m', [
      todo('委派 CodeForge', 'in_progress', 'user'),
      todo('补充事项', 'pending', 'user'),
    ]);
    const hint = buildMandateHint({ userBody: '测试', steers: [], streamSessionId: 'sid-m' });
    expect(hint).toContain('[进行中] 委派 CodeForge——你已着手');
    expect(hint).toContain('先用 todowrite 标记 completed，切勿重做');
    expect(hint).toContain('[未开始] 补充事项');
  });

  it('F1a：约束含「状态记录非新请求」防重跑条款', () => {
    const hint = buildMandateHint({ userBody: '测试', steers: [], streamSessionId: 'sid-m' });
    expect(hint).toContain('不代表新的用户请求');
    expect(hint).toContain('严禁仅因列表未更新而重复执行已完成的工作');
  });
});

describe('formatClockHint（F13 年份幻觉防护）', () => {
  it('注入完整日期时间与「以此为准」约束', () => {
    // 固定日期断言格式（2026-09-18 是星期五）
    const hint = formatClockHint(new Date(2026, 8, 18, 14, 5));
    expect(hint).toContain('2026 年 9 月 18 日');
    expect(hint).toContain('星期五');
    expect(hint).toContain('14:05');
    expect(hint).toContain('禁止凭记忆推断年份');
  });

  it('分钟补零（个位数分钟）', () => {
    const hint = formatClockHint(new Date(2026, 0, 2, 9, 7));
    expect(hint).toContain('09:07');
  });
});

describe('formatDispatchHint（F12 客观计数说明）', () => {
  it('leader 且有子 agent 时注入 toolCallsUsed 客观计数提示', () => {
    const hint = formatDispatchHint({
      isLeader: true,
      subAgents: [{ slug: 'coder', description: '编码' }],
    } as Parameters<typeof formatDispatchHint>[0]);
    expect(hint).toContain('toolCallsUsed 是系统客观计数');
    expect(hint).toContain('不要采信子 agent 回执中的自报数字');
  });
});

describe('formatWorkspaceHygieneHint（F8 卫生约定）', () => {
  it('注入 scratch 目录约定与交付物边界', () => {
    const hint = formatWorkspaceHygieneHint();
    expect(hint).toContain('.momo-scratch/<任务名>/');
    expect(hint).toContain('不要写入项目正式目录');
    expect(hint).toContain('不视为交付物');
  });

  it('无条件的静态文本（每次调用一致，可安全常驻 system）', () => {
    expect(formatWorkspaceHygieneHint()).toBe(formatWorkspaceHygieneHint());
  });
});
