// electron/tests/agent/turn-context.test.ts
// turn-context：ExpandedContext → 本轮用户正文包装（<user-context> 块）。
// 错误路径铁律：content=null 的文件渲染为「按需读取」提示行，不是吞掉。
import { describe, it, expect } from 'vitest';
import { renderTurnBody, renderUserContext } from '../../src/main/agent/turn-context';
import type { ExpandedContext, ExpandedSessionItem } from '../../src/main/agent/runtime-config';

const ctx: ExpandedContext = {
  skills: [{ slug: 'code-review', name: '代码审查', body: '逐条审查变更' }],
  files: [
    { path: 'src/a.ts', content: 'const a = 1;' },
    { path: 'big.bin', content: null },
  ],
  images: [],
  droppedImages: [],
};

describe('renderUserContext', () => {
  it('渲染 skill 正文与文件内容块', () => {
    const s = renderUserContext(ctx);
    expect(s).toContain('<user-context>');
    expect(s).toContain('<skill name="代码审查">');
    expect(s).toContain('逐条审查变更');
    expect(s).toContain('<file path="src/a.ts">');
    expect(s).toContain('const a = 1;');
  });

  it('content=null 的文件渲染为按需读取提示', () => {
    const s = renderUserContext(ctx);
    expect(s).toContain('<file path="big.bin">');
    expect(s).toContain('文件过大，请用文件工具按需读取');
  });

  it('空上下文返回空串', () => {
    expect(renderUserContext({ skills: [], files: [], images: [], droppedImages: [] })).toBe('');
  });
});

describe('renderTurnBody', () => {
  it('无 context 原样返回', () => {
    expect(renderTurnBody('你好', undefined)).toBe('你好');
  });

  it('有 context 时块在前正文在后，空正文也成立', () => {
    expect(renderTurnBody('你好', ctx)).toContain('你好');
    expect(renderTurnBody('', ctx)).toContain('<user-context>');
    expect(renderTurnBody('', ctx).endsWith('\n\n')).toBe(false);
  });
});

describe('renderUserContext sessions 块（跨会话引用）', () => {
  const sess = (over: Partial<ExpandedSessionItem> = {}): ExpandedSessionItem => ({
    sessionId: 's1',
    title: '设计讨论',
    kind: 'chat',
    memberNames: ['用户', 'Coder'],
    messageCount: 12,
    lastMessageAt: 1_700_000_000_000,
    missing: false,
    ...over,
  });

  it('正常态：元信息 + read_session 提示（含 sessionId）', () => {
    const out = renderUserContext({
      skills: [],
      files: [],
      images: [],
      droppedImages: [],
      sessions: [sess()],
    });
    expect(out).toContain('<session id="s1" title="设计讨论">');
    expect(out).toContain('成员=用户/Coder');
    expect(out).toContain('消息数=12');
    expect(out).toContain('read_session');
    expect(out).toContain('sessionId="s1"');
  });

  it('missing 态：降级文案，不出现 read_session 提示', () => {
    const out = renderUserContext({
      skills: [],
      files: [],
      images: [],
      droppedImages: [],
      sessions: [sess({ missing: true })],
    });
    expect(out).toContain('该会话已删除或不可访问');
    expect(out).not.toContain('read_session');
  });

  it('sessions 缺省（旧载荷）→ 无 session 块，skills/files 照常', () => {
    const out = renderUserContext({
      skills: [],
      files: [{ path: 'a.ts', content: 'x' }],
      images: [],
      droppedImages: [],
    });
    expect(out).not.toContain('<session');
    expect(out).toContain('<file path="a.ts">');
  });
});