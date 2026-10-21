// electron/tests/plugin/reload.test.ts
//
// plugin:reload 重建链锁（spec §3.3）：重读 manifest → registry upsert →
// 声明式组件重激活 → 受影响 workspace 的 runtime stop→start。
// runtime-registry 以 vi.mock 隔离（重建链只锁调用形状——真实 spawn 集成面
// 由 T9 冒烟覆盖）。注意 GOOD_YAML 里 defaultTools 引 plugin:ok/explore 且
// tools 目录有 explore.js（满足步骤 5 交叉校验）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const registryFns = vi.hoisted(() => ({
  stopAgentRuntime: vi.fn(),
  startAgentRuntime: vi.fn(),
}));
vi.mock('../../src/main/agent/runtime-registry', () => registryFns);

const agentCrudFns = vi.hoisted(() => ({
  listAgentDefinitions: vi.fn(),
  listMembers: vi.fn(),
  getAgentDefinition: vi.fn(),
}));
vi.mock('../../src/main/agent/crud', () => ({
  ...agentCrudFns,
  saveAgentDefinition: vi.fn(),
  removeMcpRefsFromAgents: vi.fn(),
}));

const spawnFns = vi.hoisted(() => ({
  buildSpawnOpts: vi.fn(),
  resolveApiKey: vi.fn(),
}));
vi.mock('../../src/main/agent/spawn-helpers', () => spawnFns);

import { reloadPlugin } from '../../src/main/plugin/reload';
import { upsertPlugin, getPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-preload-'));

const GOOD_YAML = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: nav
  slug: nav
  version: 1.0.0
spec:
  declarative:
    systemPrompt: 你是导航员
    model:
      provider: openai
      model: gpt-4o
  defaultTools: []
  defaultSkills: []
`;

function mkDevPlugin(id: string, version: string): string {
  const dir = path.join(tmpRoot, `${id}-plugin`);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'explore.js'), 'module.exports.createTools = () => ({});');
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version,
      description: '',
      components: { tools: './tools' },
    }),
  );
  return dir;
}

function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'T', path.join(tmpRoot, id), '@owner:home');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  registryFns.stopAgentRuntime.mockReset();
  registryFns.startAgentRuntime.mockReset();
  agentCrudFns.listAgentDefinitions.mockReset().mockReturnValue([]);
  agentCrudFns.listMembers.mockReset().mockReturnValue([]);
  agentCrudFns.getAgentDefinition.mockReset().mockReturnValue(null);
  spawnFns.buildSpawnOpts.mockReset().mockResolvedValue({});
  spawnFns.resolveApiKey.mockReset().mockResolvedValue('sk-test');
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('reloadPlugin', () => {
  it('dev 源：重读源目录 manifest → 版本刷新 → 无启用 workspace 时不重建 runtime', async () => {
    seedWorkspace('ws1');
    const dir = mkDevPlugin('cg', '0.1.0');
    upsertPlugin({
      id: 'cg',
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(dir, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'dev',
      sourcePath: dir,
      installedAt: 'x',
    });
    setPluginEnabled('cg', 'ws1', true);
    // 禁用状态 → 无受影响 workspace（覆盖前注入的启用行）
    setPluginEnabled('cg', 'ws1', false);
    fs.writeFileSync(
      path.join(dir, 'momo-plugin.json'),
      fs.readFileSync(path.join(dir, 'momo-plugin.json'), 'utf-8').replace('0.1.0', '0.2.0'),
    );
    await reloadPlugin('cg');
    expect(getPlugin('cg')?.version).toBe('0.2.0');
    expect(registryFns.stopAgentRuntime).not.toHaveBeenCalled();
  });

  it('启用 workspace 存在 → 对该 workspace 的运行实例 stop→start（Review Focus #4）', async () => {
    seedWorkspace('ws1');
    const dir = mkDevPlugin('cg', '0.1.0');
    upsertPlugin({
      id: 'cg',
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(dir, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'dev',
      sourcePath: dir,
      installedAt: 'x',
    });
    setPluginEnabled('cg', 'ws1', true);
    agentCrudFns.listMembers.mockReturnValue([
      { instanceId: 'inst-1', agentDefinitionId: 'def-1', agentUserId: '@a:1', lastRunning: true },
    ]);
    agentCrudFns.getAgentDefinition.mockReturnValue({ modelProviderId: 'p1' });
    await reloadPlugin('cg');
    expect(registryFns.stopAgentRuntime).toHaveBeenCalledWith('inst-1');
    expect(registryFns.startAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it('插件不存在 → 中文错误', async () => {
    await expect(reloadPlugin('nope')).rejects.toThrow(/不存在/);
  });
});
