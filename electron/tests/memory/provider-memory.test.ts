// electron/tests/memory/provider-memory.test.ts
// MemoryProvider 扩展：getPinnedContext（开关 gate/分层组装/摘要注入/目录行/会话记忆段/
// 目录溢出计数/底层异常兜底）、saveMemory/deleteMemory/searchMemories（含 use_count 递增）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { __resetMemoryProviderForTest, getMemoryProvider } from '../../src/main/memory';
import { updateGlobalSettings, getGlobalSettings } from '../../src/main/settings/crud';
import { insertMemory } from '../../src/main/storage/memories/repo';
import { logger } from '../../src/main/logger';

const tmpRoot = path.join(os.tmpdir(), `ap-provmem-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
  __resetMemoryProviderForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('MemoryProvider v2.2 扩展', () => {
  const provider = getMemoryProvider();

  it('saveMemory：经 provider 落库（默认 pinned 按 kind 推导）', async () => {
    const saved = await provider.saveMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'rule',
      content: '使用语义 token', source: 'user',
    });
    expect(saved.pinned).toBe(true);
  });

  it('getPinnedContext：组装全局/项目常驻 + 会话摘要 + 目录行', async () => {
    insertMemory({ scope: 'global', kind: 'preference', content: '偏好中文回复', source: 'user' });
    insertMemory({ scope: 'workspace', workspaceId: 'ws1', kind: 'rule', content: 'pnpm 研发规范', source: 'user' });
    // 目录行预览截断验证：内容须超过 CATALOG_PREVIEW(30) 字，且截断标记（busy_timeout）须落在 30 字之后
    insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge',
      content: '踩坑：WAL 模式下多进程并发写同一 SQLite 数据库时必须设置足够的 busy_timeout',
      source: 'auto', confidence: 0.7,
    });
    getDb().prepare(
      `INSERT INTO session_summaries (session_id, summary, covered_until, updated_at) VALUES ('s1', '会话滚动摘要：已完成登录重构', 100, 1)`,
    ).run();

    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: 's1' });
    expect(view.hint).toContain('偏好中文回复');
    expect(view.hint).toContain('pnpm 研发规范');
    expect(view.hint).toContain('会话滚动摘要');
    // 检索型条目只进目录行（前 30 字），不占正文
    expect(view.hint).toContain('踩坑');
    expect(view.hint).not.toContain('busy_timeout');
  });

  it('getPinnedContext：总开关关闭 → 空 hint', async () => {
    updateGlobalSettings({ memoryEnabled: false });
    expect(getGlobalSettings().memoryEnabled).toBe(false);
    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: 's1' });
    expect(view.hint).toBe('');
    expect(view.truncatedCount).toBe(0);
  });

  it('getPinnedContext：sessionId=null（子 agent）不注入会话摘要', async () => {
    getDb().prepare(
      `INSERT INTO session_summaries (session_id, summary, covered_until, updated_at) VALUES ('s1', '摘要内容', 100, 1)`,
    ).run();
    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: null });
    expect(view.hint).not.toContain('摘要内容');
  });

  it('getPinnedContext：session 层 pinned 条目注入「### 会话记忆」段', async () => {
    const m = insertMemory({
      scope: 'session', workspaceId: 'ws1', sessionId: 's1', kind: 'rule',
      content: '会话常驻：回复必须带单元测试', source: 'user',
    });
    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: 's1' });
    expect(view.hint).toContain('### 会话记忆');
    expect(view.hint).toContain('会话常驻：回复必须带单元测试');
    expect(view.pinnedIds).toContain(m.id);
  });

  it('getPinnedContext：sessionId=null（子 agent）无「### 会话记忆」段', async () => {
    insertMemory({
      scope: 'session', workspaceId: 'ws1', sessionId: 's1', kind: 'rule',
      content: '会话常驻条目内容', source: 'user',
    });
    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: null });
    expect(view.hint).not.toContain('### 会话记忆');
    expect(view.hint).not.toContain('会话常驻条目内容');
  });

  it('getPinnedContext：目录超 30 条，溢出计入 truncatedCount', async () => {
    for (let i = 0; i < 12; i++) {
      insertMemory({ scope: 'global', kind: 'knowledge', content: `全局知识 ${String(i).padStart(2, '0')}`, source: 'auto', confidence: 0.7 });
    }
    for (let i = 0; i < 12; i++) {
      insertMemory({ scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge', content: `项目知识 ${String(i).padStart(2, '0')}`, source: 'auto', confidence: 0.7 });
    }
    for (let i = 0; i < 12; i++) {
      insertMemory({ scope: 'session', workspaceId: 'ws1', sessionId: 's1', kind: 'knowledge', content: `会话知识 ${String(i).padStart(2, '0')}`, source: 'auto', confidence: 0.7 });
    }
    const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: 's1' });
    // 36 条非 pinned 合并限量 30 → 溢出 6 条计入（无常驻条目、无摘要，不受其他截断干扰）
    expect(view.truncatedCount).toBe(6);
  });

  it('getPinnedContext：底层异常（memories 表缺失）→ 空视图且不 rethrow', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      // 真实错误路径（momo-test-rules：不用 mock 复制错误形状）——DROP 主表使 listMemories 抛 SqliteError
      getDb().exec('DROP TABLE memories');
      const view = await provider.getPinnedContext({ workspaceId: 'ws1', sessionId: 's1' });
      expect(view).toEqual({ hint: '', truncatedCount: 0, pinnedIds: [] });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('searchMemories：命中并递增 use_count', async () => {
    insertMemory({ scope: 'global', kind: 'knowledge', content: '部署用 docker compose', source: 'agent' });
    const before = getDb().prepare('SELECT use_count FROM memories').get() as { use_count: number };
    const hits = await provider.searchMemories('部署', { workspaceId: 'ws1', sessionId: null });
    expect(hits.length).toBeGreaterThan(0);
    const after = getDb().prepare('SELECT use_count FROM memories').get() as { use_count: number };
    expect(after.use_count).toBe(before.use_count + 1);
  });

  it('deleteMemory：删除后不可检索', async () => {
    const m = await provider.saveMemory({ scope: 'global', kind: 'knowledge', content: '待删除条目 zeta', source: 'user' });
    await provider.deleteMemory(m.id);
    const hits = await provider.searchMemories('zeta', { workspaceId: 'ws1', sessionId: null });
    expect(hits).toHaveLength(0);
  });

  it('getUserContext 真实化：返回全局 preference 内容', async () => {
    insertMemory({ scope: 'global', kind: 'preference', content: '回答用中文', source: 'user' });
    const ctx = await provider.getUserContext('owner');
    expect(ctx.preferences).toContain('回答用中文');
  });
});
