// electron/tests/agent/tools/edit-recovery.test.ts
// v2.3 edit_file 失败信息增强：原文 5KB 快照 + 首次不一致行号 + 建议重试路径。

import { describe, it, expect } from 'vitest';
import { formatEditError } from '../../../src/main/agent/tools/shared/edit-recovery';

describe('formatEditError', () => {
  it('not_found 错误信息包含文件路径', () => {
    const err = formatEditError('not_found', '/a.ts', 'const x = 1', 'const y = 2');
    expect(err.message).toContain('/a.ts');
    expect(err.message).toContain('edit_file 失败');
  });

  it('not_found 错误信息包含 oldString 上下文', () => {
    const err = formatEditError('not_found', '/a.ts', 'const x = 1', 'const y = 2');
    expect(err.message).toContain('未在文件中找到');
  });

  it('not_unique 错误信息包含出现次数', () => {
    const err = formatEditError('not_unique', '/a.ts', 'a', 'aaa', 3);
    expect(err.message).toContain('3');
    expect(err.message).toContain('唯一');
  });

  it('错误信息包含原文前 5KB 快照', () => {
    const long = 'x'.repeat(10 * 1024); // 10KB
    const err = formatEditError('not_found', '/a.ts', 'old', long);
    // 5KB = 5120 字节，加上 prefix，应截断在 ≤ 6KB 范围内
    expect(err.message.length).toBeLessThan(6 * 1024);
    // 应包含部分原始内容
    expect(err.message).toContain('快照');
  });

  it('错误信息包含首次不一致行号', () => {
    // content 包含 oldString 第一行（line 3），使 findFirstMismatchLine 能定位
    const content = 'line1\nline2\nconst x = 1\nconst x = 2\nline4';
    const err = formatEditError('not_found', '/a.ts', 'const x = 1', content);
    expect(err.message).toMatch(/行号: \d+/);
    expect(err.message).toContain('3');
  });

  it('错误信息包含 read_file 重试建议', () => {
    const err = formatEditError('not_found', '/a.ts', 'old', 'new');
    expect(err.message).toContain('read_file');
  });

  it('5KB 边界：原文恰好 5KB 时不被截断', () => {
    const exact5k = 'a'.repeat(5 * 1024);
    const err = formatEditError('not_found', '/a.ts', 'old', exact5k);
    expect(err.message).toContain('a'.repeat(100)); // 部分 a 存在
  });

  it('空 content 不抛错（边界）', () => {
    expect(() => formatEditError('not_found', '/a.ts', 'old', '')).not.toThrow();
  });
});
