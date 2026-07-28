// electron/tests/agent/builtin.test.ts
//
// registerBuiltinAgents 单元测试：
//   1. 从临时目录读取 YAML 并注册到 SQLite，source 标记为 builtin
//   2. 幂等：重复注册不生成新 id（复用已有记录的 id）
//   3. 目录不存在时静默跳过（不抛错）
//   4. 单个 YAML 解析失败不阻断其余文件注册

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { listAgentDefinitions } from '../../src/main/agent/crud';
import { registerBuiltinAgents, setBuiltinAgentsDir } from '../../src/main/agent/builtin';

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
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('agent/builtin', () => {
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
  });

  it('幂等：重复注册复用已有 id', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
    setBuiltinAgentsDir(agentDir);

    registerBuiltinAgents();
    const firstRun = listAgentDefinitions();
    expect(firstRun).toHaveLength(1);
    const firstId = firstRun[0]!.id;

    registerBuiltinAgents();
    const secondRun = listAgentDefinitions();
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]!.id).toBe(firstId);
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

  it('两阶段注册：sub 的 parentAgentId slug 被解析为父 agent 的实际 id', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    // 文件顺序故意把 sub 放在 main 前面，验证两阶段不依赖文件顺序
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

    const defs = listAgentDefinitions();
    expect(defs).toHaveLength(2);
    const main = defs.find((d) => d.slug === 'main-x')!;
    const sub = defs.find((d) => d.slug === 'sub-x')!;
    expect(main).toBeDefined();
    expect(sub).toBeDefined();
    // sub 的 parentAgentId 已从 slug "main-x" 解析为父 agent 的真实 UUID
    expect(sub.parentAgentId).toBe(main.id);
    expect(sub.type).toBe('sub');
  });

  it('sub 引用的父 slug 不存在时仍注册（parentAgentId 回退为 undefined）', () => {
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
    // 父 slug 解析失败，parentAgentId 回退为 undefined（不阻塞注册）
    expect(defs[0]!.parentAgentId).toBeUndefined();
  });
});
