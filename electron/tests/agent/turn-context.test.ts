// electron/tests/agent/turn-context.test.ts
// turn-context：ExpandedContext → 本轮用户正文包装（<user-context> 块）。
// 错误路径铁律：content=null 的文件渲染为「按需读取」提示行，不是吞掉。
import { describe, it, expect } from 'vitest';
import { renderTurnBody, renderUserContext } from '../../src/main/agent/turn-context';
import type { ExpandedContext } from '../../src/main/agent/runtime-config';

const ctx: ExpandedContext = {
  skills: [{ slug: 'code-review', name: '代码审查', body: '逐条审查变更' }],
  files: [
    { path: 'src/a.ts', content: 'const a = 1;' },
    { path: 'big.bin', content: null },
  ],
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
    expect(renderUserContext({ skills: [], files: [] })).toBe('');
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