// electron/tests/storage/memories/search.test.ts
// BM25 中文检索专项：偏好/研发规范/JWT 令牌/中英混排必命中；三层 scope 并集过滤。
// 夹具模式同 repo.test.ts（AP_USER_DATA_DIR 隔离）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { insertMemory } from '../../../src/main/storage/memories/repo';
import { searchMemories } from '../../../src/main/storage/memories/search';

const tmpRoot = path.join(os.tmpdir(), `ap-memsearch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const WS = 'ws1';
const OTHER = 'ws2';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  for (const ws of [WS, OTHER]) {
    db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'WS', '/tmp', '@owner:home')`).run(ws);
  }
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES ('s1', ?, 't', 0, 'chat', 1, 1)`,
  ).run(WS);

  insertMemory({ scope: 'global', kind: 'preference', content: '用户偏好简洁回答，不要长篇大论', source: 'user' });
  insertMemory({ scope: 'workspace', workspaceId: WS, kind: 'rule', content: '本工作空间研发规范：提交信息用中文', source: 'user' });
  insertMemory({ scope: 'workspace', workspaceId: WS, kind: 'knowledge', content: 'JWT 令牌过期需要刷新 refresh token', source: 'agent' });
  insertMemory({ scope: 'workspace', workspaceId: OTHER, kind: 'rule', content: '别的工作空间的研发规范', source: 'user' });
  insertMemory({ scope: 'session', workspaceId: WS, sessionId: 's1', kind: 'summary', content: '本会话目标：重构登录模块', source: 'auto' });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('searchMemories BM25 中文检索', () => {
  it('中文词命中：偏好', () => {
    const hits = searchMemories('偏好', { workspaceId: WS, sessionId: 's1' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('偏好');
  });

  it('中文词命中：研发规范（跨 ws 隔离——只命中本 ws）', () => {
    const hits = searchMemories('研发规范', { workspaceId: WS, sessionId: 's1' });
    expect(hits.some((m) => m.content.includes('本工作空间研发规范'))).toBe(true);
    expect(hits.some((m) => m.content.includes('别的'))).toBe(false);
  });

  it('中英混排命中：JWT 令牌', () => {
    const hits = searchMemories('JWT 令牌', { workspaceId: WS, sessionId: 's1' });
    expect(hits.some((m) => m.content.includes('refresh token'))).toBe(true);
  });

  it('session 层记忆纳入并集检索', () => {
    const hits = searchMemories('登录', { workspaceId: WS, sessionId: 's1' });
    expect(hits.some((m) => m.content.includes('重构登录模块'))).toBe(true);
  });

  it('sessionId 为 null 时不检索 session 层（子 agent 语义）', () => {
    const hits = searchMemories('登录', { workspaceId: WS, sessionId: null });
    expect(hits.some((m) => m.content.includes('重构登录模块'))).toBe(false);
  });

  it('空查询返回空数组；无命中返回空数组', () => {
    expect(searchMemories('   ', { workspaceId: WS, sessionId: 's1' })).toEqual([]);
    expect(searchMemories('不存在的词汇xyzq', { workspaceId: WS, sessionId: 's1' })).toEqual([]);
  });

  it('limit 生效（按 bm25 排序）', () => {
    const hits = searchMemories('规范', { workspaceId: WS, sessionId: 's1' }, 1);
    expect(hits).toHaveLength(1);
  });
});

describe('searchMemories scopeKind 单层收窄（P3 M-3 追加参数）', () => {
  // 「研发规范」只存在于 workspace 层夹具（本 ws + 其他 ws 各一条）——
  // 收窄到 global 后应 0 命中；若未收窄会命中 2 条，断言立即红
  it('scopeKind=global：三层并集收窄到全局层', () => {
    const hits = searchMemories('研发规范', { workspaceId: WS, sessionId: 's1' }, 10, { scopeKind: 'global' });
    expect(hits).toHaveLength(0);
  });

  it('scopeKind=workspace：只返回本 workspace 层条目', () => {
    const hits = searchMemories('研发规范', { workspaceId: WS, sessionId: 's1' }, 10, { scopeKind: 'workspace' });
    expect(hits.map((m) => m.content)).toEqual(['本工作空间研发规范：提交信息用中文']);
  });

  it('scopeKind=session：只返回会话层条目', () => {
    const hits = searchMemories('登录', { workspaceId: WS, sessionId: 's1' }, 10, { scopeKind: 'session' });
    expect(hits.some((m) => m.content.includes('重构登录模块'))).toBe(true);
    expect(hits.every((m) => m.scope === 'session')).toBe(true);
  });
});
