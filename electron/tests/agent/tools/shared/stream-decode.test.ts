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
});
