// electron/tests/marketplace/reinstall-cascade.test.ts
//
// P2-4（M2.2 Task 4 / M2 D3 验收「重装后成员不悬空」）回归锁：同 slug 重装
// （hub 更新语义 = 同 slug 新版本走 installPackage）的级联语义。
//
// 锁定四条：
//   1) 同 slug 重装：def 行复用既有 id 原地升版，成员行**不被静默清除**且零悬空
//      （旧行为根因：saveAgentDefinition 的 INSERT OR REPLACE 触发
//      workspace_agent_members → agent_definitions 的 FK ON DELETE CASCADE）
//   2) agent_definitions 同 slug 异源行（custom / builtin）不被安装链劫持覆写
//      ——安装另起新行，异源行与其成员引用原样保留
//   3) marketplace 血缘（marketplace 目录 / hub 记账 / catalog 自愈同落
//      source='marketplace'）重装 = 原地升版（行不删、id 不换）
//   4) 同版本重装幂等跳过（.installed 标记短路，注册链不重跑）
// 错误路径：重装失败（checksum 不符）→ def 行与成员行均不受影响。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { installPackage } from '../../src/main/marketplace/installer';
import { saveAgentDefinition, listAgentDefinitions } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mp-reinstall-cascade-${Date.now()}`);

function makeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'test-agent',
    type: 'agent',
    slug: 'test-agent',
    name: '测试 Agent',
    version: '1.0.0',
    author: 'tester',
    description: '一个测试用 agent',
    readme: '# 测试\n\n这是 readme。',
    tags: ['test'],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'community',
    downloadUrl: '',
    checksum: '',
    sizeBytes: 1,
    installCount: 0,
    ...overrides,
  };
}

/** 直插一条异源 def 行（builtin/custom）——绕开 createCustomDef 的 provider 依赖 */
function seedDef(over: Partial<AgentDefinition> & Pick<AgentDefinition, 'id' | 'slug' | 'source'>): void {
  const def: AgentDefinition = {
    name: over.name ?? over.slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: over.systemPrompt ?? `原始提示词-${over.source}`,
    defaultTools: [],
    defaultMcps: [],
    defaultSkills: [],
    description: '',
    iconEmoji: '🤖',
    workspaceId: null,
    modelProviderId: null,
    modelName: '',
    ...over,
  };
  saveAgentDefinition(def);
}

/** 种子工作空间 + 成员行（引用指定 def id）——返回成员 instance_id */
function seedMember(wsId: string, defId: string, instanceId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'T', '/x', '@o')`,
  ).run(wsId);
  db.prepare(
    `INSERT INTO workspace_agent_members (workspace_id, instance_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(wsId, instanceId, defId, `@agent:${instanceId}`);
}

/** 悬空成员行计数（引用已不存在的 def id） */
function danglingMemberCount(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM workspace_agent_members wam
         LEFT JOIN agent_definitions d ON d.id = wam.agent_definition_id
         WHERE d.id IS NULL`,
      )
      .get() as { n: number }
  ).n;
}

function memberCountByDef(defId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM workspace_agent_members WHERE agent_definition_id = ?')
      .get(defId) as { n: number }
  ).n;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('P2-4 同 slug 重装级联语义', () => {
  it('同 slug 升版重装：def 复用既有 id 原地升版，成员行保留且零悬空', async () => {
    await installPackage(makeItem({ version: '1.0.0' }));
    const first = listAgentDefinitions().find((d) => d.slug === 'test-agent');
    expect(first).toBeDefined();
    expect(first!.source).toBe('marketplace');
    seedMember('ws1', first!.id, 'inst-1');

    // hub 更新语义：目录当前版本升到 1.1.0 → 重装（新版本目录，不走幂等短路）
    await installPackage(makeItem({ version: '1.1.0' }));

    const after = listAgentDefinitions().find((d) => d.slug === 'test-agent' && d.source === 'marketplace');
    // id 复用（不换 def id——重装链的更新语义）
    expect(after!.id).toBe(first!.id);
    expect(after!.version).toBe('1.1.0');
    // 成员行不被静默清除（P2-4 主断言），且全库零悬空
    expect(memberCountByDef(first!.id)).toBe(1);
    expect(danglingMemberCount()).toBe(0);
  });

  it('custom 同 slug 行不被安装链劫持：异源行与其成员引用原样保留', async () => {
    seedDef({ id: 'custom-1', slug: 'test-agent', source: 'custom', systemPrompt: '用户自己的提示词' });
    seedMember('ws1', 'custom-1', 'inst-custom');

    await installPackage(makeItem());

    const custom = listAgentDefinitions().find((d) => d.id === 'custom-1');
    expect(custom).toBeDefined();
    expect(custom!.source).toBe('custom');
    expect(custom!.systemPrompt).toBe('用户自己的提示词');
    // 安装另起新行（marketplace 血缘），不覆写 custom 行
    const installed = listAgentDefinitions().find((d) => d.slug === 'test-agent' && d.source === 'marketplace');
    expect(installed).toBeDefined();
    expect(installed!.id).not.toBe('custom-1');
    // custom 行的成员引用不受影响
    expect(memberCountByDef('custom-1')).toBe(1);
    expect(danglingMemberCount()).toBe(0);
  });

  it('builtin 同 slug 行不被劫持：安装链不得覆写 builtin 定义', async () => {
    seedDef({ id: 'builtin-test-agent', slug: 'test-agent', source: 'builtin' });

    await installPackage(makeItem());

    const builtin = listAgentDefinitions().find((d) => d.id === 'builtin-test-agent');
    expect(builtin).toBeDefined();
    expect(builtin!.source).toBe('builtin');
    const installed = listAgentDefinitions().find((d) => d.slug === 'test-agent' && d.source === 'marketplace');
    expect(installed).toBeDefined();
    expect(installed!.id).not.toBe('builtin-test-agent');
  });

  it('catalog 自愈血缘（marketplace 行）重装：复用 id 原地升版，行不删', async () => {
    // 模拟镜像目标节点 catalog 自愈装的行：installPackage 落的 marketplace def + 成员
    await installPackage(makeItem({ version: '2.0.0' }));
    const first = listAgentDefinitions().find((d) => d.slug === 'test-agent');
    seedMember('ws1', first!.id, 'inst-heal');

    // hub 补装升版（catalog 自愈与 hub 记账同落 marketplace 血源 = 更新语义）
    await installPackage(makeItem({ version: '2.1.0' }));

    const rows = listAgentDefinitions().filter((d) => d.slug === 'test-agent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.version).toBe('2.1.0');
    expect(memberCountByDef(first!.id)).toBe(1);
  });

  it('同版本重装幂等跳过：注册链不重跑，def/成员零变化', async () => {
    await installPackage(makeItem({ version: '1.0.0' }));
    const first = listAgentDefinitions().find((d) => d.slug === 'test-agent');
    seedMember('ws1', first!.id, 'inst-idem');

    await installPackage(makeItem({ version: '1.0.0' }));

    const rows = listAgentDefinitions().filter((d) => d.slug === 'test-agent');
    expect(rows).toHaveLength(1);
    expect(memberCountByDef(first!.id)).toBe(1);
  });

  it('错误路径：重装失败（checksum 不符）→ def 行与成员行不受影响', async () => {
    await installPackage(makeItem({ version: '1.0.0' }));
    const first = listAgentDefinitions().find((d) => d.slug === 'test-agent');
    seedMember('ws1', first!.id, 'inst-err');

    // 远程包 checksum 不符 → installPackage 抛错（注册链不可达）
    const bad = makeItem({
      version: '1.2.0',
      downloadUrl: 'https://example.com/pkg.tar.gz',
      checksum: 'deadbeef',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('tampered-content', { status: 200 }),
    );
    await expect(installPackage(bad)).rejects.toThrow(/Checksum/);
    fetchSpy.mockRestore();

    const after = listAgentDefinitions().find((d) => d.id === first!.id);
    expect(after).toBeDefined();
    expect(after!.version).toBe('1.0.0');
    expect(memberCountByDef(first!.id)).toBe(1);
    expect(danglingMemberCount()).toBe(0);
  });
});
