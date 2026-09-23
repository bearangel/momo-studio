// electron/tests/resource/mcp-config.test.ts
//
// P2.2 Task 4：resource 层编辑服务（getMcpConfigView 三级降级 +
// updateRemoteMcpConfig）测试。覆盖面（brief Step 1）：
//   - 三级降级：① 库存 schema 命中（bare=false + values 回显：header 字段读
//     headers、query 字段从 url ?k=v decode 反解）② smithery 空 schema 行 →
//     fetchSmitheryDetail 拉取 + 回写 DB（二次调用不再 fetch）③ fetch 失败 →
//     裸模式（url/headers 原样 + values 空）④ 非 smithery 远程 → 直接裸模式
//     不 fetch；边界：fetch 成功但 schema 空对象 → 仍降级裸模式
//   - update：schema 模式 compose 重组（query 进 url / header 进 headers /
//     trim 空串剔除）+ 裸模式 headers 整包直写 + input.schema 透传落库 +
//     evictMcpByName 被调
//   - 错误路径专项（momo-test-rules 铁律 3）：名字不存在 / stdio 条目 /
//     非 https url——中文错误上抛且行不动；fetch 非 2xx 抛错 → warn + 裸模式
//   - 集成锁（承 Task 3 host-manager-edit.test.ts 手法）：编辑 → 驱逐 →
//     callMcpTool 重建握手携带新 Authorization（编辑即时生效闭环）
//   - P2.2 Task 5 追加：listDanglingMcpRefs 悬空扫描——未注册名聚合 /
//     已注册不列 / 同 def 重复引用去重 / 扫描异常（坏 JSON 行）降级空数组
//
// Mock 策略（铁律 5 收窄）：仅模块级 mock fetchSmitheryDetail（网络边界，
// spread 实际模块保 composeRemoteConfig 等真实现）；evictMcpByName 包
// vi.fn(真实实现)——行为不变，仅供「被调」断言；DB 全真（runMigrations 全量
// 迁移）。集成锁的真实连接经 globalThis.fetch stub（HttpMcpClient 网络边界）。
//
// DB 隔离沿用仓库既定模式（照抄 host-manager-edit.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations() 经 getDb() 单例建表
//   - closeDb() 在 afterEach 复位单例并删临时目录

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
  evictMcpByName,
} from '../../src/main/mcp/host-manager';
import { fetchSmitheryDetail } from '../../src/main/resource/hub-install';
import {
  getMcpConfigView,
  updateRemoteMcpConfig,
  listDanglingMcpRefs,
} from '../../src/main/resource/mcp-config';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { logger } from '../../src/main/logger';
import type { McpServerConfig } from '../../src/main/mcp/types';
import type { McpRef } from '../../src/main/agent/types';

// 模块级 mock：只盖 fetchSmitheryDetail（网络边界），其余导出（含
// composeRemoteConfig）走真实实现——编辑链的分流重组必须是真的。
vi.mock('../../src/main/resource/hub-install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/resource/hub-install')>()),
  fetchSmitheryDetail: vi.fn(),
}));

// evictMcpByName 包 vi.fn(真实实现)：驱逐行为全真（集成锁依赖），仅记录
// 调用事实供 update 断言（mcp-config 经同一模块实例拿到的是这个包装函数）。
vi.mock('../../src/main/mcp/host-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mcp/host-manager')>();
  return { ...actual, evictMcpByName: vi.fn(actual.evictMcpByName) };
});

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-config-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vi.mocked(fetchSmitheryDetail).mockReset();
  vi.mocked(evictMcpByName).mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 共用构造 ───────────────────────────────────────────────────────────────

/** Smithery 详情返回的实证形状 schema：header / query 双向 x-from（分流验证） */
const DETAIL_SCHEMA = {
  required: ['apiKey'],
  properties: {
    apiKey: { title: 'API Key', 'x-from': 'header' as const },
    projectId: { title: 'Project', 'x-from': 'query' as const },
  },
};

/** 远程 mcp_definitions 行构造（name 唯一 → id 唯一，铁律 1） */
function remoteRow(
  overrides: Partial<McpServerConfig> & { name: string },
): McpServerConfig {
  return {
    id: `cfg-${overrides.name}`,
    version: '1.0.0',
    transport: 'streamable_http',
    command: '',
    args: [],
    url: `https://${overrides.name}.test/mcp`,
    source: 'custom',
    ...overrides,
  };
}

/** 读 config_schema 原始列（回写断言用——绕过读取链的 '{}' → undefined 还原） */
function rawSchemaColumn(name: string): string {
  const row = getDb()
    .prepare('SELECT config_schema FROM mcp_definitions WHERE name = ?')
    .get(name) as { config_schema: string };
  return row.config_schema;
}

/**
 * HttpMcpClient 网络边界 stub（照抄 Task 3 集成锁手法）：覆盖 initialize /
 * notifications/initialized / tools/call 三个 JSON-RPC 方法，记录每次
 * initialize 请求携带的 Authorization 头——「编辑后重建用新 headers」依据。
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

// ─── getMcpConfigView：三级降级（spec §5.1） ────────────────────────────────

describe('getMcpConfigView 三级降级', () => {
  it('第一级：库存 schema 非空 → bare=false + values 回显（header 读 headers、query 从 url 反解 decode）', async () => {
    registerMcpDefinition(
      remoteRow({
        name: 'lv1-mcp',
        url: 'https://lv1.test/mcp?projectId=p%201%26x',
        headers: { apiKey: 'k1' },
        configSchema: DETAIL_SCHEMA,
      }),
    );

    const view = await getMcpConfigView('lv1-mcp');

    // 形状整体锁死（spec §4.1 七字段；schema 模式 headers 为空对象）
    expect(view).toEqual({
      name: 'lv1-mcp',
      transport: 'streamable_http',
      bare: false,
      schema: DETAIL_SCHEMA,
      values: { apiKey: 'k1', projectId: 'p 1&x' },
      url: 'https://lv1.test/mcp?projectId=p%201%26x',
      headers: {},
    });
    // 库存命中不发起网络
    expect(fetchSmitheryDetail).not.toHaveBeenCalled();
  });

  it('边界：schema 字段无现值（url 无该 query、headers 无该键）→ values 不含该键', async () => {
    registerMcpDefinition(
      remoteRow({ name: 'lv1-missing', headers: {}, configSchema: DETAIL_SCHEMA }),
    );

    const view = await getMcpConfigView('lv1-missing');

    expect(view.bare).toBe(false);
    expect(view.values).toEqual({});
  });

  it('第二级：smithery 空 schema → fetchSmitheryDetail 拉取 + 回写 DB，二次调用不再 fetch', async () => {
    vi.mocked(fetchSmitheryDetail).mockResolvedValue({
      connections: [{ configSchema: DETAIL_SCHEMA }],
    });
    registerMcpDefinition(
      remoteRow({
        name: 'lv2-mcp',
        source: 'smithery',
        url: 'https://lv2.test/mcp',
        headers: { apiKey: 'k1' },
      }),
    );

    const view = await getMcpConfigView('lv2-mcp');

    expect(fetchSmitheryDetail).toHaveBeenCalledTimes(1);
    expect(fetchSmitheryDetail).toHaveBeenCalledWith('lv2-mcp'); // slug = 注册名
    expect(view.bare).toBe(false);
    expect(view.schema).toEqual(DETAIL_SCHEMA);
    expect(view.values).toEqual({ apiKey: 'k1' });
    // 回写断言（原始列）：下次离线可用
    expect(JSON.parse(rawSchemaColumn('lv2-mcp'))).toEqual(DETAIL_SCHEMA);

    // 第二次调用走第一级（库存命中），不再 fetch
    const view2 = await getMcpConfigView('lv2-mcp');
    expect(fetchSmitheryDetail).toHaveBeenCalledTimes(1);
    expect(view2.bare).toBe(false);
  });

  it('第三级：fetch 抛错（非 2xx）→ bare=true + url/headers 原样 + values 空，不回写', async () => {
    vi
      .mocked(fetchSmitheryDetail)
      .mockRejectedValue(new Error('Smithery 详情获取失败：HTTP 503'));
    registerMcpDefinition(
      remoteRow({
        name: 'lv3-mcp',
        source: 'smithery',
        url: 'https://lv3.test/mcp',
        headers: { Authorization: 'Bearer t' },
      }),
    );

    const view = await getMcpConfigView('lv3-mcp');

    expect(view.bare).toBe(true);
    expect(view.schema).toBeUndefined();
    expect(view.values).toEqual({});
    expect(view.url).toBe('https://lv3.test/mcp');
    expect(view.headers).toEqual({ Authorization: 'Bearer t' });
    expect(fetchSmitheryDetail).toHaveBeenCalledTimes(1);
    // 拉取失败不产生半写状态：config_schema 仍为兜底 '{}'
    expect(rawSchemaColumn('lv3-mcp')).toBe('{}');
  });

  it('边界：fetch 成功但 connections[0].configSchema 为空对象 → 仍降级裸模式', async () => {
    vi.mocked(fetchSmitheryDetail).mockResolvedValue({
      connections: [{ configSchema: {} }],
    });
    registerMcpDefinition(
      remoteRow({ name: 'empty-schema', source: 'smithery', url: 'https://e.test/mcp' }),
    );

    const view = await getMcpConfigView('empty-schema');

    expect(view.bare).toBe(true);
    expect(view.values).toEqual({});
  });

  it('非 smithery 远程（custom）→ 直接裸模式，不发起 fetch', async () => {
    registerMcpDefinition(
      remoteRow({
        name: 'bare-custom',
        url: 'https://bare.test/mcp',
        headers: { Authorization: 'Bearer c' },
      }),
    );

    const view = await getMcpConfigView('bare-custom');

    expect(view.bare).toBe(true);
    expect(view.values).toEqual({});
    expect(view.url).toBe('https://bare.test/mcp');
    expect(view.headers).toEqual({ Authorization: 'Bearer c' });
    expect(fetchSmitheryDetail).not.toHaveBeenCalled();
  });

  it('错误路径：名字不存在 → 中文「未注册」', async () => {
    await expect(getMcpConfigView('ghost-mcp')).rejects.toThrow(/未注册/);
  });

  it('错误路径：stdio 条目 → 中文拒绝（仅远程可编辑）', async () => {
    registerMcpDefinition({
      id: 'stdio-view-1',
      name: 'stdio-view',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'mcp-server-fs'],
      source: 'custom',
    });

    await expect(getMcpConfigView('stdio-view')).rejects.toThrow(/不是远程条目/);
  });
});

// ─── updateRemoteMcpConfig（spec §5.2） ─────────────────────────────────────

describe('updateRemoteMcpConfig', () => {
  it('schema 模式：compose 重组（query 进 url、header 进 headers）+ evictMcpByName 被调', async () => {
    registerMcpDefinition(
      remoteRow({
        name: 'upd-schema',
        url: 'https://old.test/mcp',
        headers: { apiKey: 'old' },
        configSchema: DETAIL_SCHEMA,
      }),
    );

    await updateRemoteMcpConfig('upd-schema', {
      url: 'https://new.test/mcp',
      config: { apiKey: 'k2', projectId: 'p 2' },
    });

    // 消费面断言（读取链路 = Task 4 表单回填源）：query 字段 encode 进 url、
    // header 字段进 headers
    const cfg = getMcpConfig('upd-schema');
    expect(cfg?.url).toBe('https://new.test/mcp?projectId=p%202');
    expect(cfg?.headers).toEqual({ apiKey: 'k2' });
    expect(evictMcpByName).toHaveBeenCalledWith('upd-schema');
    // 库存 schema 命中 → 编辑全程无网络
    expect(fetchSmitheryDetail).not.toHaveBeenCalled();
  });

  it('schema 模式：config 值 trim 后空串剔除（可选字段留空不下发）', async () => {
    registerMcpDefinition(
      remoteRow({
        name: 'upd-trim',
        url: 'https://t.test/mcp',
        headers: { apiKey: 'old' },
        configSchema: DETAIL_SCHEMA,
      }),
    );

    await updateRemoteMcpConfig('upd-trim', {
      url: 'https://t.test/mcp',
      config: { apiKey: '   ', projectId: 'p1' },
    });

    const cfg = getMcpConfig('upd-trim');
    expect(cfg?.url).toBe('https://t.test/mcp?projectId=p1');
    expect(cfg?.headers).toEqual({});
  });

  it('smithery 空 schema 行：update 先 resolveSchema（fetch + 回写副作用）再走 schema 模式重组', async () => {
    vi.mocked(fetchSmitheryDetail).mockResolvedValue({
      connections: [{ configSchema: DETAIL_SCHEMA }],
    });
    registerMcpDefinition(
      remoteRow({
        name: 'upd-smithery',
        source: 'smithery',
        url: 'https://s.test/mcp',
        headers: { apiKey: 'old' },
      }),
    );

    await updateRemoteMcpConfig('upd-smithery', {
      url: 'https://s2.test/mcp',
      config: { apiKey: 'k9', projectId: 'p9' },
    });

    expect(fetchSmitheryDetail).toHaveBeenCalledWith('upd-smithery');
    const cfg = getMcpConfig('upd-smithery');
    expect(cfg?.url).toBe('https://s2.test/mcp?projectId=p9');
    expect(cfg?.headers).toEqual({ apiKey: 'k9' });
    // 回写副作用幂等可见：schema 已落库（input.schema 缺省不覆盖）
    expect(cfg?.configSchema).toEqual(DETAIL_SCHEMA);
  });

  it('裸模式：input.headers 整包覆盖 + url 直写（无 schema 分流）', async () => {
    registerMcpDefinition(
      remoteRow({
        name: 'upd-bare',
        url: 'https://b.test/mcp',
        headers: { Authorization: 'Bearer old', 'X-Legacy': 'x' },
      }),
    );

    await updateRemoteMcpConfig('upd-bare', {
      url: 'https://b2.test/mcp',
      config: {},
      headers: { Authorization: 'Bearer new' },
    });

    const cfg = getMcpConfig('upd-bare');
    expect(cfg?.url).toBe('https://b2.test/mcp');
    // 整包覆盖语义：旧键 X-Legacy 消失
    expect(cfg?.headers).toEqual({ Authorization: 'Bearer new' });
    expect(evictMcpByName).toHaveBeenCalledWith('upd-bare');
  });

  it('input.schema 透传落库（编辑期间拉到的新 schema 顺手保存，裸模式下同样生效）', async () => {
    registerMcpDefinition(remoteRow({ name: 'upd-passthru', url: 'https://p.test/mcp' }));
    const fresh = {
      properties: { apiKey: { title: 'Key', 'x-from': 'header' as const } },
    };

    await updateRemoteMcpConfig('upd-passthru', {
      url: 'https://p.test/mcp',
      config: {},
      schema: fresh,
    });

    expect(getMcpConfig('upd-passthru')?.configSchema).toEqual(fresh);
  });

  it('错误路径：名字不存在 → 中文「未注册」', async () => {
    await expect(
      updateRemoteMcpConfig('ghost-mcp', { url: 'https://g.test/mcp', config: {} }),
    ).rejects.toThrow(/未注册/);
  });

  it('错误路径：stdio 条目 → 中文拒绝且行不动', async () => {
    registerMcpDefinition({
      id: 'stdio-upd-1',
      name: 'stdio-upd',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'mcp-server-fs'],
      source: 'custom',
    });

    await expect(
      updateRemoteMcpConfig('stdio-upd', {
        url: 'https://x.test/mcp',
        config: {},
      }),
    ).rejects.toThrow(/不是远程条目/);
    const cfg = getMcpConfig('stdio-upd');
    expect(cfg?.transport).toBe('stdio');
    expect(cfg?.command).toBe('npx');
  });

  it('错误路径：非 https url → 中文拒绝且行不动（主进程双防线）', async () => {
    registerMcpDefinition(
      remoteRow({ name: 'https-guard', url: 'https://old.test/mcp' }),
    );

    await expect(
      updateRemoteMcpConfig('https-guard', {
        url: 'http://plain.test/mcp',
        config: {},
      }),
    ).rejects.toThrow(/https/);
    // 校验失败不得改写定义，也不产生网络副作用
    expect(getMcpConfig('https-guard')?.url).toBe('https://old.test/mcp');
    expect(fetchSmitheryDetail).not.toHaveBeenCalled();
  });
});

// ─── 集成锁：编辑生效闭环（update + evict + 重建，承 Task 3 手法） ──────────

describe('集成锁：编辑生效闭环', () => {
  afterEach(async () => {
    await evictMcpByName('lock-mcp');
  });

  it('updateRemoteMcpConfig 编辑 → 驱逐 → callMcpTool 重建握手携带新 Authorization', async () => {
    const stub = stubRemoteFetch();
    try {
      registerMcpDefinition(
        remoteRow({
          name: 'lock-mcp',
          url: 'https://lock.test/mcp',
          headers: { Authorization: 'Bearer old' },
          configSchema: {
            properties: {
              Authorization: { title: 'API Key', 'x-from': 'header' as const },
            },
          },
        }),
      );
      const cfg = getMcpConfig('lock-mcp');
      if (!cfg) throw new Error('注册后必须可读');

      // 初次建立（旧 key 握手）
      await getOrStartMcp('ws-lock', cfg);
      expect(stub.authSeen).toEqual(['Bearer old']);

      // 编辑定义（换 key）——update 内部完成 update + evict
      await updateRemoteMcpConfig('lock-mcp', {
        url: 'https://lock.test/mcp',
        config: { Authorization: 'Bearer new' },
      });

      // 下回合 callMcpTool 经池重建 → 握手用的是库里的新 key
      const outcome = await callMcpTool('ws-lock', 'lock-mcp', 'op', {});
      expect(outcome).toEqual({ text: 'ok-rebuilt', isError: false });
      expect(stub.authSeen).toEqual(['Bearer old', 'Bearer new']);
    } finally {
      stub.restore();
    }
  });
});

// ─── listDanglingMcpRefs：悬空引用扫描（P2.2 Task 5，spec §5.4） ────────────

describe('listDanglingMcpRefs 悬空引用扫描', () => {
  /** 落一条引用给定 MCP 列表的 agent 定义（id 即 slug，保证唯一） */
  function saveAgent(
    id: string,
    name: string,
    mcps: McpRef[],
    source: 'custom' | 'builtin' = 'custom',
  ): void {
    saveAgentDefinition({
      id,
      name,
      slug: id,
      version: '1.0',
      runtime: 'declarative',
      systemPrompt: 'p',
      defaultTools: [],
      source,
      description: 'd',
      iconEmoji: '🤖',
      defaultMcps: mcps,
      defaultSkills: [],
      workspaceId: null,
      modelProviderId: null,
      modelName: '',
    });
  }

  function mcpRef(ref: string): McpRef {
    return { kind: 'mcp', ref };
  }

  it('custom def 引用未注册名 → 按 refName 聚合 agent 名单（已启用 builtin 的 DB 行同样入扫）', () => {
    saveAgent('def-a', '甲', [mcpRef('filesystem')]);
    saveAgent('def-b', '乙', [mcpRef('filesystem')], 'builtin');
    saveAgent('def-c', '丙', [mcpRef('ghost-two')]);

    const refs = listDanglingMcpRefs();

    // 聚合形状（spec §4.3）：refName → agents[{definitionId, name}]
    const fsRef = refs.find((r) => r.refName === 'filesystem')!;
    expect([...fsRef.agents].sort((x, y) => x.definitionId.localeCompare(y.definitionId))).toEqual([
      { definitionId: 'def-a', name: '甲' },
      { definitionId: 'def-b', name: '乙' },
    ]);
    const ghostRef = refs.find((r) => r.refName === 'ghost-two')!;
    expect(ghostRef.agents).toEqual([{ definitionId: 'def-c', name: '丙' }]);
  });

  it('引用已注册 MCP 名 → 不列入悬空', () => {
    registerMcpDefinition({
      id: 'reg-fs-1',
      name: 'filesystem',
      version: '1.0.0',
      command: 'npx',
      args: ['-y', 'mcp-server-fs'],
      source: 'custom',
    });
    saveAgent('def-installed', '已装用户', [mcpRef('filesystem')]);

    const refs = listDanglingMcpRefs();

    expect(refs.find((r) => r.refName === 'filesystem')).toBeUndefined();
  });

  it('同 def 重复引用同名 MCP → agents 去重（该 def 只计一次）', () => {
    saveAgent('def-dup', '重复', [mcpRef('filesystem'), mcpRef('filesystem')]);

    const refs = listDanglingMcpRefs();

    const fsRef = refs.find((r) => r.refName === 'filesystem')!;
    expect(fsRef.agents).toEqual([{ definitionId: 'def-dup', name: '重复' }]);
  });

  it('扫描异常（坏 JSON 行真实注入）→ warn + 空数组（UI 卡片静默不显示）', () => {
    saveAgent('def-bad-json', '坏行', []);
    // 坏 JSON 行 → listAgentDefinitions 在 rowToDef 的 JSON.parse 处真实抛错
    getDb()
      .prepare("UPDATE agent_definitions SET default_mcps = '{bad json' WHERE id = 'def-bad-json'")
      .run();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(listDanglingMcpRefs()).toEqual([]);
      // 降级必须可观测（warn），否则脏数据被无声吞掉
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('悬空'), expect.anything());
    } finally {
      warnSpy.mockRestore();
    }
  });
});
