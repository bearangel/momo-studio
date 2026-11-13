// electron/tests/agent/builtin-resync.test.ts
//
// syncBuiltinPresetVersions 存量再同步测试（spec 2026-11-09 §8，P0 防线）：
//   1. 旧版本行（v2.0.0 存量 Momo）升级到 YAML 当前版本，用户已配模型三字段
//      + thinkingJson 原样保留（Review Focus #5）
//   2. 工具面与技能面同时到达——077 迁移只回填 default_tools，defaultSkills
//      与 systemPrompt 必须经本钩子到达存量行（携带路由项，防「只补单点」）
//   3. 成员关系保留（无 DELETE 的受控 upsert，不触发 workspace_agent_members
//      的 ON DELETE CASCADE）
//   4. 幂等：版本一致时零写入（total_changes 不增 + 行相等双锁）
//   5. 未启用的预置（无 DB 行）不受影响——按需启用语义不被启动钩子破坏
//
// 升级目标直读仓库真实 general-assistant.yaml（v2.3.0，72 工具 + 5 技能），
// 不在 tmp 沙盒伪造目标数据——与 builtin.test.ts 引用一致性锁同一数据源。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getAgentDefinition, saveAgentDefinition, addMember } from '../../src/main/agent/crud';
import {
  syncBuiltinPresetVersions,
  setBuiltinAgentsDir,
  readBuiltinManifestBySlug,
} from '../../src/main/agent/builtin';
import { createWorkspace } from '../../src/main/workspace/crud';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-builtin-resync-${Date.now()}`);

// 真身仓库资源目录（升级目标 YAML 的数据源，不进 tmp 沙盒；版本随仓库演进）
const AGENTS_DIR = path.resolve(__dirname, '../../resources/agents');

/**
 * 种子：模拟存量——v2.0.0 Momo 行 + 用户已配模型 + thinkingJson 覆盖 + 一个成员行。
 * defaultTools/defaultSkills/systemPrompt 刻意停在旧态（077 只回填 tools 且新库
 * no-op，真实存量行的 skills 与 prompt 正是靠本钩子补齐）。
 */
async function seedLegacyMomoRow(): Promise<void> {
  const { def: parsed } = readBuiltinManifestBySlug('general-assistant');
  const legacy: AgentDefinition = {
    ...parsed,
    id: 'builtin-general-assistant',
    version: '2.0.0',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    defaultSkills: [],
    // 用户配置的黑名单（终审 M3）：升级不得清空——YAML 无 deniedTools，须取行现值
    deniedTools: ['plugin:foo/*'],
    systemPrompt: '旧版 Momo 提示词（无资源创建段）',
    modelProviderId: 'user-provider',
    modelName: 'user-model',
    thinkingJson: { mode: 'off', effort: null },
    source: 'builtin',
  };
  saveAgentDefinition(legacy);
  const ws = await createWorkspace(
    { name: '测试 ws', directoryPath: path.join(tmpRoot, 'ws') },
    '@tester:localhost',
  );
  await addMember(ws.id, 'builtin-general-assistant', 'agent-momo-test');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  setBuiltinAgentsDir(AGENTS_DIR);
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('syncBuiltinPresetVersions', () => {
  it('旧版本行被升级且用户模型配置保留（Review Focus #5）', async () => {
    await seedLegacyMomoRow();

    syncBuiltinPresetVersions();

    const def = getAgentDefinition('builtin-general-assistant')!;
    expect(def.version).toBe('2.3.0');
    // 用户配置不被 YAML 覆盖（YAML 解析出的 provider/model 均为缺省值）
    expect(def.modelProviderId).toBe('user-provider');
    expect(def.modelName).toBe('user-model');
    expect(def.thinkingJson).toEqual({ mode: 'off', effort: null });
    // 工具面：六资源创建工具到达
    expect(def.defaultTools.map((t) => t.ref)).toContain('create_agent');
    // 携带路由项：技能面与提示词必须同批到达（077 单独只回填 tools）
    expect(def.defaultSkills.map((s) => s.ref)).toContain('build-team');
    expect(def.systemPrompt).toContain('资源创建');
    // deniedTools 原样保留（M3 回归锁：YAML 无此字段，同步取 DB 行现值）
    expect(def.deniedTools).toEqual(['plugin:foo/*']);
  });

  it('成员关系保留（无 DELETE 不触发 CASCADE）', async () => {
    await seedLegacyMomoRow();

    syncBuiltinPresetVersions();

    const rows = getDb()
      .prepare('SELECT * FROM workspace_agent_members WHERE agent_definition_id = ?')
      .all('builtin-general-assistant');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { agent_user_id: string }).agent_user_id).toBe('agent-momo-test');
  });

  it('幂等：版本一致时零写入', async () => {
    await seedLegacyMomoRow();
    syncBuiltinPresetVersions(); // 已升到 2.3.0

    const before = getDb()
      .prepare("SELECT * FROM agent_definitions WHERE id = 'builtin-general-assistant'")
      .get();
    const changesBefore = getDb().prepare('SELECT total_changes() AS n').get() as { n: number };

    syncBuiltinPresetVersions();

    const after = getDb()
      .prepare("SELECT * FROM agent_definitions WHERE id = 'builtin-general-assistant'")
      .get();
    const changesAfter = getDb().prepare('SELECT total_changes() AS n').get() as { n: number };
    expect(after).toEqual(before);
    // 双锁：不只结果相等，且本次调用确实零写入（版本比较命中跳过分支）
    expect(changesAfter.n).toBe(changesBefore.n);
  });

  it('未启用的预置（无 DB 行）不受影响：不炸也不凭空建行', () => {
    expect(() => syncBuiltinPresetVersions()).not.toThrow();
    // 按需启用语义：启动钩子不得为未启用预置创建 def 行
    expect(getAgentDefinition('builtin-general-assistant')).toBeNull();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_definitions').get()).toEqual({ n: 0 });
  });
});
