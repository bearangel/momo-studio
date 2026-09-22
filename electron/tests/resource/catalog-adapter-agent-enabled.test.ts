// electron/tests/resource/catalog-adapter-agent-enabled.test.ts
//
// agentEnabled 标志（spec 2026-09-22 §6）：builtin agent 项按 agent_definitions
// 同 slug 匹配计算启用态；marketplace / 非 agent 项不带该字段。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { fromCatalogItem } from '../../src/main/resource/catalog-adapter';
import type { MarketplaceItem } from '../../src/main/marketplace/types';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-catalog-enabled-${Date.now()}`);

const AGENT_ITEM: MarketplaceItem = {
  id: 'agent-coder', type: 'agent', slug: 'coder', name: '程序员', version: '1.0.0',
  author: 'Momo Studio', description: '写代码', readme: '# coder', tags: [], category: 'dev',
  iconEmoji: '💻', verificationStatus: 'official', downloadUrl: '', checksum: '',
  sizeBytes: 1, installCount: 0,
};

const MCP_ITEM: MarketplaceItem = {
  ...AGENT_ITEM, id: 'mcp-foo', type: 'mcp', slug: 'foo-server', name: 'Foo MCP',
};

function mkDef(slug: string, source: AgentDefinition['source']): AgentDefinition {
  return {
    id: `def-${slug}`, name: slug, slug, version: '1.0.0', runtime: 'declarative',
    systemPrompt: 'p', defaultTools: [], source, description: '', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [], workspaceId: null,
    modelProviderId: 'p1', modelName: 'm1', thinkingJson: null,
  };
}

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

describe('fromCatalogItem — builtin agent 启用态', () => {
  it('def 不存在（未启用）→ agentEnabled=false', () => {
    const r = fromCatalogItem(AGENT_ITEM, 'builtin');
    expect(r.builtin?.agentEnabled).toBe(false);
  });

  it('同 slug def 存在（任意 source——marketplace 装过同口径复用）→ agentEnabled=true', () => {
    saveAgentDefinition(mkDef('coder', 'builtin'));
    const r = fromCatalogItem(AGENT_ITEM, 'builtin');
    expect(r.builtin?.agentEnabled).toBe(true);
  });

  it('同 slug marketplace-source def 存在 → 同样视为已启用（slug 口径不分 source）', () => {
    saveAgentDefinition(mkDef('coder', 'marketplace'));
    const r = fromCatalogItem(AGENT_ITEM, 'builtin');
    expect(r.builtin?.agentEnabled).toBe(true);
  });

  it('非 agent 类型 / marketplace source → 不带 agentEnabled 字段', () => {
    const mcp = fromCatalogItem(MCP_ITEM, 'builtin');
    expect(mcp.builtin?.agentEnabled).toBeUndefined();
    const market = fromCatalogItem(AGENT_ITEM, 'marketplace');
    expect(market.builtin).toBeUndefined();
  });
});
