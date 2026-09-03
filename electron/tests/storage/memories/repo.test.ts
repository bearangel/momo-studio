// electron/tests/storage/memories/repo.test.ts
// repo CRUD + FTS 双写：主表与索引同事务，永不漂移（spec §6.1）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import {
  insertMemory, updateMemory, deleteMemory, getMemory, listMemories,
} from '../../../src/main/storage/memories/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-memrepo-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'WS', '/tmp', '@owner:home')`,
  ).run();
  getDb().prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES ('s1', 'ws1', 't', 0, 'chat', 1, 1)`,
  ).run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('memories repo', () => {
  it('insert：默认 pinned 按 kind 推导（rule/preference=1），FTS 行同步写入', () => {
    const rule = insertMemory({ scope: 'workspace', workspaceId: 'ws1', kind: 'rule', content: '使用 pnpm 研发规范', source: 'user' });
    expect(rule.pinned).toBe(true);
    expect(rule.tags).toEqual([]);
    const fts = getDb().prepare("SELECT content FROM memories_fts WHERE rowid = ?").get(rule.rowid) as { content: string };
    // FTS 存的是 jieba 分词后的空格串（同源）
    expect(fts.content).toContain('研发规范');
    expect(fts.content).toContain('pnpm');
  });

  it('insert：非法 scope 组合被 CHECK 拒绝（global 带 workspaceId）', () => {
    expect(() =>
      insertMemory({ scope: 'global', workspaceId: 'ws1', kind: 'rule', content: 'x', source: 'user' }),
    ).toThrow();
  });

  it('update：content/tags/pinned 更新后 FTS 行同步（旧词不再命中）', () => {
    const m = insertMemory({ scope: 'global', kind: 'knowledge', content: '旧内容 alpha', source: 'user' });
    updateMemory(m.id, { content: '新内容 beta', tags: ['deploy'] });
    const updated = getMemory(m.id)!;
    expect(updated.content).toBe('新内容 beta');
    expect(updated.tags).toEqual(['deploy']);
    const oldHit = getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'alpha'").all();
    const newHit = getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'beta'").all();
    expect(oldHit.length).toBe(0);
    expect(newHit.length).toBe(1);
  });

  it('delete：主表与 FTS 行同删', () => {
    const m = insertMemory({ scope: 'global', kind: 'knowledge', content: 'to be deleted gamma', source: 'user' });
    deleteMemory(m.id);
    expect(getMemory(m.id)).toBeNull();
    const hit = getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'gamma'").all();
    expect(hit.length).toBe(0);
  });

  it('list：按 scope 过滤 + filter（pinned/kind）', () => {
    insertMemory({ scope: 'global', kind: 'preference', content: '偏好简洁', source: 'user' });
    insertMemory({ scope: 'global', kind: 'knowledge', content: '知识条目', source: 'user' });
    insertMemory({ scope: 'workspace', workspaceId: 'ws1', kind: 'rule', content: 'ws 规范', source: 'user' });
    expect(listMemories({ kind: 'global' })).toHaveLength(2);
    expect(listMemories({ kind: 'global' }, { pinned: true })).toHaveLength(1); // 仅 preference 默认 pinned
    expect(listMemories({ kind: 'workspace', workspaceId: 'ws1' })).toHaveLength(1);
    expect(listMemories({ kind: 'session', sessionId: 's1' })).toHaveLength(0);
  });

  // Task 1 评审遗留覆盖：punct-merge 形态经插入 + FTS MATCH 端到端可检索
  it('标点合并形态经 FTS 端到端可检索（Task1 评审遗留覆盖）', () => {
    const m = insertMemory({ scope: 'global', kind: 'knowledge', content: '用户，偏好简洁', source: 'user' });
    // unicode61 在标点处重切：单词「用户」与全串短语都应命中
    const hitWord = getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '\"用户\"'").all();
    const hitPhrase = getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '\"用户，偏好简洁\"'").all();
    expect(hitWord.some((r) => (r as { rowid: number }).rowid === m.rowid)).toBe(true);
    expect(hitPhrase.some((r) => (r as { rowid: number }).rowid === m.rowid)).toBe(true);
  });
});