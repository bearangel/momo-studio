// describeToolCall 单测：已知工具映射 + 未知工具优先级键回退 + 截断 + extras 上限。
import { describe, it, expect } from 'vitest';
import { describeToolCall } from './describe-tool-call';

describe('describeToolCall — 已知工具映射', () => {
  it('read_file 只显文件名（不显全路径）', () => {
    expect(describeToolCall('read_file', { path: 'src/components/app.ts' }).summary).toBe('app.ts');
  });
  it('write_file 经 filePath 键也取文件名', () => {
    expect(describeToolCall('write_file', { filePath: 'a/b/c.ts' }).summary).toBe('c.ts');
  });
  it('list_files 走 FILE_TOOLS：显示目录名且无 extraArgs', () => {
    const r = describeToolCall('list_files', { path: 'src/components' });
    expect(r.summary).toBe('components');
    expect(r.extraArgs).toEqual([]);
  });
  it('basename 尾部分隔符取最后非空段', () => {
    expect(describeToolCall('read_file', { path: 'src/components/' }).summary).toBe('components');
    expect(describeToolCall('mkdir', { path: 'a/b/' }).summary).toBe('b');
  });
  it('混合分隔符路径取文件名', () => {
    expect(describeToolCall('read_file', { path: 'a/b\\c.ts' }).summary).toBe('c.ts');
  });
  it('bash 取命令首行并截断到 60 字符', () => {
    const long = 'x'.repeat(80);
    const r = describeToolCall('bash', { command: `${long}\nsecond line` });
    expect(r.summary.endsWith('…')).toBe(true);
    expect(r.summary.length).toBe(60);
    expect(r.summary).not.toContain('second');
  });
  it('grep 组合 pattern 与 path', () => {
    expect(describeToolCall('grep', { pattern: 'useState', path: 'src/' }).summary).toBe('"useState" in src/');
  });
  it('glob 只显 pattern', () => {
    expect(describeToolCall('glob', { pattern: '**/*.test.ts' }).summary).toBe('**/*.test.ts');
  });
  it('空参数返回空摘要', () => {
    expect(describeToolCall('bash', {}).summary).toBe('');
  });
});

describe('describeToolCall — 未知/MCP 工具回退', () => {
  it('按优先级键取第一个非空字符串（description 优先于 path）', () => {
    const r = describeToolCall('mcp:github', { path: 'repo', description: '创建 issue' });
    expect(r.summary).toBe('创建 issue');
  });
  it('url / query / pattern / name 依次回退', () => {
    expect(describeToolCall('t1', { url: 'https://x.dev' }).summary).toBe('https://x.dev');
    expect(describeToolCall('t2', { query: '怎么写测试' }).summary).toBe('怎么写测试');
    expect(describeToolCall('t3', { pattern: 'foo' }).summary).toBe('foo');
    expect(describeToolCall('t4', { name: 'setup' }).summary).toBe('setup');
  });
  it('次要标量参数最多 2 个，主摘要用过的键不重复，对象值跳过', () => {
    const r = describeToolCall('mcp:x', {
      description: '做事',
      owner: 'alice',
      repo: 'bob',
      num: 3,
      ok: true,
      nested: { a: 1 },
    });
    expect(r.extraArgs).toEqual(['owner=alice', 'repo=bob']);
  });
  it('完全无匹配键时 summary 为空且 extras 收标量', () => {
    const r = describeToolCall('weird', { count: 9 });
    expect(r.summary).toBe('');
    expect(r.extraArgs).toEqual(['count=9']);
  });
});
