// electron/tests/agent/crud-remove-mcp-refs.test.ts
//
// P2.2 Task 5：卸载级联清理（removeMcpRefsFromAgents）+ deleteRegistered
// 生产断面的级联挂载测试。覆盖面（brief Step 1 + 派单原则补充）：
//   - 级联主语义：两个 agent 引用同名 MCP → 两行 default_mcps 均剔除该 ref、
//     其他 ref 保留、返回被清理名单；无引用返回空数组且行不动（不写库）
//   - 断面挂载（真 DB 契约）：uninstallHubMcp（hub-install.ts:148 断面）/
//     uninstallMcpBundle（bundle-import.ts:569 断面）删行成功后各自调
//     removeMcpRefsFromAgents；resource:delete custom+mcp 直删断面
//     （ipc.handlers.ts:239）由 tests/resource/ipc-handlers.test.ts 锁
//   - 失败隔离原则（派单明示）：单行 update 失败不整体上抛——其余行照常清理、
//     返回名单只含成功者；agent 列表读取失败时卸载断面仍完成（级联降级）
//
// Mock 策略（铁律 5 收窄）：仅 mock agent/runtime-status + runtime-registry
// （切断 stream-relay → electron 的测试环境链，crud-update.test.ts 同款）；
// DB 全真（runMigrations 全量迁移 + 每用例重建临时目录）。故障注入全部用
// 真实 SQLite 手段——BEFORE UPDATE 触发器 RAISE(ABORT) 模拟单行 update
// 失败、坏 JSON 行触发 listAgentDefinitions 读取异常——零 mock 故障。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { registerMcpDefinition, getMcpConfig } from '../../src/main/mcp/host-manager';
import { uninstallHubMcp } from '../../src/main/resource/hub-install';
import { uninstallMcpBundle } from '../../src/main/mcp/bundle-import';
import {
  saveAgentDefinition,
  getAgentDefinition,
  removeMcpRefsFromAgents,
} from '../../src/main/agent/crud';
import type { AgentDefinition, McpRef } from '../../src/main/agent/types';

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-crud-rm-mcp-refs-${Date.now()}`);

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

// ─── 共用构造 ───────────────────────────────────────────────────────────────

function mcpRef(ref: string): McpRef {
  return { kind: 'mcp', ref };
}

/** 落一条引用给定 MCP 列表的 agent 定义（id 即 slug，保证唯一） */
function saveAgent(
  id: string,
  name: string,
  mcps: McpRef[],
  source: AgentDefinition['source'] = 'custom',
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

// ─── 级联主语义 ─────────────────────────────────────────────────────────────

describe('removeMcpRefsFromAgents 级联主语义', () => {
  it('两个 agent 引用同名 MCP：两行均剔除该 ref、其他 ref 保留、返回被清理名单', () => {
    saveAgent('def-a', '甲', [mcpRef('filesystem'), mcpRef('github')]);
    saveAgent('def-b', '乙', [mcpRef('filesystem')]);

    const cleaned = removeMcpRefsFromAgents('filesystem');

    // 返回名单与遍历顺序（source/created_at 排序）无契约绑定，按集合语义断言
    expect(cleaned).toHaveLength(2);
    expect(new Set(cleaned)).toEqual(new Set(['甲', '乙']));
    // 消费面断言（铁律 2）：行内真实 default_mcps——目标 ref 剔除、其他 ref 保留
    expect(getAgentDefinition('def-a')!.defaultMcps).toEqual([mcpRef('github')]);
    expect(getAgentDefinition('def-b')!.defaultMcps).toEqual([]);
  });

  it('无任何引用：返回空数组且行不动（不写库）', () => {
    saveAgent('def-solo', '独', [mcpRef('github')]);
    const before = getAgentDefinition('def-solo');

    const cleaned = removeMcpRefsFromAgents('filesystem');

    expect(cleaned).toEqual([]);
    expect(getAgentDefinition('def-solo')).toEqual(before);
  });

  it('单行 update 失败不整体上抛：触发器真实注入失败，其余行照常清理，返回名单只含成功者', () => {
    saveAgent('def-broken', '坏', [mcpRef('filesystem')]);
    saveAgent('def-okay', '好', [mcpRef('filesystem'), mcpRef('github')]);
    // 真实 SQLite 故障注入：仅 def-broken 行的 UPDATE 炸（RAISE(ABORT)）
    getDb().exec(
      `CREATE TRIGGER fail_broken_row BEFORE UPDATE ON agent_definitions
       WHEN NEW.id = 'def-broken'
       BEGIN SELECT RAISE(ABORT, '单行 update 失败'); END`,
    );

    const cleaned = removeMcpRefsFromAgents('filesystem');

    // 不上抛 + 失败行不计入名单
    expect(cleaned).toEqual(['好']);
    // 其余行照常清理（其他 ref 保留）
    expect(getAgentDefinition('def-okay')!.defaultMcps).toEqual([mcpRef('github')]);
    // 失败行保持原状（引用仍在，留给 dangling 扫描兜底）
    expect(getAgentDefinition('def-broken')!.defaultMcps).toEqual([mcpRef('filesystem')]);
  });
});

// ─── 断面级联挂载（真 DB 契约：删行成功后调 removeMcpRefsFromAgents） ────────

describe('卸载断面级联挂载', () => {
  it('uninstallHubMcp：mcp 行删除成功后级联清理 agent 引用', () => {
    registerMcpDefinition({
      id: 'hub-row-1',
      name: 'brave',
      version: '1.0.0',
      transport: 'streamable_http',
      url: 'https://brave.run.tools',
      command: '',
      args: [],
      source: 'smithery',
    });
    saveAgent('def-hub-user', 'hub 用户', [mcpRef('brave'), mcpRef('github')]);

    uninstallHubMcp('smithery', 'brave');

    expect(getMcpConfig('brave')).toBeNull();
    // 级联剔除目标 ref、保留其他 ref
    expect(getAgentDefinition('def-hub-user')!.defaultMcps).toEqual([mcpRef('github')]);
  });

  it('uninstallMcpBundle：bundle 记账行存在时删行成功后级联清理 agent 引用', () => {
    registerMcpDefinition({
      id: 'bundle-row-1',
      name: 'demo-bundle',
      version: '1.0.0',
      command: 'node',
      args: ['x.js'],
      source: 'custom',
    });
    // 直插 bundle 记账行（cache_path 空 = 无目录可清，聚焦级联语义）
    getDb()
      .prepare(
        `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
         VALUES ('ip-b1', 'bundle:demo-bundle', 'mcp', 'demo-bundle', '1.0.0', '', '')`,
      )
      .run();
    saveAgent('def-bundle-user', 'bundle 用户', [mcpRef('demo-bundle')]);

    uninstallMcpBundle('demo-bundle');

    expect(getMcpConfig('demo-bundle')).toBeNull();
    expect(getAgentDefinition('def-bundle-user')!.defaultMcps).toEqual([]);
  });

  it('agent 列表读取失败（坏 JSON 行真实注入）时 hub 卸载仍完成：级联降级不整体上抛', () => {
    registerMcpDefinition({
      id: 'hub-row-2',
      name: 'ghost-hub',
      version: '1.0.0',
      transport: 'streamable_http',
      url: 'https://ghost.run.tools',
      command: '',
      args: [],
      source: 'smithery',
    });
    saveAgent('def-bad-row', '坏行', [mcpRef('ghost-hub')]);
    // 坏 JSON 行 → listAgentDefinitions 在 rowToDef 的 JSON.parse 处真实抛错
    getDb()
      .prepare("UPDATE agent_definitions SET default_mcps = '{bad json' WHERE id = 'def-bad-row'")
      .run();

    // 删行已成功——级联读取失败只降级 warn，绝不让卸载整体失败
    expect(() => uninstallHubMcp('smithery', 'ghost-hub')).not.toThrow();
    expect(getMcpConfig('ghost-hub')).toBeNull();
  });
});
