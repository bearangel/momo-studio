// renderer/tests/lib/mention-parser.test.ts
//
// MentionParser 行为测试：@ + # 双语法
// - @ 触发 agent 提及（slug 风格：字母/数字/短横线）
// - # 触发 task 引用（必须形如 T-XXX，T-后纯数字）
// - 仅在前面是空白或行首时识别（避免误识别邮箱 a@b.com / markdown 标题 # 标题）
import { describe, it, expect } from 'vitest';
import { parseMentions } from '../../src/lib/mention-parser';

describe('MentionParser', () => {
  it('解析 @agent', () => {
    const r = parseMentions('@PM-agent 你好');
    expect(r.length).toBe(1);
    const first = r[0]!;
    expect(first).toMatchObject({ type: 'agent', refId: 'PM-agent', raw: '@PM-agent' });
    expect(first.start).toBe(0);
    expect(first.end).toBe(9);
  });

  it('解析 #T-001 任务引用', () => {
    const r = parseMentions('看 #T-001 这个任务');
    expect(r.length).toBe(1);
    expect(r[0]!).toMatchObject({ type: 'task', refId: 'T-001', raw: '#T-001' });
  });

  it('@ + # 混合', () => {
    const r = parseMentions('@PM-agent #T-001 开始吧');
    expect(r.length).toBe(2);
    expect(r[0]!.type).toBe('agent');
    expect(r[1]!.type).toBe('task');
  });

  it('不识别邮箱里的 @（a@b.com）', () => {
    const r = parseMentions('联系 a@b.com');
    expect(r.length).toBe(0);
  });

  it('不识别 markdown 标题里的 #（# 标题）', () => {
    const r = parseMentions('# 标题\n正文');
    expect(r.length).toBe(0);
  });

  it('行首的 @ / # 识别', () => {
    expect(parseMentions('@bot').length).toBe(1);
    expect(parseMentions('#T-002').length).toBe(1);
  });

  it('前面是空格的 @ / # 识别', () => {
    expect(parseMentions('hi @bot').length).toBe(1);
    expect(parseMentions('hi #T-002').length).toBe(1);
  });

  it('task refId 必须形如 T-XXX（数字）', () => {
    expect(parseMentions('#T-001').length).toBe(1);
    expect(parseMentions('#T-XYZ').length).toBe(0);
    expect(parseMentions('#Task').length).toBe(0);
  });

  it('task refId 支持 T-001 / T-1 等数字', () => {
    expect(parseMentions('#T-1').length).toBe(1);
    expect(parseMentions('#T-99999').length).toBe(1);
  });

  it('agent refId 允许字母数字短横线（slug 风格）', () => {
    expect(parseMentions('@pm-agent').length).toBe(1);
    expect(parseMentions('@QA_agent').length).toBe(0);  // 下划线不允许
    expect(parseMentions('@bot123').length).toBe(1);
  });

  it('多个 mention 同行', () => {
    const r = parseMentions('@a #T-1 @b #T-2');
    expect(r.length).toBe(4);
  });

  it('空文本返回空数组', () => {
    expect(parseMentions('')).toEqual([]);
  });
});