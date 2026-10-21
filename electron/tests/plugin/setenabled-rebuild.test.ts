// electron/tests/plugin/setenabled-rebuild.test.ts
//
// 启停即时生效（spec 2026-10-21 §7）：
//   ① 停用 → 该 ws lastRunning 成员 stop→start 重建（新装配）+ 该插件 MCP 池失效
//   ② 启用 → 同款重建（无池失效）
//   ③ 重建后新 opts.mcpNames 不含停用插件的 server 名（组合断言）
// mock 形态镜像 reload.test.ts（runtime-registry / spawn-hilters 隔离，锁调用形状）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const registryFns = vi.hoisted(() => ({
  startAgentRuntime: vi.fn(async () => undefined),
  stopAgentRuntime: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/agent/runtime-registry', () => registryFns);

const spawnFns = vi.hoisted(() => ({
  buildSpawnOpts: vi.fn(() => ({ instanceId: 'x', mcpNames: [] })),
  resolveApiKey: vi.fn(async () => 'k'),
}));
vi.mock('../../src/main/agent/spawn-helpers', () => spawnFns);

const hostFns = vi.hoisted(() => ({
  registerMcpDefinition: vi.fn(),
  invalidateMcpByName: vi.fn(),
}));
vi.mock('../../src/main/mcp/host-manager', () => hostFns);

const busFns = vi.hoisted(() => ({
  getPluginBus: vi.fn(() => ({ dispatch: vi.fn() })),
}));
vi.mock('../../src/main/plugin/bus-instance', () => busFns);

const hookFns = vi.hoisted(() => ({
  syncPluginHooks: vi.fn(),
  removePluginHooks: vi.fn(),
}));
vi.mock('../../src/main/plugin/hook-sync', () => hookFns);

const panelFns = vi.hoisted(() => ({
  notifyPanelsChanged: vi.fn(),
  listPluginPanels: vi.fn(() => []),
}));
vi.mock('../../src/main/plugin/panel-sync', () => panelFns);

import { registerPluginHandlers } from '../../src/main/plugin/ipc.handlers';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-seset-'));
const ipcHandlers = new Map<string, (evt: unknown, ...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (evt: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(ch, fn);
    },
  },
  app: { getPath: () => tmpRoot, getVersion: () => '2.1.0' },
}));

function seedAll(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp/x', '@o')`,
  ).run();
  const rec: PluginRecord = {
    id: 'cg',
    version: '1.0.0',
    manifestJson: JSON.stringify({ id: 'cg', name: 'cg', version: '1.0.0', description: '', components: {} }),
    state: 'active',
    source: 'dev',
    sourcePath: path.join(tmpRoot, 'cg'),
    installedAt: 'x',
  };
  fs.mkdirSync(rec.sourcePath ?? tmpRoot, { recursive: true });
  upsertPlugin(rec);
  setPluginEnabled('cg', 'ws1', true);
  // MCP 定义（plugin source）+ lastRunning 成员 + def
  db.prepare(
    `INSERT INTO mcp_definitions (id, name, version, command, args, transport, source, plugin_id)
     VALUES ('plugin-cg-cgx', 'cgx', '0.0.0', 'npx', '[]', 'stdio', 'plugin', 'cg')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES ('def1', 'T', 't', '1', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'pid', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running, created_at)
     VALUES ('inst1', 'ws1', 'def1', '@a:home', 1, datetime('now'))`,
  ).run();
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedAll();
  registryFns.stopAgentRuntime.mockClear();
  registryFns.startAgentRuntime.mockClear();
  hostFns.invalidateMcpByName.mockClear();
  registerPluginHandlers();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('plugin:setEnabled 即时生效（spec §7）', () => {
  it('停用 → 重建该 ws 成员 + 该插件 MCP 池失效', async () => {
    const h = ipcHandlers.get('plugin:setEnabled')!;
    await h({}, 'cg', 'ws1', false);
    await new Promise((r) => setTimeout(r, 20)); // rebuild fire-and-forget：flush 微任务
    expect(registryFns.stopAgentRuntime).toHaveBeenCalledWith('inst1');
    expect(registryFns.startAgentRuntime).toHaveBeenCalledTimes(1);
    expect(hostFns.invalidateMcpByName).toHaveBeenCalledWith('cgx');
  });

  it('启用 → 重建但无池失效', async () => {
    setPluginEnabled('cg', 'ws1', false);
    const h = ipcHandlers.get('plugin:setEnabled')!;
    await h({}, 'cg', 'ws1', true);
    await new Promise((r) => setTimeout(r, 20));
    expect(registryFns.startAgentRuntime).toHaveBeenCalledTimes(1);
    expect(hostFns.invalidateMcpByName).not.toHaveBeenCalled();
  });

  it('停用清池次序锁（终审 I-2 修复锁，spec §7.2）：stop 全部成员 → invalidate → start', async () => {
    const h = ipcHandlers.get('plugin:setEnabled')!;
    await h({}, 'cg', 'ws1', false);
    await new Promise((r) => setTimeout(r, 20));
    const stopOrder = registryFns.stopAgentRuntime.mock.invocationCallOrder[0]!;
    const invOrder = hostFns.invalidateMcpByName.mock.invocationCallOrder[0]!;
    const startOrder = registryFns.startAgentRuntime.mock.invocationCallOrder[0]!;
    // 旧 runtime 停机后无人能以其快照发起调用，此时失效池才不会按需复活（防残留进程）
    expect(stopOrder).toBeLessThan(invOrder);
    expect(invOrder).toBeLessThan(startOrder);
    // 启用方向不失效
    await h({}, 'cg', 'ws1', true);
    await new Promise((r) => setTimeout(r, 20));
    expect(hostFns.invalidateMcpByName).toHaveBeenCalledTimes(1);
  });
});
