// renderer/src/lib/mcp-json.test.ts
// P2.4 Task 4：MCP JSON 解析器直接单测（spec §6.1）——三顶层格式、
// type 权威判定（含 sse 报错/矛盾检测）、headers 校验、无 type 推断回归。
import { describe, it, expect } from 'vitest';
import { parseMcpServersJson } from './mcp-json';

describe('顶层格式三态识别', () => {
  it('mcpServers 包裹（既有）', () => {
    const entries = parseMcpServersJson('{"mcpServers":{"a":{"command":"npx"}}}');
    expect(entries).toEqual([{ name: 'a', command: 'npx' }]);
  });

  it('VS Code servers 键', () => {
    const entries = parseMcpServersJson('{"servers":{"vs":{"type":"stdio","command":"npx","args":["-y","x"]}}}');
    expect(entries).toEqual([{ name: 'vs', command: 'npx', args: ['-y', 'x'] }]);
  });

  it('裸对象（既有）', () => {
    const entries = parseMcpServersJson('{"bare":{"command":"node"}}');
    expect(entries).toEqual([{ name: 'bare', command: 'node' }]);
  });

  it('mcpServers 与 servers 并存时 mcpServers 优先', () => {
    const entries = parseMcpServersJson('{"mcpServers":{"first":{"command":"a"}},"servers":{"second":{"command":"b"}}}');
    expect(entries.map((e) => e.name)).toEqual(['first']);
  });

  it('servers 存在但非对象 → 报错提示 VS Code 格式', () => {
    expect(() => parseMcpServersJson('{"servers":"oops"}')).toThrow(/servers/);
  });
});

describe('type 权威判定', () => {
  it('type:http → 远程（headers 一并解析）', () => {
    const entries = parseMcpServersJson('{"mcpServers":{"c7":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"Authorization":"Bearer k"}}}}');
    expect(entries).toEqual([{ name: 'c7', command: '', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer k' } }]);
  });

  it('type:streamable-http / streamable_http 两种拼写归一远程', () => {
    const e1 = parseMcpServersJson('{"a":{"type":"streamable-http","url":"https://x.com/m"}}');
    const e2 = parseMcpServersJson('{"b":{"type":"streamable_http","url":"https://x.com/m"}}');
    expect(e1[0]!.url).toBe('https://x.com/m');
    expect(e2[0]!.url).toBe('https://x.com/m');
  });

  it('type:sse → 明确报「暂不支持 SSE」', () => {
    expect(() => parseMcpServersJson('{"old":{"type":"sse","url":"https://x.com/sse"}}')).toThrow(/暂不支持 SSE 传输/);
  });

  it('type:stdio + url → 矛盾报错', () => {
    expect(() => parseMcpServersJson('{"x":{"type":"stdio","url":"https://x.com/m"}}')).toThrow(/请二选一/);
  });

  it('type:http 缺 url → 报错', () => {
    expect(() => parseMcpServersJson('{"x":{"type":"http"}}')).toThrow(/缺少 url/);
  });

  it('type:http + command → 矛盾报错', () => {
    expect(() => parseMcpServersJson('{"x":{"type":"http","url":"https://x.com/m","command":"npx"}}')).toThrow(/请二选一/);
  });

  it('未知 type → 报错', () => {
    expect(() => parseMcpServersJson('{"x":{"type":"websocket"}}')).toThrow(/无法识别/);
  });

  it('无 type + url → 远程（既有推断回归）', () => {
    const entries = parseMcpServersJson('{"r":{"url":"https://x.com/m"}}');
    expect(entries[0]!.url).toBe('https://x.com/m');
  });
});

describe('headers 校验（远程条目）', () => {
  it('headers 非对象 → 报错含条目名', () => {
    expect(() => parseMcpServersJson('{"x":{"url":"https://x.com/m","headers":["a"]}}')).toThrow(/"x" 的 headers 必须是对象/);
  });

  it('headers 值非字符串 → 报错含键名', () => {
    expect(() => parseMcpServersJson('{"x":{"url":"https://x.com/m","headers":{"k":1}}}')).toThrow(/headers\.k/);
  });

  it('非 https url → 报错（既有）', () => {
    expect(() => parseMcpServersJson('{"x":{"url":"http://x.com/m"}}')).toThrow(/https/);
  });

  it('stdio 条目带 headers → 静默忽略（仅远程有意义）', () => {
    const entries = parseMcpServersJson('{"x":{"command":"npx","headers":{"A":"b"}}}');
    expect(entries[0]!.headers).toBeUndefined();
  });
});

describe('既有 stdio 解析回归', () => {
  it('command/args/env 全字段', () => {
    const entries = parseMcpServersJson('{"mcpServers":{"g":{"command":"npx","args":["-y","s"],"env":{"T":"1"}}}}');
    expect(entries).toEqual([{ name: 'g', command: 'npx', args: ['-y', 's'], env: { T: '1' } }]);
  });

  it('缺 command 报错（既有）', () => {
    expect(() => parseMcpServersJson('{"x":{}}')).toThrow(/缺少 command/);
  });
});

// —— 既有回归锁（Task 4 前已存在，错误路径/空输入用例按测试规则保留）——
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

  it('args 非数组 / env 值非字符串 抛错误', () => {
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', args: 'y' } } })),
    ).toThrow('args 必须是字符串数组');
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { a: { command: 'x', env: { K: 1 } } } })),
    ).toThrow('env.K 值必须是字符串');
  });

  it('url 型远程条目解析为 remote entry（P2 转正）', () => {
    const entries = parseMcpServersJson(
      '{"mcpServers": {"weather": {"url": "https://mcp.example.com/sse"}}}',
    );
    expect(entries[0]!.url).toBe('https://mcp.example.com/sse');
    expect(entries[0]!.command).toBe('');
  });

  it('非 https url 拒绝', () => {
    expect(() =>
      parseMcpServersJson('{"mcpServers": {"bad": {"url": "http://x.test"}}}'),
    ).toThrow(/https/);
  });

  it('url 空串视为未提供（走 stdio 校验，缺 command 抛错）', () => {
    expect(() =>
      parseMcpServersJson(JSON.stringify({ mcpServers: { blank: { url: '' } } })),
    ).toThrow('服务器 "blank" 缺少 command 字段');
  });
});
