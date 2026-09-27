// renderer/src/lib/message-context.test.ts
//
// parseMessageContext 单点收口的形状契约：合法 / null / 损坏 / 非法形状四类输入。
// 防御性：消费方统一用此函数，遇到非法载荷一律 null（按"无上下文"渲染），不抛错。
import { describe, it, expect } from 'vitest';
import { parseMessageContext } from './message-context';

describe('parseMessageContext', () => {
  it('合法 JSON 解析（skills + files 都为数组）', () => {
    expect(
      parseMessageContext(JSON.stringify({ skills: [], files: [{ path: 'a' }] })),
    ).toEqual({
      skills: [],
      files: [{ path: 'a' }],
    });
  });

  it('null 与损坏 JSON 返回 null', () => {
    expect(parseMessageContext(null)).toBeNull();
    expect(parseMessageContext('{oops')).toBeNull();
    expect(parseMessageContext('')).toBeNull();
  });

  it('形状非法（skills/files 非数组）返回 null', () => {
    expect(parseMessageContext('{"skills":1}')).toBeNull();
    expect(parseMessageContext('{"files":"x"}')).toBeNull();
    expect(parseMessageContext('{"skills":[],"files":[]}')).toEqual({
      skills: [],
      files: [],
    });
  });

  it('顶层不是对象（数组 / 字符串）返回 null', () => {
    expect(parseMessageContext('[]')).toBeNull();
    expect(parseMessageContext('"hello"')).toBeNull();
  });

  // === 多模态 Task 5：images 可选字段（旧消息缺省兼容，绝不新 null 化） ===

  it('合法 images 解析保留', () => {
    expect(
      parseMessageContext(
        JSON.stringify({
          skills: [],
          files: [{ path: 'a' }],
          images: [{ path: '.momo/assets/ab.png', w: 100, h: 50 }],
        }),
      ),
    ).toEqual({
      skills: [],
      files: [{ path: 'a' }],
      images: [{ path: '.momo/assets/ab.png', w: 100, h: 50 }],
    });
  });

  it('images 非数组 → 视为缺省（context 不为 null，skills/files 照常）', () => {
    expect(parseMessageContext(JSON.stringify({ skills: [], files: [], images: 'x' }))).toEqual({
      skills: [],
      files: [],
    });
  });

  it('images 含畸形元素（path 非字符串 / 非正数 w·h）→ 整体视为缺省，context 非 null', () => {
    expect(
      parseMessageContext(JSON.stringify({ skills: [], files: [], images: [{ path: 1, w: 2, h: 3 }] })),
    ).toEqual({ skills: [], files: [] });
    expect(
      parseMessageContext(JSON.stringify({ skills: [], files: [], images: [{ path: 'a.png', w: 0, h: 3 }] })),
    ).toEqual({ skills: [], files: [] });
  });

  it('旧消息形状（无 images 字段）→ context 照常解析（不 null 化）', () => {
    expect(parseMessageContext(JSON.stringify({ skills: [], files: [{ path: 'a' }] }))).toEqual({
      skills: [],
      files: [{ path: 'a' }],
    });
  });
});
