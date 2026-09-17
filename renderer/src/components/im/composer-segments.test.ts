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
    expect(r.body).toBe('@coder 审查 @src/a.ts#T-3/compact');
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

  it('命令 pill → body 恰为 /name（整串拦截语义由序列化形态自然保持）', () => {
    expect(serializeSegments([command('compact')]).body).toBe('/compact');
    // 混排时不是纯命令串
    expect(serializeSegments([{ type: 'text', text: 'hi ' }, command('compact')]).body).toBe('hi /compact');
  });

  it('重复 pill：body 保留全部出现，结构化数组按 id/slug/path 去重（保序）', () => {
    const r = serializeSegments([
      agent('i1', 'a'), agent('i1', 'a'),
      file('f.ts'), file('f.ts'),
      skill('s1', 'x'), skill('s1', 'x'),
    ]);
    expect(r.body).toBe('@a@a@f.ts@f.ts');
    expect(r.mentions).toEqual(['i1']);
    expect(r.context?.files).toEqual([{ path: 'f.ts' }]);
    expect(r.context?.skills).toEqual([{ slug: 's1', name: 'x' }]);
  });

  it('纯文本与空数组', () => {
    expect(serializeSegments([])).toEqual({ body: '' });
    expect(serializeSegments([{ type: 'text', text: '你好' }])).toEqual({ body: '你好' });
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