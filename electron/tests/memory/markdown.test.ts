// electron/tests/memory/markdown.test.ts
// 记忆导出/导入 Markdown（v2.2 P3 Task 2，spec §7.2/§10）：
//   - 导出格式：标题行（# 记忆导出（层名））+ 日期行 + 逐条 `## [kind|source|pinned] content` + `- tag` 行
//   - export→import 同库往返：content/kind/tags/pinned 复原；source 固定变 'user'
//   - 坏段（非法 kind / 无方括号头 / 空正文）计入 skipped；preamble 不计
//   - 同 scope 去重：重复导入 imported=0；跨 scope 导入不受既有层干扰
//   - session scope 拒绝导入；空内容 / 无段内容返回全零
// 真实 DB（迁移 + repo/search 直用），不经手写中间数据（momo-test-rules 第 4 条契约测试）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertMemory, listMemories } from '../../src/main/storage/memories/repo';
import {
  exportMemoriesMarkdown,
  importMemoriesMarkdown,
} from '../../src/main/storage/memories/markdown';

const tmpRoot = path.join(os.tmpdir(), `ap-mem-md-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

describe('exportMemoriesMarkdown 导出格式', () => {
  it('全局层：标题 + 日期 + 条目段 + tag 行；filename 带层与时间戳', () => {
    insertMemory({
      scope: 'global', kind: 'rule', content: '使用 pnpm 管理依赖', tags: ['规范', '工具链'], source: 'user',
    });
    insertMemory({
      scope: 'global', kind: 'knowledge', content: 'WAL 模式并发写需要 busy_timeout', source: 'auto', confidence: 0.7,
    });

    const { filename, content } = exportMemoriesMarkdown({ kind: 'global' });

    expect(filename).toMatch(/^momo-memory-global-\d{8}-\d{4}\.md$/);
    const lines = content.split('\n');
    expect(lines[0]).toBe('# 记忆导出（全局）');
    // 第二行为导出日期（YYYY-MM-DD HH:mm）
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(content).toContain('## [rule|user|pinned] 使用 pnpm 管理依赖');
    expect(content).toContain('- 规范');
    expect(content).toContain('- 工具链');
    expect(content).toContain('## [knowledge|auto|unpinned] WAL 模式并发写需要 busy_timeout');
  });

  it('工作空间层：层名与 filename 切换', () => {
    insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'preference', content: '偏好中文回复', source: 'user',
    });
    const { filename, content } = exportMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' });
    expect(content.split('\n')[0]).toBe('# 记忆导出（工作空间）');
    expect(content).toContain('## [preference|user|pinned] 偏好中文回复');
    expect(filename).toMatch(/^momo-memory-workspace-\d{8}-\d{4}\.md$/);
  });

  it('空列表：仍产出标题 + 日期（可再导入，全零）', () => {
    const { content } = exportMemoriesMarkdown({ kind: 'global' });
    expect(content.split('\n')[0]).toBe('# 记忆导出（全局）');
    expect(importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, content))
      .toEqual({ imported: 0, skipped: 0 });
  });
});

describe('importMemoriesMarkdown 导入', () => {
  it('export→import 同库往返：content/kind/tags/pinned 复原，source 固定 user', () => {
    // 覆盖三维变化：kind（rule/knowledge/summary）、pinned（含 kind 推导外的显式置顶）、tags 有无
    insertMemory({
      scope: 'global', kind: 'rule', content: '使用 pnpm 管理依赖', tags: ['规范', '工具链'], source: 'user',
    });
    insertMemory({
      // knowledge 默认非常驻——显式 pinned=true 验证 pinned 位真实往返（不按 kind 重推导）
      scope: 'global', kind: 'knowledge', content: 'WAL 模式并发写需要 busy_timeout', pinned: true, source: 'agent',
    });
    insertMemory({
      scope: 'global', kind: 'summary', content: '会话已完成登录模块重构', source: 'auto',
    });

    const { content } = exportMemoriesMarkdown({ kind: 'global' });
    const res = importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, content);
    expect(res).toEqual({ imported: 3, skipped: 0 });

    const restored = listMemories({ kind: 'workspace', workspaceId: 'ws1' });
    expect(restored).toHaveLength(3);
    const byContent = new Map(restored.map((e) => [e.content, e]));
    const e1 = byContent.get('使用 pnpm 管理依赖')!;
    expect(e1.kind).toBe('rule');
    expect(e1.tags).toEqual(['规范', '工具链']);
    expect(e1.pinned).toBe(true);
    expect(e1.source).toBe('user');
    const e2 = byContent.get('WAL 模式并发写需要 busy_timeout')!;
    expect(e2.kind).toBe('knowledge');
    expect(e2.pinned).toBe(true);
    expect(e2.source).toBe('user');
    const e3 = byContent.get('会话已完成登录模块重构')!;
    expect(e3.kind).toBe('summary');
    expect(e3.pinned).toBe(false);
    expect(e3.source).toBe('user');
    // 全部落在目标 scope（workspace/ws1）
    expect(restored.every((e) => e.scope === 'workspace' && e.workspaceId === 'ws1')).toBe(true);
  });

  it('多行 content 往返保真（段正文行合并还原换行）', () => {
    insertMemory({
      scope: 'global', kind: 'rule', content: '第一行规范\n第二行补充说明', source: 'user',
    });
    const { content } = exportMemoriesMarkdown({ kind: 'global' });
    const res = importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, content);
    expect(res).toEqual({ imported: 1, skipped: 0 });
    const restored = listMemories({ kind: 'workspace', workspaceId: 'ws1' });
    expect(restored[0]!.content).toBe('第一行规范\n第二行补充说明');
  });

  it('坏段计入 skipped，合法段照常导入', () => {
    const md = [
      '# 记忆导出（全局）',
      '2026-09-03 10:00',
      '',
      '## [rule|user|pinned] 合法条目一',
      '',
      '## [bad|user|pinned] 非法 kind 段',
      '',
      '## 无方括号头段',
      '',
      '## [rule|user|pinned] ',
      '',
      '## [knowledge|agent|unpinned] 合法条目二',
      '- 标签甲',
    ].join('\n');

    const res = importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, md);
    // 5 个 `## ` 段：2 合法 + 3 坏（非法 kind / 头解析失败 / 空正文）
    expect(res).toEqual({ imported: 2, skipped: 3 });

    const restored = listMemories({ kind: 'workspace', workspaceId: 'ws1' });
    expect(restored.map((e) => e.content).sort()).toEqual(['合法条目一', '合法条目二']);
    expect(restored.find((e) => e.content === '合法条目二')!.tags).toEqual(['标签甲']);
  });

  it('同 scope 去重：二次导入 imported=0 全 skipped，条目数不变', () => {
    insertMemory({
      scope: 'global', kind: 'rule', content: '使用 pnpm 管理依赖', tags: ['规范'], source: 'user',
    });
    insertMemory({
      scope: 'global', kind: 'preference', content: '偏好中文回复', source: 'user',
    });
    const { content } = exportMemoriesMarkdown({ kind: 'global' });

    const first = importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, content);
    expect(first).toEqual({ imported: 2, skipped: 0 });

    const second = importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, content);
    expect(second).toEqual({ imported: 0, skipped: 2 });
    expect(listMemories({ kind: 'workspace', workspaceId: 'ws1' })).toHaveLength(2);
  });

  it('去重命中 use_count 不变（无 touch 检索，不污染命中统计）', () => {
    importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, '## [rule|user|pinned] 使用 pnpm 管理依赖\n');
    const before = listMemories({ kind: 'workspace', workspaceId: 'ws1' })[0]!;
    expect(before.useCount).toBe(0);
    expect(before.lastUsedAt).toBeNull();

    // 第二次导入被去重跳过——期间不得递增 use_count/last_used_at
    importMemoriesMarkdown({ kind: 'workspace', workspaceId: 'ws1' }, '## [rule|user|pinned] 使用 pnpm 管理依赖\n');
    const after = listMemories({ kind: 'workspace', workspaceId: 'ws1' })[0]!;
    expect(after.useCount).toBe(0);
    expect(after.lastUsedAt).toBeNull();
  });

  it('session scope 拒绝导入（抛错，不落库）', () => {
    expect(() =>
      importMemoriesMarkdown({ kind: 'session', sessionId: 's1' }, '## [rule|user|pinned] 内容'),
    ).toThrow(/会话/);
    expect(listMemories({ kind: 'session', sessionId: 's1' })).toHaveLength(0);
  });

  it('空内容 / 无段内容返回全零', () => {
    expect(importMemoriesMarkdown({ kind: 'global' }, '')).toEqual({ imported: 0, skipped: 0 });
    expect(importMemoriesMarkdown({ kind: 'global' }, '# 记忆导出（全局）\n2026-09-03 10:00\n'))
      .toEqual({ imported: 0, skipped: 0 });
  });
});
