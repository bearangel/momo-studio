// electron/tests/agent/resource-ops.test.ts
//
// resource-ops 服务层单测（spec 2026-11-09-resource-creation-skills §5/§6）。
// DB 初始化沿用仓库既定模式（参考 crud-custom-def.test.ts / team-crud.test.ts）：
// AP_USER_DATA_DIR 指向临时目录 + runMigrations 全量迁移；成员夹具用真实 addMember
// 造（momo-test-rules：业务逻辑用真实实现，不 mock DB）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { addMember } from '../../src/main/agent/crud';
import { createProvider } from '../../src/main/agent/provider-crud';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import { executeResourceOp } from '../../src/main/agent/resource-ops';

// 与 crud-custom-def.test.ts 同款 mock：crud.ts 引入的 runtime 依赖在测试环境不可用
vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
}));

const tmpRoot = path.join(os.tmpdir(), `ap-resource-ops-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

// 种子夹具（beforeEach 重建——每用例全新库，用例间零串扰）
let wsId = '';
let m1 = '';
let m2 = '';
let defSlug = '';
// 供应商行（defaultChatModel 兜底的前提）；defaultChatModel 本身按用例需要再设
// （definition-default-model.test.ts 同款手法：不设 = 「未配置」路径）
let provId = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();

  // 外键依赖链：workspaces → agent_definitions → workspace_agent_members（team-crud 同款）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, '测试空间', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run('ws-r');
  const seedDef = db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name)
     VALUES (?, ?, ?, '1', 'p', 'm')`,
  );
  seedDef.run('def-a', '甲', 'agent-a');
  seedDef.run('def-b', '乙', 'agent-b');
  seedDef.run('def-c', '丙', 'agent-c');
  m1 = (await addMember('ws-r', 'def-a', 'agent-a-x')).instanceId;
  m2 = (await addMember('ws-r', 'def-b', 'agent-b-x')).instanceId;
  provId = (await createProvider({ name: 'GLM', baseUrl: 'https://example/v1', apiKey: 'k' })).id;
  wsId = 'ws-r';
  defSlug = 'agent-c';
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('resource-ops 分发', () => {
  it('未知 op 拒绝', async () => {
    await expect(executeResourceOp('rm -rf', {}, wsId)).rejects.toThrow('未知 resource op');
  });

  it('op 入参携带 workspaceId 被忽略（归属只由主进程注入）', async () => {
    // 先在真 wsId 建团队：入参 forged workspaceId 不影响——结果属于注入的 wsId
    await executeResourceOp(
      'createTeam',
      { name: '真空间团队', memberInstanceIds: [m1, m2], leaderInstanceId: m1 },
      wsId,
    );
    const r = (await executeResourceOp('list', { type: 'teams', workspaceId: 'forged' }, wsId)) as {
      teams: Array<{ name: string }>;
    };
    expect(r.teams).toHaveLength(1);
    expect(r.teams[0]!.name).toBe('真空间团队');
  });
});

describe('createTeam', () => {
  it('成员不足拒绝并透传 team.ts 事务错误', async () => {
    await expect(
      executeResourceOp('createTeam', { name: 'T', memberInstanceIds: [m1], leaderInstanceId: m1 }, wsId),
    ).rejects.toThrow('团队成员数至少 2');
  });

  it('成功返回 teamId 与成员数', async () => {
    const r = (await executeResourceOp(
      'createTeam',
      { name: '翻译组', memberInstanceIds: [m1, m2], leaderInstanceId: m1 },
      wsId,
    )) as { teamId: string; memberCount: number };
    expect(r.memberCount).toBe(2);
  });
});

describe('addMember（幂等）', () => {
  it('已加入返回既有成员不报错', async () => {
    const first = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    const second = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    expect((first as { instanceId: string }).instanceId).toBe(
      (second as { instanceId: string }).instanceId,
    );
  });

  it('slug 查不到报错并提示先 resource_list', async () => {
    await expect(
      executeResourceOp('addMember', { definitionIdOrSlug: 'no-such' }, wsId),
    ).rejects.toThrow('未找到 agent 定义');
  });
});

describe('createAgent', () => {
  const validYaml = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 翻译agent
  slug: translator
  version: 1.0.0
  description: 中英互译
spec:
  runtime: declarative
  declarative:
    systemPrompt: 你是翻译。
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:
    - kind: builtin
      ref: read_file
`;
  const yamlWithOtherSlug = validYaml.replace('slug: translator', 'slug: translator-2');

  it('非法 manifest 逐字段透出 parser 错误', async () => {
    await expect(
      executeResourceOp('createAgent', { manifestYaml: 'apiVersion: v9\nkind: X' }, wsId),
    ).rejects.toThrow('manifest 校验失败');
  });

  it('slug 与既有定义冲突拒绝并带既有信息', async () => {
    // 种子：先建 slug=translator 的定义（defaultChatModel 兜底供模型绑定）
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });
    await executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId);
    await expect(
      executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId),
    ).rejects.toThrow(/slug 已存在.*translator/);
  });

  it('全局无默认模型时报错指路设置', async () => {
    // 不设 defaultChatModel 且入参不带 modelProviderId → createCustomDef 兜底缺失
    await expect(
      executeResourceOp('createAgent', { manifestYaml: yamlWithOtherSlug }, wsId),
    ).rejects.toThrow('defaultChatModel');
  });

  it('addToWorkspace=true 返回成员 instanceId', async () => {
    updateGlobalSettings({ defaultChatModel: { providerId: provId, modelId: 'glm-5.3' } });
    const r = (await executeResourceOp(
      'createAgent',
      { manifestYaml: yamlWithOtherSlug, addToWorkspace: true },
      wsId,
    )) as { definitionId: string; member?: { instanceId: string } };
    expect(r.definitionId).toBeTruthy();
    expect(r.member?.instanceId).toBeTruthy();
  });
});
