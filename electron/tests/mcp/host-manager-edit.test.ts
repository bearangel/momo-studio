// electron/tests/mcp/host-manager-edit.test.ts
//
// P2.2 Task 3：host-manager 编辑断面测试。
//   - updateRemoteMcpDefinition：专用 UPDATE——保 id/installed_at（不走
//     INSERT OR REPLACE），url/headers_json 更新；config_schema 未传保留
//     原列值、传入则替换；错误路径专项（未注册 / stdio 行 / 非 https url，
//     拒绝后行不动）
//   - evictMcpByName：name 级池驱逐——跨 workspace 同名连接全清 +
//     disconnect 生效；旁观 name 不受影响；驱逐后 getOrStartMcp 走重建
//     路径（新实例）；池内启动失败态（rejected promise）吞掉；幂等
//   - 集成锁（编辑生效闭环）：注册 → 连接 → 编辑定义 → 驱逐 →
//     callMcpTool 重建握手携带新 Authorization（Task 4 resource 层依赖的
//     「下回合用新 headers 重建」契约在此锁死）
//
// DB 隔离沿用仓库既定模式（照抄 host-manager-remote.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表（真实跑全量迁移）
//   - closeDb() 在 afterEach 复位单例
//
// evict 断面不 mock HttpMcpClient 类——真实客户端 + fetch 网络边界 stub
// （momo-test-rules 铁律 5：只 mock 网络，业务逻辑全真）。disconnect 语义
// 经真实实例的 isConnected 观测；池驱逐经 listMcpTools 未启动报错 +
// getOrStartMcp 重建新实例观测。池是 host-manager 模块级 Map，跨用例
// 残留用独立 name/workspace 隔离 + afterEach 统一驱逐清理。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  registerMcpDefinition,
  getMcpConfig,
  getOrStartMcp,
  callMcpTool,
  listMcpTools,
  updateRemoteMcpDefinition,
  evictMcpByName,
} from '../../src/main/mcp/host-manager';
import type { McpServerConfig } from '../../src/main/mcp/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-edit-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── evict 断面共用的 remote 配置构造 ─────────────────────────────────────

function remoteCfg(
  name: string,
  url: string,
  headers?: Record<string, string>,
): McpServerConfig {
  return {
    id: `cfg-${name}`,
    name,
    version: '1.0.0',
    transport: 'streamable_http',
    command: '',
    args: [],
    url,
    headers,
  };
}

/**
 * fetch stub：覆盖 initialize / notifications/initialized / tools/call 三个
 * JSON-RPC 方法（HttpMcpClient 连接与调用全路径）。记录每次 initialize
 * 请求携带的 Authorization 头——「编辑生效后重建用新 headers」的断言依据。
 */
function stubRemoteFetch(): { restore: () => void; authSeen: string[] } {
  const authSeen: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string;
        id?: number;
      };
      const headers = init?.headers as Record<string, string> | undefined;
      if (body.method === 'initialize') {
        authSeen.push(headers?.Authorization ?? '');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }), // 生产代码按 content-type 分流
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: { serverInfo: {}, capabilities: {} },
          }),
        } as unknown as Response;
      }
      if (body.method === 'notifications/initialized') {
        return { ok: true, status: 202 } as unknown as Response;
      }
      if (body.method === 'tools/call') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: 'ok-rebuilt' }],
              isError: false,
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`未桩：${body.method}`);
    },
  );
  return { restore: () => spy.mockRestore(), authSeen };
}

// 本文件 evict 相关用例动过的 name——afterEach 统一驱逐，避免模块级池
// 跨用例残留（host-manager 模块在文件内只加载一次）。
const evictUsedNames: string[] = [];

// ─── updateRemoteMcpDefinition（编辑断面） ─────────────────────────────────

describe('updateRemoteMcpDefinition（P2.2 Task 3）', () => {
  it('更新 url/headers 且保 id/installed_at/config_schema（专用 UPDATE 不换行）', () => {
    const schema = {
      required: ['k'],
      properties: { k: { title: 'K', 'x-from': 'header' as const } },
    };
    registerMcpDefinition({
      id: 'u1',
      name: 'edit-mcp',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://old.test/mcp',
      headers: { Authorization: 'Bearer old' },
      configSchema: schema,
      source: 'custom',
    });
    const before = getDb()
      .prepare('SELECT id, installed_at FROM mcp_definitions WHERE name = ?')
      .get('edit-mcp') as { id: string; installed_at: string };

    updateRemoteMcpDefinition('edit-mcp', 'https://new.test/mcp', {
      Authorization: 'Bearer new',
    });

    const row = getDb()
      .prepare(
        'SELECT id, installed_at, url, headers_json, config_schema FROM mcp_definitions WHERE name = ?',
      )
      .get('edit-mcp') as {
      id: string;
      installed_at: string;
      url: string;
      headers_json: string;
      config_schema: string;
    };
    // 专用 UPDATE 核心不变量：id / installed_at 原样保留（不走 REPLACE 换行）
    expect(row.id).toBe(before.id);
    expect(row.installed_at).toBe(before.installed_at);
    expect(row.url).toBe('https://new.test/mcp');
    expect(JSON.parse(row.headers_json)).toEqual({ Authorization: 'Bearer new' });
    // schema 未传 → 原列值保留
    expect(JSON.parse(row.config_schema)).toEqual(schema);
    // 读取链路（Task 4 表单回填源）拿到新值
    const cfg = getMcpConfig('edit-mcp');
    expect(cfg?.url).toBe('https://new.test/mcp');
    expect(cfg?.headers).toEqual({ Authorization: 'Bearer new' });
    expect(cfg?.configSchema).toEqual(schema);
  });

  it('传入新 configSchema → 列替换；传空对象 → 清空（读回 undefined）', () => {
    registerMcpDefinition({
      id: 'u2',
      name: 'edit-schema',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://x.test/mcp',
      configSchema: { properties: { k: { title: 'K' } } },
      source: 'custom',
    });
    updateRemoteMcpDefinition('edit-schema', 'https://x.test/mcp', {}, {
      properties: { t: { title: 'T', 'x-from': 'query' } },
    });
    expect(getMcpConfig('edit-schema')?.configSchema).toEqual({
      properties: { t: { title: 'T', 'x-from': 'query' } },
    });
    // 显式传空对象 = 清空 schema（'{}' 兜底语义，读回 undefined）
    updateRemoteMcpDefinition('edit-schema', 'https://x.test/mcp', {}, {});
    expect(getMcpConfig('edit-schema')?.configSchema).toBeUndefined();
  });

  it('空 headers 编辑合法（清空凭证场景）', () => {
    registerMcpDefinition({
      id: 'u3',
      name: 'edit-noauth',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer old' },
      source: 'custom',
    });
    updateRemoteMcpDefinition('edit-noauth', 'https://x.test/mcp', {});
    expect(getMcpConfig('edit-noauth')?.headers).toEqual({});
  });

  it('名字不存在 → 抛「未注册」', () => {
    expect(() =>
      updateRemoteMcpDefinition('ghost-mcp', 'https://x.test/mcp', {}),
    ).toThrow(/未注册/);
  });

  it('stdio 行 → 中文拒绝且行不动', () => {
    registerMcpDefinition({
      id: 'u4',
      name: 'stdio-mcp',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'mcp-server-fs'],
      source: 'custom',
    });
    expect(() =>
      updateRemoteMcpDefinition('stdio-mcp', 'https://x.test/mcp', {}),
    ).toThrow(/不是远程条目/);
    const cfg = getMcpConfig('stdio-mcp');
    expect(cfg?.transport).toBe('stdio');
    expect(cfg?.command).toBe('npx');
  });

  it('非 https url → 拒绝且不落库', () => {
    registerMcpDefinition({
      id: 'u5',
      name: 'https-guard',
      version: '1.0.0',
      transport: 'streamable_http',
      command: '',
      args: [],
      url: 'https://old.test/mcp',
      source: 'custom',
    });
    expect(() =>
      updateRemoteMcpDefinition('https-guard', 'http://plain.test/mcp', {}),
    ).toThrow(/https/);
    // 校验失败的定义不得被改写
    expect(getMcpConfig('https-guard')?.url).toBe('https://old.test/mcp');
  });
});

// ─── evictMcpByName（name 级池驱逐） ────────────────────────────────────────

describe('evictMcpByName（P2.2 Task 3）', () => {
  const usedNames = new Set<string>();
  const track = <T>(name: string, cfg: T): T => {
    usedNames.add(name);
    return cfg;
  };

  afterEach(async () => {
    // 清空本 describe 动过的池条目，避免影响文件内后续用例
    for (const n of usedNames) await evictMcpByName(n);
    usedNames.clear();
    for (const n of evictUsedNames) await evictMcpByName(n);
    evictUsedNames.length = 0;
  });

  it('驱逐跨 workspace 同名连接（disconnect 生效 + 池条目删除 + 重建新实例）', async () => {
    const stub = stubRemoteFetch();
    try {
      const cfg = track(
        'evict-mcp',
        remoteCfg('evict-mcp', 'https://evict.test/mcp'),
      );
      const c1 = await getOrStartMcp('ws-evict-1', cfg);
      // 同 workspace 同名复用单实例（池语义前提）
      const c1Again = await getOrStartMcp('ws-evict-1', cfg);
      expect(c1Again).toBe(c1);
      // 另一 workspace 同名 → 第二个连接
      const c2 = await getOrStartMcp('ws-evict-2', cfg);

      await evictMcpByName('evict-mcp');

      // 两个 workspace 的连接都已断开（真实 disconnect 翻状态）
      expect(c1.isConnected).toBe(false);
      expect(c2.isConnected).toBe(false);
      // 池条目已删：listMcpTools 直接报未启动（不经重建）
      await expect(listMcpTools('ws-evict-1', 'evict-mcp')).rejects.toThrow(
        /未启动/,
      );
      // 重建路径：驱逐后 getOrStartMcp 建新实例，而非复用旧实例
      const c3 = await getOrStartMcp('ws-evict-1', cfg);
      expect(c3).not.toBe(c1);
      expect(c3.isConnected).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('只驱逐目标 name，旁观 name 连接保留', async () => {
    const stub = stubRemoteFetch();
    try {
      const target = track(
        'scope-target',
        remoteCfg('scope-target', 'https://scope.test/t'),
      );
      const bystander = track(
        'scope-other',
        remoteCfg('scope-other', 'https://scope.test/o'),
      );
      const ct = await getOrStartMcp('ws-scope-a', target);
      const cb = await getOrStartMcp('ws-scope-b', bystander);

      await evictMcpByName('scope-target');

      expect(ct.isConnected).toBe(false);
      expect(cb.isConnected).toBe(true);
      // 旁观者池条目未动：仍是同一实例
      const cbAgain = await getOrStartMcp('ws-scope-b', bystander);
      expect(cbAgain).toBe(cb);
    } finally {
      stub.restore();
    }
  });

  it('池内启动失败态（rejected promise）吞掉不抛', async () => {
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        throw new Error('网络断');
      });
    try {
      track('fail-mcp', 'fail');
      const cfg = remoteCfg('fail-mcp', 'https://fail.test/mcp');
      // 连接失败 → 池内留下 rejected promise（getOrStartMcp 不清它）
      await expect(getOrStartMcp('ws-fail', cfg)).rejects.toThrow(/网络断/);
      // evict 对启动失败态吞掉，resolve 不抛
      await expect(evictMcpByName('fail-mcp')).resolves.toBeUndefined();
    } finally {
      stub.mockRestore();
    }
  });

  it('名字无池条目 → 幂等不抛（空输入边界）', async () => {
    await expect(evictMcpByName('never-started')).resolves.toBeUndefined();
  });
});

// ─── 集成锁：编辑生效闭环（Task 4 resource 层消费契约） ─────────────────────

describe('编辑生效闭环（update + evict + 重建）', () => {
  afterEach(async () => {
    await evictMcpByName('edit-flow');
  });

  it('编辑定义 + 驱逐后，callMcpTool 重建握手携带新 Authorization', async () => {
    const stub = stubRemoteFetch();
    try {
      registerMcpDefinition({
        id: 'f1',
        name: 'edit-flow',
        version: '1.0.0',
        transport: 'streamable_http',
        command: '',
        args: [],
        url: 'https://edit-flow.test/mcp',
        headers: { Authorization: 'Bearer old' },
        source: 'custom',
      });
      const cfg = getMcpConfig('edit-flow');
      if (!cfg) throw new Error('注册后必须可读');
      // 初次建立（旧 key 握手）
      await getOrStartMcp('ws-flow', cfg);
      expect(stub.authSeen).toEqual(['Bearer old']);

      // 编辑定义（换 key）+ 驱逐旧连接
      updateRemoteMcpDefinition('edit-flow', 'https://edit-flow.test/mcp', {
        Authorization: 'Bearer new',
      });
      await evictMcpByName('edit-flow');

      // 下回合 callMcpTool 经池重建 → 握手用的是库里的新 key
      const outcome = await callMcpTool('ws-flow', 'edit-flow', 'op', {});
      expect(outcome).toEqual({ text: 'ok-rebuilt', isError: false });
      expect(stub.authSeen).toEqual(['Bearer old', 'Bearer new']);
    } finally {
      stub.restore();
    }
  });
});
