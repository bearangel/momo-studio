// electron/tests/compaction/serialize.test.ts
//
// 验证对话序列化（spec §4.2）：
//   - user/assistant 文本 → [用户]:/[助手]:
//   - assistant 带 toolCalls → [工具调用]: name(JSON) + 后续 [工具结果]:...
//   - tool 角色结果 >2000 字符截断 + [truncated]
//
// 保真度要点（momo-test-rules）：
//   - LLMMessage 直接从 llm-provider.ts 导入真实类型，不造简化 fixture
//   - 工具参数用 JSON.stringify 序列化（与 spec §4.2 对齐；与 OpenAI/Anthropic
//     转换逻辑一致——toOpenAIMessage/toAnthropicMessage 都是 JSON.stringify）
//   - 截断「2000 字符」是字面字符数（spec §4.2 / §8 同源——拉取层都按字符截断），
//     不是字节数也不是 token 数

import { describe, it, expect } from 'vitest';
import { serializeMessages } from '../../src/main/compaction/serialize';
import type { LLMMessage } from '../../src/main/agent/llm-provider';

describe('serializeMessages - 文本角色（spec §4.2）', () => {
  it('① user 文本映射 [用户]:', () => {
    const out = serializeMessages([{ role: 'user', content: '你好世界' }]);
    expect(out).toContain('[用户]: 你好世界');
  });

  it('① assistant 文本映射 [助手]:', () => {
    const out = serializeMessages([{ role: 'assistant', content: '你好！有什么可以帮你的？' }]);
    expect(out).toContain('[助手]: 你好！有什么可以帮你的？');
  });

  it('system 角色按 [系统]: 前缀（兼容 LLMMessage 形态）', () => {
    const out = serializeMessages([{ role: 'system', content: '你是助手' }]);
    expect(out).toContain('[系统]: 你是助手');
  });

  it('空消息数组返回空字符串', () => {
    expect(serializeMessages([])).toBe('');
  });
});

describe('serializeMessages - toolCalls 与 tool 结果（spec §4.2）', () => {
  it('② assistant 带 toolCalls 输出 [工具调用]: name(JSON)', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_abc',
            name: 'read_file',
            arguments: { path: '/tmp/x.txt' },
          },
        ],
      },
    ];
    const out = serializeMessages(messages);
    expect(out).toContain('[工具调用]: read_file(');
    expect(out).toContain('"path":"/tmp/x.txt"');
    // toolCallId 不直接进入序列化（spec 4.2 不要求），但也不允许泄露
    expect(out).not.toContain('call_abc');
  });

  it('② 后续 role=tool 消息输出 [工具结果]:', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        ],
      },
      { role: 'tool', content: '查询成功', toolCallId: 'call_1' },
    ];
    const out = serializeMessages(messages);
    expect(out).toMatch(/\[工具调用\]:[\s\S]*\[工具结果\]: 查询成功/);
  });

  it('② 多个 toolCalls 全部输出（按序）', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'a', arguments: { x: 1 } },
          { id: 'c2', name: 'b', arguments: { y: 2 } },
        ],
      },
    ];
    const out = serializeMessages(messages);
    const idxA = out.indexOf('[工具调用]: a(');
    const idxB = out.indexOf('[工具调用]: b(');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('assistant 同时有文本和 toolCalls 时，文本在前工具调用在后', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: '我帮你查一下',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
      },
    ];
    const out = serializeMessages(messages);
    const idxText = out.indexOf('[助手]: 我帮你查一下');
    const idxTool = out.indexOf('[工具调用]: lookup(');
    expect(idxText).toBeGreaterThan(-1);
    expect(idxTool).toBeGreaterThan(idxText);
  });
});

describe('serializeMessages - 工具结果截断（spec §4.2 + §8）', () => {
  it('③ tool 结果 >2000 字符截断 + 追加 [truncated]', () => {
    const longContent = 'A'.repeat(2500);
    const messages: LLMMessage[] = [
      { role: 'tool', content: longContent, toolCallId: 'call_1' },
    ];
    const out = serializeMessages(messages);
    expect(out).toContain('[工具结果]: ');
    expect(out).toContain('[truncated]');
    // 2000 字符的 A 不应全部出现
    expect(out).not.toContain('A'.repeat(2500));
    // 但前 2000 字符应保留
    expect(out).toContain('A'.repeat(2000));
  });

  it('工具结果 ≤2000 字符不截断（无 [truncated]）', () => {
    const shortContent = 'B'.repeat(2000);
    const messages: LLMMessage[] = [
      { role: 'tool', content: shortContent, toolCallId: 'call_1' },
    ];
    const out = serializeMessages(messages);
    expect(out).toContain('B'.repeat(2000));
    expect(out).not.toContain('[truncated]');
  });
});

// === 多模态压缩占位（Task 9 D4，spec §9：压缩后历史天然无图）===
describe('serializeMessages - 图片占位（spec 2026-09-26-image-input-multimodal §9）', () => {
  it('带 2 图的 user 消息 → [用户] 行后逐图 [图片: path] 占位行，base64 不进摘要', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: '看这两张图',
        images: [
          { mime: 'image/png', base64: 'AAAA', w: 100, h: 80, path: 'assets/a.png' },
          { mime: 'image/jpeg', base64: 'BBBB', w: 100, h: 80, path: 'assets/b.jpg' },
        ],
      },
    ];
    const out = serializeMessages(messages);
    const userLine = out.indexOf('[用户]: 看这两张图');
    const ph1 = out.indexOf('[图片: assets/a.png]');
    const ph2 = out.indexOf('[图片: assets/b.jpg]');
    expect(userLine).toBeGreaterThan(-1);
    // 占位行存在且顺序跟随 [用户] 行
    expect(ph1).toBeGreaterThan(userLine);
    expect(ph2).toBeGreaterThan(ph1);
    // images 字段本身不进压缩表示（base64 绝不泄漏）
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('BBBB');
  });

  it('path 缺省（契约外但防御）→ 回退 mime 标注占位', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: '匿名图',
        images: [{ mime: 'image/png', base64: 'CCCC', w: 10, h: 10 }],
      },
    ];
    const out = serializeMessages(messages);
    expect(out).toContain('[图片: image/png]');
  });

  it('无图消息 → 输出逐字节不变（零回归）', () => {
    const out = serializeMessages([{ role: 'user', content: '纯文本' }]);
    expect(out).toBe('[用户]: 纯文本');
  });
});
