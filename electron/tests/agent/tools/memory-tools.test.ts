// electron/tests/agent/tools/memory-tools.test.ts
// v2.2 记忆 P2 Task 2：MemoryTools 三工具（memory_save / memory_search / memory_forget）。
// 覆盖（plan Task 2 TDD Step 1）：
//   - 三工具成功路径（真实 SQLite 夹具，AP_USER_DATA_DIR + runMigrations）
//   - user 条目拒删（用户主权：agent/auto 可删，user 条目返回错误说明）
//   - session scope 归属校验（无 roomId 拒绝写 session 层）
//   - 审计写入断言（拦截 process.send，断言 audit:toolCall 信封；仅写操作）
//   - 注册中心包含 memory_* defs（buildToolRegistry → getAllToolDefs）
//   - 错误路径专项（非法 kind / 空 content / 非法 scope / 空 query / 不存在 id）
// process.send 拦截采用属性替换 + 箭头函数（不依赖 this 绑定，momo-test-rules 陷阱规避）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { getMemory, insertMemory } from '../../../src/main/storage/memories/repo';
import { __resetMemoryProviderForTest } from '../../../src/main/memory';
import { MemoryTools } from '../../../src/main/agent/tools/memory-tools';
import { buildToolRegistry, getAllToolDefs } from '../../../src/main/agent/tools/index';
import type { ToolContext } from '../../../src/main/agent/tools/types';

/** 捕获的审计事件（shared/audit.ts ToolCallAudit 的 IPC 信封） */
type AuditMsg = { type: string; toolName: string; inputSummary: string; outputSummary: string; success: boolean };

const tmpRoot = path.join(os.tmpdir(), `ap-memtools-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const auditLogs: AuditMsg[] = [];
const originalSend = process.send;

let ctx: ToolContext;
let tools: MemoryTools;

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

  auditLogs.length = 0;
  process.send = ((msg: unknown): boolean => {
    const m = msg as AuditMsg | undefined;
    if (m && m.type === 'audit:toolCall') auditLogs.push(m);
    return true;
  }) as NonNullable<typeof process.send>;

  ctx = {
    wsFs: {} as never,
    workspaceId: 'ws1',
    workspaceDir: '/tmp',
    skillRegistry: {} as never,
    streamSessionId: 'ssn-agent-1',
    roomId: 's1',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
  };
  tools = new MemoryTools();
});

afterEach(() => {
  process.send = originalSend;
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 从 memory_save 返回文本中提取 id（格式：已保存记忆（id=<uuid>，kind=...，常驻=...）） */
function extractSavedId(result: string): string {
  const m = result.match(/id=([0-9a-f-]{36})/);
  if (!m) throw new Error(`返回文本中未找到 id: ${result}`);
  return m[1]!;
}

describe('memory_save', () => {
  it('成功：缺省 scope=workspace，source=agent，pinned 按 kind 推导，写审计', async () => {
    const result = await tools.execute(
      'memory_save',
      { kind: 'rule', content: '提交前必须跑 typecheck', tags: ['工程规范'] },
      ctx,
    );
    expect(result).toContain('已保存');
    expect(result).toContain('kind=rule');
    expect(result).toContain('常驻=是'); // rule 缺省常驻（repo 推导）

    const id = extractSavedId(result);
    const entry = getMemory(id);
    expect(entry).not.toBeNull();
    expect(entry!.scope).toBe('workspace');
    expect(entry!.workspaceId).toBe('ws1');
    expect(entry!.sessionId).toBeNull();
    expect(entry!.source).toBe('agent');
    // sourceDetail 取 ToolContext 现有 agent 标识（streamSessionId，实现注释有说明）
    expect(entry!.sourceDetail).toContain('ssn-agent-1');
    expect(entry!.tags).toEqual(['工程规范']);

    // 写操作审计：成功一条，工具名与成功标志正确
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]!.toolName).toBe('memory_save');
    expect(auditLogs[0]!.success).toBe(true);
  });

  it('成功：scope=global（跨工作空间共享）', async () => {
    const result = await tools.execute(
      'memory_save',
      { kind: 'preference', content: '用户偏好中文回复', scope: 'global' },
      ctx,
    );
    const entry = getMemory(extractSavedId(result));
    expect(entry!.scope).toBe('global');
    expect(entry!.workspaceId).toBeNull();
    expect(entry!.pinned).toBe(true); // preference 缺省常驻
  });

  it('成功：scope=session 归属本会话（sessionId=ctx.roomId）', async () => {
    const result = await tools.execute(
      'memory_save',
      { kind: 'knowledge', content: '本会话正在重构记忆模块' , scope: 'session' },
      ctx,
    );
    const entry = getMemory(extractSavedId(result));
    expect(entry!.scope).toBe('session');
    expect(entry!.sessionId).toBe('s1');
    expect(entry!.workspaceId).toBe('ws1');
    expect(entry!.pinned).toBe(false); // knowledge 缺省检索型
  });

  it('拒绝：scope=session 但无会话上下文（roomId 为空）', async () => {
    ctx.roomId = '';
    await expect(
      tools.execute('memory_save', { kind: 'knowledge', content: 'x', scope: 'session' }, ctx),
    ).rejects.toThrow(/会话/);
    // 未落库
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    expect(count).toBe(0);
    // 失败也写审计（success=false）
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]!.toolName).toBe('memory_save');
    expect(auditLogs[0]!.success).toBe(false);
  });

  it('拒绝：非法 kind / 空 content / 非法 scope（错误路径专项）', async () => {
    await expect(
      tools.execute('memory_save', { kind: 'bogus', content: 'x' }, ctx),
    ).rejects.toThrow(/kind/);
    await expect(
      tools.execute('memory_save', { kind: 'rule', content: '' }, ctx),
    ).rejects.toThrow(/content/);
    await expect(
      tools.execute('memory_save', { kind: 'rule', content: 'x', scope: 'everywhere' }, ctx),
    ).rejects.toThrow(/scope/);
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe('memory_search', () => {
  it('成功：BM25 命中返回 id/kind/前 120 字，use_count 自动递增', async () => {
    const longTail = '细节'.repeat(60) + '唯一尾巴标记'; // 5 + 120 = 前 125 字符之后才出现尾巴
    const wsEntry = insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge',
      content: '部署前必须先备份数据库' + longTail, source: 'auto', confidence: 0.7,
    });
    const result = await tools.execute('memory_search', { query: '部署' }, ctx);
    expect(result).toContain(wsEntry.id);
    expect(result).toContain('knowledge');
    expect(result).toContain('部署前必须先备份数据库');
    // 前 120 字截断：尾巴标记不可见
    expect(result).not.toContain('唯一尾巴标记');
    // provider.searchMemories 契约：命中条目 use_count +1
    expect(getMemory(wsEntry.id)!.useCount).toBe(1);
    // 读操作不做模块级审计（生产链路由 runtime-entry 统一审计）
    expect(auditLogs).toHaveLength(0);
  });

  it('成功：scope 过滤（scope=global 只返回全局条目）', async () => {
    const globalEntry = insertMemory({
      scope: 'global', kind: 'knowledge', content: '全局部署规范', source: 'auto',
    });
    const wsEntry = insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge', content: '项目部署规范', source: 'auto',
    });
    const result = await tools.execute('memory_search', { query: '部署', scope: 'global' }, ctx);
    expect(result).toContain(globalEntry.id);
    expect(result).not.toContain(wsEntry.id);
  });

  it('子 agent（parentStreamSessionId 非空）不检索 session 层记忆', async () => {
    const sessionEntry = insertMemory({
      scope: 'session', workspaceId: 'ws1', sessionId: 's1', kind: 'knowledge',
      content: '会话内的部署注意事项', source: 'agent',
    });
    ctx.parentStreamSessionId = 'pm-stream-1';
    const result = await tools.execute('memory_search', { query: '部署' }, ctx);
    expect(result).not.toContain(sessionEntry.id);
  });

  it('无命中：返回无命中提示', async () => {
    insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge', content: '完全不相关的内容甲乙丙', source: 'auto',
    });
    const result = await tools.execute('memory_search', { query: '部署备份' }, ctx);
    expect(result).toContain('无命中');
  });

  it('拒绝：空 query（错误路径专项）', async () => {
    await expect(
      tools.execute('memory_search', { query: '' }, ctx),
    ).rejects.toThrow(/query/);
  });
});

describe('memory_forget', () => {
  it('成功：agent 来源条目可删，写审计', async () => {
    const entry = insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge',
      content: '过时的架构知识', source: 'agent', sourceDetail: 'agent:ssn-old',
    });
    const result = await tools.execute('memory_forget', { id: entry.id }, ctx);
    expect(result).toContain('已遗忘');
    expect(result).toContain(entry.id);
    expect(getMemory(entry.id)).toBeNull();
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]!.toolName).toBe('memory_forget');
    expect(auditLogs[0]!.success).toBe(true);
  });

  it('成功：auto 来源条目可删', async () => {
    const entry = insertMemory({
      scope: 'global', kind: 'knowledge', content: '自动提取的冗余知识', source: 'auto',
    });
    await tools.execute('memory_forget', { id: entry.id }, ctx);
    expect(getMemory(entry.id)).toBeNull();
  });

  it('拒绝：user 来源条目（用户主权），条目保留 + 失败审计', async () => {
    const entry = insertMemory({
      scope: 'workspace', workspaceId: 'ws1', kind: 'preference',
      content: '用户手动创建的偏好', source: 'user',
    });
    await expect(
      tools.execute('memory_forget', { id: entry.id }, ctx),
    ).rejects.toThrow('用户记忆只能由用户在设置中删除');
    // 条目未被删除
    expect(getMemory(entry.id)).not.toBeNull();
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]!.toolName).toBe('memory_forget');
    expect(auditLogs[0]!.success).toBe(false);
  });

  it('拒绝：不存在的 id（错误路径专项）', async () => {
    await expect(
      tools.execute('memory_forget', { id: '00000000-0000-4000-8000-000000000000' }, ctx),
    ).rejects.toThrow(/不存在/);
  });
});

describe('注册中心', () => {
  it('buildToolRegistry 包含 memory_* 三工具 defs（中文 description）', () => {
    const defs = getAllToolDefs(buildToolRegistry(ctx));
    const names = defs.map((d) => d.name);
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_forget');
    for (const def of defs.filter((d) => d.name.startsWith('memory_'))) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('handles 只认 memory_* 前缀', () => {
    expect(tools.handles('memory_save')).toBe(true);
    expect(tools.handles('memory_search')).toBe(true);
    expect(tools.handles('memory_forget')).toBe(true);
    expect(tools.handles('read_file')).toBe(false);
  });
});
