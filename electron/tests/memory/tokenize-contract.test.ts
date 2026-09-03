// electron/tests/memory/tokenize-contract.test.ts
// 分词同源契约锁（spec §11.3）：写入侧 tokenizeForIndex 与查询侧 buildMatchExpr
// 必须经由同一个 jieba cut——本测试锁死两侧产出的一致性，防契约漂移。
import { describe, it, expect } from 'vitest';
import { tokenizeForIndex, buildMatchExpr } from '../../src/main/storage/memories/tokenize';

describe('tokenize 同源契约', () => {
  it('索引侧：中文按词切分、空格连接；英文按词保留', () => {
    const out = tokenizeForIndex('用户偏好简洁回答 prefer TypeScript');
    expect(out).toContain(' ');
    // jieba 会把「用户」「偏好」切成独立词（而非单字流）
    expect(out.split(' ')).toEqual(expect.arrayContaining(['用户', '偏好', 'prefer', 'TypeScript']));
  });

  it('查询侧：每个 token 双引号包裹、空格(AND)连接', () => {
    const expr = buildMatchExpr('研发 规范');
    expect(expr).toBe('"研发" "规范"');
  });

  it('同源契约：同一文本两侧 token 序列一致（去包裹后）', () => {
    const text = 'JWT 令牌过期处理';
    const indexTokens = tokenizeForIndex(text).split(' ');
    const queryTokens = buildMatchExpr(text)
      .split(' ')
      .map((t) => t.replace(/^"|"$/g, '').replace(/""/g, '"'));
    expect(queryTokens).toEqual(indexTokens);
  });

  it('查询侧转义：token 内双引号翻倍；空查询返回空串', () => {
    expect(buildMatchExpr('a"b')).toBe('"a""b"');
    expect(buildMatchExpr('   ')).toBe('');
  });
});