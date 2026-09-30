// segments 纯函数层：六类 pill 序列化规则 + 草稿往返。规则表 = spec §3
// （image pill = 2026-09-26 多模态 spec §5/§10：body 锚点 `[图片: name]` +
// context.images 去重保序上限 6）。
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
const image = (path: string, label: string, w = 100, h = 50): PillSeg => ({
  type: 'pill', kind: 'image', id: path, label, w, h,
});

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
// TASK_MENTION_REGEX（双向空白边界，electron/src/main/task/conflict-detector.ts），
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

// === image pill（2026-09-26 多模态 spec §5/§10）===
describe('serializeSegments image pill（spec §5/§10）', () => {
  it('单个 image pill → body 锚点 `[图片: name] ` + context.images（无图消息 context 形状不变）', () => {
    const r = serializeSegments([image('.momo/assets/abc.png', '截图.png', 800, 600)]);
    expect(r.body).toBe('[图片: 截图.png] ');
    expect(r.context).toEqual({
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/abc.png', w: 800, h: 600 }],
    });
  });

  it('image 与文本/其它 pill 混排：锚点位置保序，标记分隔规则与其它 pill 一致', () => {
    const r = serializeSegments([
      { type: 'text', text: '看 ' },
      image('a.png', 'a.png', 100, 50),
      { type: 'text', text: ' 和 ' },
      agent('i1', 'coder'),
      image('b.jpg', 'b.jpg', 2048, 1365),
    ]);
    expect(r.body).toBe('看 [图片: a.png] 和 @coder [图片: b.jpg] ');
    expect(r.mentions).toEqual(['i1']);
    expect(r.context?.images).toEqual([
      { path: 'a.png', w: 100, h: 50 },
      { path: 'b.jpg', w: 2048, h: 1365 },
    ]);
  });

  it('image pill 单独存在 → body 即锚点 + context.images 有值（可独立发送）', () => {
    const r = serializeSegments([image('a.png', 'a.png')]);
    expect(r.body).toBe('[图片: a.png] ');
    expect(r.mentions).toBeUndefined();
    expect(r.context?.images).toHaveLength(1);
  });

  it('重复路径 image pill：body 锚点保留全部出现，images 按 path 去重保序', () => {
    const r = serializeSegments([
      image('a.png', 'a.png'),
      image('b.png', 'b.png'),
      image('a.png', 'a.png'),
    ]);
    expect(r.body).toBe('[图片: a.png] [图片: b.png] [图片: a.png] ');
    expect(r.context?.images).toEqual([
      { path: 'a.png', w: 100, h: 50 },
      { path: 'b.png', w: 100, h: 50 },
    ]);
  });

  it('第 7 张起不进 images（单条消息 ≤6，renderer 拦截层；body 锚点保留全部出现）', () => {
    const segs = Array.from({ length: 8 }, (_, i) => image(`p${i}.png`, `p${i}.png`));
    const r = serializeSegments(segs);
    expect(r.context?.images).toHaveLength(6);
    expect(r.context?.images?.map((i) => i.path)).toEqual([
      'p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png',
    ]);
    expect(r.body.match(/\[图片:/g)).toHaveLength(8);
  });

  it('w/h 非法（缺失 / 0 / 负数 / 非整数）的 image pill → 不进 images（sanitize 同规则防御），body 锚点照发', () => {
    const malformed: PillSeg[] = [
      { type: 'pill', kind: 'image', id: 'x1.png', label: 'x1.png' },
      { type: 'pill', kind: 'image', id: 'x2.png', label: 'x2.png', w: 0, h: 10 },
      { type: 'pill', kind: 'image', id: 'x3.png', label: 'x3.png', w: 10, h: -1 },
      { type: 'pill', kind: 'image', id: 'x4.png', label: 'x4.png', w: 10.5, h: 10 },
    ];
    const r = serializeSegments(malformed);
    expect(r.context).toBeUndefined();
    expect(r.body).toBe('[图片: x1.png] [图片: x2.png] [图片: x3.png] [图片: x4.png] ');
  });
});

describe('草稿往返 image pill（draftToSegments 白名单 + w/h 校验）', () => {
  it('round-trip：image pill 含 w/h 原样恢复', () => {
    const segs: Parameters<typeof segmentsToDraft>[0] = [
      { type: 'text', text: '图 ' },
      image('.momo/assets/ab12.png', '截图.png', 2048, 1365),
    ];
    expect(draftToSegments(segmentsToDraft(segs))).toEqual(segs);
  });

  it('image pill 缺 w/h 或 w/h 非正整数 → 整份草稿降级单文本（与既有形状非法规则一致）', () => {
    const cases = [
      [{ type: 'pill', kind: 'image', id: 'a.png', label: 'a.png' }],
      [{ type: 'pill', kind: 'image', id: 'a.png', label: 'a.png', w: 100 }],
      [{ type: 'pill', kind: 'image', id: 'a.png', label: 'a.png', w: 0, h: 100 }],
      [{ type: 'pill', kind: 'image', id: 'a.png', label: 'a.png', w: 100, h: -1 }],
      [{ type: 'pill', kind: 'image', id: 'a.png', label: 'a.png', w: '100' as unknown as number, h: 100 }],
    ];
    for (const segs of cases) {
      const raw = JSON.stringify(segs);
      expect(draftToSegments(raw)).toEqual([{ type: 'text', text: raw }]);
    }
  });

  it('非 image pill 不要求 w/h（旧草稿兼容——草稿里 agent pill 无 w/h 照常恢复）', () => {
    const segs: Parameters<typeof segmentsToDraft>[0] = [agent('i1', 'coder')];
    expect(draftToSegments(segmentsToDraft(segs))).toEqual(segs);
  });
});

// === session pill（2026-09-30 跨会话引用 spec §5/§6）===
describe('session pill 序列化（跨会话引用）', () => {
  const sessPill = { type: 'pill' as const, kind: 'session' as const, id: 'sess-9', label: '设计讨论' };

  it('body 锚点 @标题 + context.sessions', () => {
    const out = serializeSegments([{ type: 'text', text: '参考' }, sessPill, { type: 'text', text: '写计划' }]);
    expect(out.body).toBe('参考 @设计讨论 写计划');
    expect(out.context?.sessions).toEqual([{ sessionId: 'sess-9', title: '设计讨论' }]);
  });

  it('重复 session pill：body 保留两处，结构化数组去重', () => {
    const out = serializeSegments([sessPill, { type: 'text', text: '和' }, sessPill]);
    expect(out.body).toBe('@设计讨论 和 @设计讨论 ');
    expect(out.context?.sessions).toEqual([{ sessionId: 'sess-9', title: '设计讨论' }]);
  });

  it('仅 session pill：context 携带 sessions（合法空 body 消息）', () => {
    const out = serializeSegments([sessPill]);
    expect(out.body).toBe('@设计讨论 ');
    expect(out.context).toBeDefined();
  });

  it('草稿往返：session pill 不丢；旧版六类 pill 草稿不受影响', () => {
    const round = draftToSegments(segmentsToDraft([sessPill, { type: 'text', text: 'hi' }]));
    expect(round).toEqual([sessPill, { type: 'text', text: 'hi' }]);
    const legacy = JSON.stringify([
      { type: 'pill', kind: 'agent', id: 'a1', label: 'Coder' },
      { type: 'text', text: '旧草稿' },
    ]);
    expect(draftToSegments(legacy)).toEqual([
      { type: 'pill', kind: 'agent', id: 'a1', label: 'Coder' },
      { type: 'text', text: '旧草稿' },
    ]);
  });
});
