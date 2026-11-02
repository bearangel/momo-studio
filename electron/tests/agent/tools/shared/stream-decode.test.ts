// electron/tests/agent/tools/shared/stream-decode.test.ts
//
// createUtf8Collector 单测：子进程输出流式 UTF-8 解码 + 按字符截断。
// 回归锁背景：旧实现逐 chunk `chunk.toString('utf-8')`——多字节字符被 pipe
// 边界切开时每半段各自解出 U+FFFD，真实会话表现为中文乱码。

import { describe, it, expect } from 'vitest';
import { createUtf8Collector } from '../../../../src/main/agent/tools/shared/stream-decode';

describe('createUtf8Collector', () => {
  it('多字节字符跨 chunk 边界不产生乱码（回归锁：旧实现 toString 逐 chunk 解必挂）', () => {
    const c = createUtf8Collector(1024);
    const bytes = Buffer.from('中文测试', 'utf8'); // 每个汉字 3 字节
    for (const b of [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]) c.write(b);
    c.end();
    expect(c.text).toBe('中文测试');
    expect(c.truncated).toBe(false);
  });

  it('超过 limit 截断并置标记，后续写入不再累加', () => {
    const c = createUtf8Collector(3);
    c.write(Buffer.from('中文测试', 'utf8'));
    c.write(Buffer.from('还有更多', 'utf8'));
    c.end();
    expect(c.text).toBe('中文测');
    expect(c.truncated).toBe(true);
  });

  it('恰好等于 limit 不置截断标记', () => {
    const c = createUtf8Collector(4);
    c.write(Buffer.from('中文测试', 'utf8'));
    c.end();
    expect(c.text).toBe('中文测试');
    expect(c.truncated).toBe(false);
  });

  it('不完整尾字节上 end() 不抛错', () => {
    const c = createUtf8Collector(1024);
    c.write(Buffer.from('中', 'utf8').subarray(0, 2));
    expect(() => c.end()).not.toThrow();
    expect(c.text.length).toBeLessThanOrEqual(1);
  });

  // 终审可选补强：满额后到达的空 chunk 只是 decoder 的 no-op（StringDecoder.write
  // 对空 buffer 返回空串），绝不能因为「又来了一次 write」就翻出截断标记。
  it('满额后到达空 chunk 不置截断标记', () => {
    const c = createUtf8Collector(4);
    c.write(Buffer.from('中文测试', 'utf8'));
    c.write(Buffer.alloc(0));
    c.end();
    expect(c.text).toBe('中文测试');
    expect(c.truncated).toBe(false);
  });

  // 终审可选补强：截断也可能只在 end() 冲尾字节时发生——限定的配额刚好比已解码
  // 文本多 0（剩余 0）而尾字节又补出字符，append 落在 remaining<=0 分支即置标记。
  it('仅靠 end() 的尾字节也能触发截断标记', () => {
    const c = createUtf8Collector(1);
    // 第一个 chunk 只给「中」的前 2 字节（不足一个字符，decoder 缓存住不外抛）
    c.write(Buffer.from('中', 'utf8').subarray(0, 2));
    expect(c.text).toBe('');
    // 补第 3 字节：flush 出「中」，恰好用满 limit=1
    c.write(Buffer.from('中', 'utf8').subarray(2));
    expect(c.text).toBe('中');
    expect(c.truncated).toBe(false);
    // 再挂一个不完整尾字节，end() 会把它当作 U+FFFD 冲出 → 超出配额 → 截断
    c.write(Buffer.from('文', 'utf8').subarray(0, 2));
    c.end();
    expect(c.truncated).toBe(true);
    expect(c.text).toBe('中');
  });
});
