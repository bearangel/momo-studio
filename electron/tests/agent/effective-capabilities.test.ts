// electron/tests/agent/effective-capabilities.test.ts
//
// 成员生效能力批量查询（spec 2026-10-22 §6.1）：展示 = 实际能用。
//
// 锁三件事：
//   1. 同源：产物与 mergeCapabilities(def, allocation, deltas) 直调深相等——
//      合并单点不漂移（若日后有人在本模块重实现合并逻辑，本用例立即红）。
//   2. 批量：多成员一次查询，各自按自身 def / 自身 workspace 分配层 / 自身 delta
//      合并（allocation 取成员所属 workspace，不用调用方上下文——P0-8 教训）。
//   3. 未知 instanceId：条目省略（非抛错、非空数组）——renderer 降级 def 级徽标。
//
// 夹具构造沿用 tests/agent/capability-merger-read.test.ts 的 DB 隔离模式 +
// capability-merger-layer3.test.ts 的 def/allocation/deltas 形态（同一套三层输入）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  mergeCapabilities,
  readAllocationLayer,
  readAssignmentDeltas,
} from '../../src/main/agent/capability-merger';
import { getAgentDefinition } from '../../src/main/agent/agent-queries';
import { addAllocation } from '../../src/main/workspace/allocation';
import { setAssignmentDeltas } from '../../src/main/agent/assignment-capabilities';
import { getEffectiveCapabilities } from '../../src/main/agent/effective-capabilities';

const tmpRoot = path.join(os.tmpdir(), `ap-effective-caps-test-${Date.now()}`);

const INST_A = 'inst-a';
const INST_B = 'inst-b';
const INST_C = 'inst-c';
const DEF_A = 'def-a';
const DEF_B = 'def-b';
const DEF_C = 'def-c';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  const db = getDb();
  // 外键链：workspaces → agent_definitions → workspace_agent_members
  for (const ws of ['ws-1', 'ws-2']) {
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ws, ws, '', '/tmp', 0, '@owner:s', '📁');
  }

  // Layer 1：agent 定义默认能力 + 定义级插件禁用基线（deniedTools）
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools,
        default_mcps, default_skills, denied_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEF_A, 'A', 'a', '1', 'declarative', 'p',
    JSON.stringify([{ kind: 'builtin', ref: 'read_file' }]),
    '[]', '[]', JSON.stringify(['plugin:cg/*']), 'custom', 'm',
  );
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools,
        default_mcps, default_skills, denied_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEF_B, 'B', 'b', '1', 'declarative', 'p',
    JSON.stringify([{ kind: 'builtin', ref: 'bash' }]),
    '[]', '[]', '[]', 'custom', 'm',
  );
  // def-c 的定义被删除（成员行仍在）——FK 若无 CASCADE 会拦，先建 def 后删
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools,
        default_mcps, default_skills, denied_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEF_C, 'C', 'c', '1', 'declarative', 'p',
    JSON.stringify([{ kind: 'builtin', ref: 'grep' }]),
    '[]', '[]', '[]', 'custom', 'm',
  );

  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(INST_A, 'ws-1', DEF_A, '@a:local');
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(INST_B, 'ws-1', DEF_B, '@b:local');
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(INST_C, 'ws-2', DEF_C, '@c:local');

  // Layer 2：workspace 级共享能力（ws-1 与 ws-2 内容不同——锁「按成员自身 workspace 取层」）
  addAllocation('ws-1', 'tool', 'bash');
  addAllocation('ws-1', 'skill', 'code-review');
  addAllocation('ws-2', 'tool', 'webfetch');

  // Layer 3：per-instance delta（仅 INST_A 有；INST_B 走无 delta 路径）
  setAssignmentDeltas(INST_A, {
    addedTools: ['webfetch'],
    removedTools: ['bash'],
    addedMcps: [],
    removedMcps: [],
    addedSkills: [],
    removedSkills: [],
    addedPluginTools: [],
    removedPluginTools: ['plugin:cg/explore'],
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('getEffectiveCapabilities 同源合并（与 spawn 同一 mergeCapabilities）', () => {
  it('批量产物与 mergeCapabilities 直调深相等（逐字段）', () => {
    const caps = getEffectiveCapabilities([INST_A, INST_B]);

    const defA = getAgentDefinition(DEF_A);
    const defB = getAgentDefinition(DEF_B);
    expect(defA).not.toBeNull();
    expect(defB).not.toBeNull();

    const expectedA = mergeCapabilities(defA!, readAllocationLayer('ws-1'), readAssignmentDeltas(INST_A));
    const expectedB = mergeCapabilities(defB!, readAllocationLayer('ws-1'), readAssignmentDeltas(INST_B));

    expect(caps[INST_A]).toEqual(expectedA);
    expect(caps[INST_B]).toEqual(expectedB);
    // 逐字段显式断言（防 toEqual 巧合通过）
    expect(caps[INST_A]!.tools).toEqual(expectedA.tools);
    expect(caps[INST_A]!.mcps).toEqual(expectedA.mcps);
    expect(caps[INST_A]!.skills).toEqual(expectedA.skills);
    expect(caps[INST_A]!.deniedTools).toEqual(expectedA.deniedTools);
  });

  it('INST_A 三层都参与：def 默认 ∪ ws 分配 ± 成员 delta', () => {
    const caps = getEffectiveCapabilities([INST_A]);
    // read_file 来自 def；bash 来自 ws 分配但被成员 delta 移除；webfetch 来自 delta added
    expect(caps[INST_A]!.tools).toEqual(['read_file', 'webfetch']);
    expect(caps[INST_A]!.skills).toEqual(['code-review']);
    // INST_B 无 delta：def 的 bash 保留（分配层并入）
    expect(caps[INST_A]!.mcps).toEqual([]);
  });

  it('无 delta 成员走 v1.5 路径（def ∪ alloc，deniedTools = def 级基线）', () => {
    const caps = getEffectiveCapabilities([INST_B]);
    expect(caps[INST_B]!.tools).toEqual(['bash']);
    expect(caps[INST_B]!.skills).toEqual(['code-review']);
    expect(caps[INST_B]!.deniedTools).toEqual([]);
  });

  it('分配层取成员自身 workspace（跨 workspace 不串层）', () => {
    const caps = getEffectiveCapabilities([INST_C]);
    // ws-2 的分配层只有 webfetch；ws-1 的 bash / code-review 不得渗入
    expect(caps[INST_C]!.tools).toEqual(['grep', 'webfetch']);
    expect(caps[INST_C]!.skills).toEqual([]);
  });
});

describe('getEffectiveCapabilities deniedTools 透传', () => {
  it('定义级基线 + 成员级追加禁用同源合并', () => {
    const caps = getEffectiveCapabilities([INST_A]);
    // def.deniedTools ['plugin:cg/*'] ∪ delta.removedPluginTools ['plugin:cg/explore']
    expect(caps[INST_A]!.deniedTools).toEqual(['plugin:cg/*', 'plugin:cg/explore']);
  });

  it('成员级 addedPluginTools 重新启用定义级禁用（同源保守语义）', () => {
    setAssignmentDeltas(INST_A, {
      addedTools: [], removedTools: [], addedMcps: [], removedMcps: [],
      addedSkills: [], removedSkills: [],
      addedPluginTools: ['plugin:cg/*'], removedPluginTools: [],
    });
    const caps = getEffectiveCapabilities([INST_A]);
    expect(caps[INST_A]!.deniedTools).toEqual([]);
  });
});

describe('getEffectiveCapabilities 省略语义（Task 13 renderer 降级消费）', () => {
  it('未知 instanceId → 条目省略（不抛错、不填空数组）', () => {
    const caps = getEffectiveCapabilities([INST_A, 'inst-unknown']);
    expect(caps['inst-unknown']).toBeUndefined();
    expect('inst-unknown' in caps).toBe(false);
    expect(caps[INST_A]).toBeDefined();
  });

  it('成员已移出（DB 无行）→ 条目省略', () => {
    getDb().prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run(INST_B);
    const caps = getEffectiveCapabilities([INST_B]);
    expect(caps[INST_B]).toBeUndefined();
    expect(Object.keys(caps)).toEqual([]);
  });

  it('成员行指向的定义缺失（INNER JOIN 脏数据防御分支）→ 条目省略', () => {
    // 制造「成员行指向的 def 读不到」：先去掉外键约束再删 def 行，模拟脏数据
    getDb().prepare('PRAGMA foreign_keys = OFF').run();
    getDb().prepare('DELETE FROM agent_definitions WHERE id = ?').run(DEF_C);
    const caps = getEffectiveCapabilities([INST_C]);
    expect(caps[INST_C]).toBeUndefined();
  });

  it('空数组入参 → 空结果对象（不抛错）', () => {
    expect(getEffectiveCapabilities([])).toEqual({});
  });

  it('全部未知 id → 空结果对象', () => {
    expect(getEffectiveCapabilities(['nope-1', 'nope-2'])).toEqual({});
  });

  it('重复 id 入参结果一致（幂等，后写覆盖同键）', () => {
    const once = getEffectiveCapabilities([INST_A]);
    const twice = getEffectiveCapabilities([INST_A, INST_A]);
    expect(twice[INST_A]).toEqual(once[INST_A]);
    expect(Object.keys(twice)).toEqual([INST_A]);
  });
});
