// electron/tests/agent/builtin.test.ts
//
// registerBuiltinAgents 单元测试（v1.3 schema）：
//   1. 从临时目录读取 YAML 并注册到 SQLite，source 标记为 builtin
//   2. 幂等：重复注册不生成新 id（builtin-${slug} 确定性命名）
//   3. 目录不存在时静默跳过（不抛错）
//   4. 单个 YAML 解析失败不阻断其余文件注册
//   5. type/parent/platform 入内存 suggestions Map，不进 DB
//   6. builtin def modelProviderId=NULL，modelName 来自 YAML

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import {
  registerBuiltinAgents,
  setBuiltinAgentsDir,
  getBuiltinSuggestionsMap,
  clearBuiltinSuggestionsForTest,
} from '../../src/main/agent/builtin';

const tmpRoot = path.join(os.tmpdir(), `ap-builtin-test-${Date.now()}`);

const VALID_YAML = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "你是需求分析师"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: read_file
`;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  clearBuiltinSuggestionsForTest();
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  clearBuiltinSuggestionsForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('agent/builtin — v1.3 schema', () => {
  it('从目录读取 YAML 并注册为 builtin agent', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();

    const defs = listAgentDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.slug).toBe('requirement-analyst');
    expect(defs[0]!.source).toBe('builtin');
    expect(defs[0]!.name).toBe('需求讨论师');
    // v1.3 新字段
    expect(defs[0]!.workspaceId).toBeNull(); // builtin 永远 global
    expect(defs[0]!.modelProviderId).toBeNull(); // builtin 待用户配置
    expect(defs[0]!.modelName).toBe('claude-3-5-sonnet');
    // 旧字段不存在
    const unknown = defs[0] as unknown as Record<string, unknown>;
    expect(unknown.type).toBeUndefined();
    expect(unknown.parentAgentId).toBeUndefined();
    expect(unknown.model).toBeUndefined();
  });

  it('幂等：重复注册复用确定性 id（builtin-${slug}）', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();
    const firstRun = listAgentDefinitions();
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]!.id).toBe('builtin-requirement-analyst');

    registerBuiltinAgents();
    const secondRun = listAgentDefinitions();
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]!.id).toBe('builtin-requirement-analyst');
  });

  it('目录不存在时静默跳过', () => {
    setBuiltinAgentsDir(path.join(tmpRoot, 'does-not-exist'));
    expect(() => registerBuiltinAgents()).not.toThrow();
    expect(listAgentDefinitions()).toHaveLength(0);
  });

  it('单个 YAML 解析失败不阻断其余文件', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'bad.yaml'), 'apiVersion: v9\n', 'utf-8');
    fs.writeFileSync(path.join(agentDir, 'good.yaml'), VALID_YAML, 'utf-8');
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();

    const defs = listAgentDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.slug).toBe('requirement-analyst');
  });
});

describe('agent/builtin — suggestions Map', () => {
  it('YAML 的 type/parent/platform 进 suggestions Map，不进 DB', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    // 文件顺序故意把 sub 放在 main 前面，验证不依赖文件顺序
    fs.writeFileSync(
      path.join(agentDir, 'a-sub.yaml'),
      `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 子
  slug: sub-x
  version: 1.0.0
spec:
  type: sub
  parentAgentId: main-x
  runtime: declarative
  declarative:
    systemPrompt: "子"
    model:
      provider: openai
      model: gpt-4o
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(agentDir, 'b-main.yaml'),
      `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 主
  slug: main-x
  version: 1.0.0
spec:
  type: main
  runtime: declarative
  declarative:
    systemPrompt: "主"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
`,
      'utf-8',
    );
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();

    // DB 无 type/parent/model.provider
    const defs = listAgentDefinitions();
    expect(defs).toHaveLength(2);
    for (const d of defs) {
      const unknown = d as unknown as Record<string, unknown>;
      expect(unknown.type).toBeUndefined();
      expect(unknown.parentAgentId).toBeUndefined();
    }

    // suggestions Map 含 type/parent/platform
    const map = getBuiltinSuggestionsMap();
    const mainEntry = map['builtin-main-x'];
    const subEntry = map['builtin-sub-x'];
    expect(mainEntry).toBeDefined();
    expect(mainEntry.role).toBe('main');
    expect(mainEntry.suggestedPlatform).toBe('anthropic');
    expect(subEntry).toBeDefined();
    expect(subEntry.role).toBe('sub');
    expect(subEntry.suggestedParentDefId).toBe('builtin-main-x');
    expect(subEntry.suggestedPlatform).toBe('openai');
  });

  it('sub 引用的父 slug 不存在时仍注册（suggestedParentDefId 解析失败保留 slug-derived id）', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'orphan-sub.yaml'),
      `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 孤儿子
  slug: orphan
  version: 1.0.0
spec:
  type: sub
  parentAgentId: missing-parent
  runtime: declarative
  declarative:
    systemPrompt: "x"
    model:
      provider: openai
      model: gpt-4o
`,
      'utf-8',
    );
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();

    const defs = listAgentDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('builtin-orphan');

    const map = getBuiltinSuggestionsMap();
    expect(map['builtin-orphan']).toBeDefined();
    expect(map['builtin-orphan'].role).toBe('sub');
    // 父 slug 解析为 `builtin-missing-parent`（即使该 def 不存在，仍保留作建议）
    expect(map['builtin-orphan'].suggestedParentDefId).toBe('builtin-missing-parent');
  });

  it('clearBuiltinSuggestionsForTest 清空 Map', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'r.yaml'), VALID_YAML, 'utf-8');
    setBuiltinAgentsDir(agentDir);
    registerBuiltinAgents();
    expect(Object.keys(getBuiltinSuggestionsMap())).toHaveLength(1);

    clearBuiltinSuggestionsForTest();
    expect(Object.keys(getBuiltinSuggestionsMap())).toHaveLength(0);
  });
});
