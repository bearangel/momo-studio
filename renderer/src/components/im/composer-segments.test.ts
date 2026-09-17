// segments 纯函数层：五类 pill 序列化规则 + 草稿往返。规则表 = spec §3。
import { describe, it, expect } from 'vitest';
import {
  serializeSegments,
  segmentsToDraft,
  draftToSegments,
  type PillSeg,
} from './composer-segments';

const agent = (id: string, label: string): PillSeg => ({ type: 'pill', kind: 'agent', id, label });
const file = (path: string): PillSeg => ({ type: 'pill', kind: 'file', id: path, label: path });
const task = (id: string, title: string): PillSeg => ({ type: 'pill', kind: 'task', id, label: title });
const skill = (slug: string, name: string): PillSeg => ({ type: 'pill', kind: 'skill', id: slug, label: name });
const command = (name: string): PillSeg => ({ type: 'pill', kind: 'command', id: name, label: name });

describe('serializeSegments（spec §3 序列化规则表）', () => {
  it('五类混排：body 标记形态 + mentions/context 归位', () => {
    const r = serializeSegments([
      agent('inst-1', 'coder'),
      { type: 'text', text: ' 审查 ' },
      file('src/a.ts'),
      task('T-3', '修复登录'),
      skill('code-review', '代码审查'),
      command('compact'),
    ]);
    expect(r.body).toBe('@coder 审查 @src/a.ts #T-3 /compact ');
    expect(r.mentions).toEqual(['inst-1']);
    expect(r.context).toEqual({
      skills: [{ slug: 'code-review', name: '代码审查' }],
      files: [{ path: 'src/a.ts' }],
    });
  });

  it('技能不进正文（v2.11 语义：展开块由主进程注入，防双重曝光）', () => {
    const r = serializeSegments([skill('s1', '技能一')]);
    expect(r.body).toBe('');
    expect(r.context?.skills).toEqual([{ slug: 's1', name: '技能一' }]);
  });

  it('空 body + 仅技能 pill：context 有值（合法发送判定依据）', () => {
    const r = serializeSegments([skill('s1', 'x')]);
    expect(r.body).toBe('');
    expect(r.context).toBeDefined();
    expect(r.mentions).toBeUndefined();
  });

  it('命令 pill → body 为 /name + 尾随空格（handleSend trim 后整串拦截形态保持）', () => {
    expect(serializeSegments([command('compact')]).body).toBe('/compact ');
    // 混排时不是纯命令串（trim 后按普通消息发送）
    expect(serializeSegments([{ type: 'text', text: 'hi ' }, command('compact')]).body).toBe('hi /compact ');
  });

  it('重复 pill：body 保留全部出现，结构化数组按 id/slug/path 去重（保序）', () => {
    const r = serializeSegments([
      agent('i1', 'a'), agent('i1', 'a'),
      file('f.ts'), file('f.ts'),
      skill('s1', 'x'), skill('s1', 'x'),
    ]);
    expect(r.body).toBe('@a @a @f.ts @f.ts ');
    expect(r.mentions).toEqual(['i1']);
    expect(r.context?.files).toEqual([{ path: 'f.ts' }]);
    expect(r.context?.skills).toEqual([{ slug: 's1', name: 'x' }]);
  });

  it('纯文本与空数组', () => {
    expect(serializeSegments([])).toEqual({ body: '' });
    expect(serializeSegments([{ type: 'text', text: '你好' }])).toEqual({ body: '你好' });
  });
});

// F2 回归锁：邻接 pill 无用户文本分隔时，序列化必须保证标记前后空格——否则
// body 如 '#T-001@PM-agent' / '#T-001请跟进' 不命中 conflict-detector 的
// TASK_MENTION_REGEX（双向空白边界，electron/src/main/im/conflict-detector.ts），
// 任务引用静默丢失（激活 + 冲突检测全漏）。正则在此镜像锁契约（renderer 测试
// 不 import 主进程代码）。
const TASK_MENTION_MIRROR = /(?:^|\s)#(T-\d+)(?=\s|$)/g;

describe('serializeSegments 标记分隔（F2 邻接回归锁，spec §3「标记分隔」行）', () => {
  it('① task pill 紧跟 agent pill（无中间文本）→ 标记间保证空格，两端可解析', () => {
    const body = serializeSegments([task('T-001', '修复登录'), agent('inst-pm', 'PM-agent')]).body;
    expect(body).toBe('#T-001 @PM-agent ');
    expect(body.match(TASK_MENTION_MIRROR)).toEqual(['#T-001']);
  });

  it('② task pill 后直接跟文本段 → #T 标记与文本间保证空格', () => {
    const body = serializeSegments([task('T-001', '修复登录'), { type: 'text', text: '请跟进' }]).body;
    expect(body).toBe('#T-001 请跟进');
    expect(body.match(TASK_MENTION_MIRROR)).toEqual(['#T-001']);
  });

  it('③ 首 pill 前 body 空 → 无前导空格', () => {
    expect(serializeSegments([file('src/a.ts'), task('T-3', '修复登录')]).body).toBe('@src/a.ts #T-3 ');
    expect(serializeSegments([agent('i', 'a')]).body.startsWith(' ')).toBe(false);
  });

  it('④ 用户已敲空格 → 不双空格（前侧让位 + 尾随空格让位文本自带首空白）', () => {
    expect(serializeSegments([{ type: 'text', text: '审查 ' }, agent('i', 'a')]).body).toBe('审查 @a ');
    expect(serializeSegments([agent('i', 'a'), { type: 'text', text: ' 请跟进' }]).body).toBe('@a 请跟进');
  });
});

describe('草稿往返（segmentsToDraft / draftToSegments）', () => {
  it('round-trip：pill 与文本不丢', () => {
    const segs: Parameters<typeof segmentsToDraft>[0] = [
      { type: 'text', text: '帮 ' },
      agent('i1', 'coder'),
      { type: 'text', text: ' 看 ' },
      file('a.ts'),
    ];
    expect(draftToSegments(segmentsToDraft(segs))).toEqual(segs);
  });

  it('旧纯文本草稿 / null / 非法 JSON / 形状非法 → 降级单文本 segment', () => {
    expect(draftToSegments('普通旧草稿')).toEqual([{ type: 'text', text: '普通旧草稿' }]);
    expect(draftToSegments(null)).toEqual([]);
    expect(draftToSegments(undefined)).toEqual([]);
    expect(draftToSegments('{{{')).toEqual([{ type: 'text', text: '{{{' }]);
    expect(draftToSegments(JSON.stringify([{ type: 'pill', kind: 'hack', id: 'x', label: 'x' }])))
      .toEqual([{ type: 'text', text: JSON.stringify([{ type: 'pill', kind: 'hack', id: 'x', label: 'x' }]) }]);
  });
});