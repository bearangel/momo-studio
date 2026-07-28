// electron/tests/mcp/client.test.ts
//
// McpClient 全链路测试：用一个 fake MCP server 子进程模拟 server 端，
// 验证 connect（initialize 握手）-> listTools -> callTool -> disconnect 完整流程。
//
// fake server 用 node 执行：从 stdin 读 NDJSON，按 method 写响应到 stdout。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpClient } from '../../src/main/mcp/client';
import type { McpServerConfig } from '../../src/main/mcp/types';

// fake MCP server 脚本（CommonJS，子进程独立运行）
const fakeServerScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
    }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // notification 无需响应
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [
        { name: 'read_file', description: '读文件', inputSchema: { type: 'object' } }
      ]}
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: 'result: ' + JSON.stringify(msg.params.arguments) }], isError: false }
    }) + '\\n');
  }
});
`;

const tmpDir = path.join(os.tmpdir(), `ap-mcp-test-${Date.now()}`);
let fakeScriptPath: string;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fakeScriptPath = path.join(tmpDir, 'fake-mcp-server.js');
  fs.writeFileSync(fakeScriptPath, fakeServerScript);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp/client', () => {
  it('connect + listTools + callTool + disconnect', async () => {
    const config: McpServerConfig = {
      id: 'test',
      name: 'test-mcp',
      version: '1.0.0',
      command: 'node',
      args: [fakeScriptPath],
    };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected).toBe(true);

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('read_file');

    const result = await client.callTool('read_file', { path: 'test.txt' });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('test.txt');

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  }, 10000);
});
