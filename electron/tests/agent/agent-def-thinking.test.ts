// electron/tests/agent/agent-def-thinking.test.ts
//
// agent_definitions.thinking_json 读写往返 + undefined=不改 语义（migration v31）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createCustomDef, getAgentDefinition, updateAgentDefinition } from '../../src/main/agent/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-def-thinking-${Date.now()}-${process.pid}`);

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

describe('thinking_json 数据链', () => {
  it('createCustomDef 带 thinkingJson 落库并可读回', () => {
    const def = createCustomDef(null, {
      name: 'T', slug: 't', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-5.3',
      thinkingJson: { mode: 'on', effort: 'low' },
    });
    expect(def.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
  });

  it('缺省 thinkingJson → null（继承模型级）', () => {
    const def = createCustomDef(null, {
      name: 'T2', slug: 't2', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-4.6',
    });
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
  });

  it('updateAgentDefinition：undefined=不改；null=清除；传值=覆盖', () => {
    const def = createCustomDef(null, {
      name: 'T3', slug: 't3', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-5.3',
      thinkingJson: { mode: 'on', effort: 'low' },
    });
    updateAgentDefinition({ id: def.id, name: 'T3' });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
    updateAgentDefinition({ id: def.id, thinkingJson: null });
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
    updateAgentDefinition({ id: def.id, thinkingJson: { mode: 'off', effort: null } });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'off', effort: null });
  });

  it('DB 坏值（非法 JSON）读回 null 不炸', () => {
    const def = createCustomDef(null, {
      name: 'T4', slug: 't4', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-4.6',
    });
    getDb().prepare(
      `UPDATE agent_definitions SET thinking_json = '{bad' WHERE id = ?`,
    ).run(def.id);
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
  });
});
