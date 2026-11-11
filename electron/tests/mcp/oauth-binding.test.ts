// electron/tests/mcp/oauth-binding.test.ts
//
// Task 12：MCP OAuth 绑定字段 + 认证解析器注入点 + 扇出驱逐测试。
//   - setMcpOAuthBinding 写绑定与 env 变量名 → getMcpConfig 读回（NULL → undefined）
//   - 传 null 清空绑定（unbind 写 NULL/NULL，不动其他列）
//   - setMcpOAuthBinding 未知 MCP 名 → 抛「未注册」中文错（错误路径专项）
//   - 已绑定连接时 getOrStartMcp 调用 resolver，其返回的 headers 真实生效
//     （真实 HTTP MCP fixture：JSON-RPC initialize + tools/list，真 socket，不 mock http/fetch）
//   - 未绑定连接时 resolver 零调用
//   - resolver 抛错 → 本次 getOrStartMcp reject，后续调用重试恢复（错误路径专项）
//   - evictMcpsByConnection 跨全部 workspace pool key 驱逐该连接引用的实例
//   - evictMcpsByConnection 对无引用连接返回空数组（错误/空输入专项，momo-test-rules 铁律 3）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getMcpConfig, getOrStartMcp, listMcpTools, setMcpAuthResolver,
  setMcpOAuthBinding, evictMcpsByConnection,
} from '../../src/main/mcp/host-manager';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-oauth-${Date.now()}-${process.pid}`);

let server: http.Server;
let base = '';
let lastAuth = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  lastAuth = '';
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      lastAuth = req.headers.authorization ?? '';
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb()
    .prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
       VALUES ('m1', 'fixture', '1.0.0', 'streamable_http', '', '[]')`,
    )
    .run();
});

afterEach(async () => {
  setMcpAuthResolver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('setMcpOAuthBinding', () => {
  it('写绑定与 env 变量名，getMcpConfig 可读回', () => {
    setMcpOAuthBinding('fixture', 'conn-1', 'GH_TOKEN');
    const config = getMcpConfig('fixture');
    expect(config?.oauthConnectionId).toBe('conn-1');
    expect(config?.oauthEnvVar).toBe('GH_TOKEN');
  });

  it('传 null 清空绑定', () => {
    setMcpOAuthBinding('fixture', 'conn-1', null);
    setMcpOAuthBinding('fixture', null, null);
    expect(getMcpConfig('fixture')?.oauthConnectionId).toBeUndefined();
    expect(getMcpConfig('fixture')?.oauthEnvVar).toBeUndefined();
  });

  it('未知 MCP 名 → 抛「未注册」中文错（错误路径专项）', () => {
    expect(() => setMcpOAuthBinding('no-such-mcp', 'conn-1', null)).toThrow(
      'MCP no-such-mcp 未注册',
    );
  });
});

describe('getOrStartMcp 注入与扇出驱逐', () => {
  it('已绑定连接时调用 resolver，其返回的 headers 生效', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'conn-1', null);
    const calls: string[] = [];
    setMcpAuthResolver(async (config) => {
      calls.push(config.name);
      return { ...config, headers: { ...(config.headers ?? {}), Authorization: 'Bearer injected' } };
    });
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    expect(calls).toEqual(['fixture']);
    expect(lastAuth).toBe('Bearer injected');
  });

  it('未绑定连接时不调用 resolver', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    const calls: string[] = [];
    setMcpAuthResolver(async (config) => { calls.push(config.name); return config; });
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    expect(calls).toEqual([]);
  });

  it('resolver 抛错时本次启动失败，后续调用可重试恢复（失败 promise 不驻留）', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'conn-1', null);
    setMcpAuthResolver(() => Promise.reject(new Error('resolver boom')));
    // 第一次调用：resolver 拒绝沿 in-flight promise 透传 → getOrStartMcp 整体 reject
    await expect(getOrStartMcp('ws-retry', getMcpConfig('fixture')!)).rejects.toThrow(
      'resolver boom',
    );
    // 重试语义锁：失败后池不留死状态——换回正常 resolver，同一 workspace 再调即重新走完整启动
    setMcpAuthResolver(async (config) => config);
    const client = await getOrStartMcp('ws-retry', getMcpConfig('fixture')!);
    expect(client.isConnected).toBe(true);
    await client.disconnect(); // 回收，避免池实例泄漏到后续用例
  });

  it('evictMcpsByConnection 驱逐该连接引用的全部实例（含多 workspace）', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'conn-1', null);
    setMcpAuthResolver(async (config) => config);
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    await getOrStartMcp('ws-2', getMcpConfig('fixture')!);
    const names = await evictMcpsByConnection('conn-1');
    expect(names).toEqual(['fixture']);
    await expect(listMcpTools('ws-1', 'fixture')).rejects.toThrow(/未启动/);
    await expect(listMcpTools('ws-2', 'fixture')).rejects.toThrow(/未启动/);
  });

  it('evictMcpsByConnection 对无引用连接返回空数组', async () => {
    expect(await evictMcpsByConnection('nobody')).toEqual([]);
  });
});
