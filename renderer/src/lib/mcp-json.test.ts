import { describe, expect, it } from 'vitest';
import { parseMcpServersJson } from './mcp-json';

describe('parseMcpServersJson', () => {
  it('解析标准 mcpServers 包裹结构', () => {
    const out = parseMcpServersJson(
      JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['-y', 'server.js'], env: { TOKEN: 'x' } } },
      }),
    );
    expect(out).toEqual([
      { name: 'github', command: 'npx', args: ['-y', 'server.js'], env: { TOKEN: 'x' } },
    ]);
  });

  it('解析裸对象结构（无 mcpServers 包裹）', () => {
    expect(parseMcpServersJson(JSON.stringify({ search: { command: 'uvx' } }))).toEqual([
      { name: 'search', command: 'uvx' },
    ]);
  });

  it('多服务器一次解析多条', () => {
    const out = parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    expect(out.length).toBe(2);
  });

  it('非 JSON 抛中文错误', () => {
    expect(() => parseMcpServersJson('not json')).toThrow('内容不是合法 JSON');
  });

  it('根不是对象 / 空对象抛中文错误', () => {
    expect(() => parseMcpServersJson('[1]')).toThrow('根必须是 JSON 对象');
    expect(() => parseMcpServersJson('{}')).toThrow('未找到服务器定义');
  });

  it('条目缺 command 抛含名称的错误', () => {
    expect(() => parseMcpServersJson(JSON.stringify({ mcpServers: { bad: {} } }))).toThrow(
      '服务器 "bad" 缺少 command 字段',
    );
  });

  it('args 非数组 / env 值非字符串 / url 型远程条目 抛错误', () => {
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', args: 'y' } } })),
    ).toThrow('args 必须是字符串数组');
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', env: { K: 1 } } } })),
    ).toThrow('env.K 值必须是字符串');
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { r: { url: 'https://x' } } })),
    ).toThrow('仅支持 stdio');
  });
});
