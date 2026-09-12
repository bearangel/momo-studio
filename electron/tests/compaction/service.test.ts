// electron/tests/compaction/service.test.ts
//
// 主进程 CompactionService 单测（spec §4.3，brief Task 3 Step 1）：
//   ① 成功生成：generateCompaction 返回摘要 + upsertSessionCompaction/getSessionCompaction
//      真实 SQL 往返（含截断到 COMPACTION_SUMMARY_MAX_LEN 的硬帽）
//   ② llm 返回空摘要 → throw（显式反馈）
//   ③ 无 LLM 配置（resolveSessionLlm → null）→ throw 指向「模型服务」
//   ④ 有 prior 行 → buildCompactionPrompt 收到 previousSummary（服务自读 session_compactions）
//   ⑤ llm.chat 抛错 → 包装为中文错误向上 throw
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄：只 mock LLM 边界（extraction.resolveSessionLlm）与 prompt 纯函数
//     （buildCompactionPrompt——T2 已有独立单测，此处 mock 以断言参数传递）
//   - DB 全真实：AP_USER_DATA_DIR + runMigrations + closeDb（沿用 extraction.test.ts 模式），
//     session_compactions 的 upsert/get 用真表断言 SQL 效果
//   - 截断上限引用本服务导出的 COMPACTION_SUMMARY_MAX_LEN（4000），与 extraction 的
//     SUMMARY_MAX_LEN（500）解耦——构造超 4000 字摘要的 LLM 返回以锁结构化模板上限
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';

// ─── LLM 边界 + prompt 纯函数 mock ──────────────────────────────────────────

const { resolveSessionLlmMock, chatMock, buildPromptMock } = vi.hoisted(() => ({
  resolveSessionLlmMock: vi.fn(),
  chatMock: vi.fn(),
  buildPromptMock: vi.fn(
    (input: { conversation: string; previousSummary?: string }) =>
      `PROMPT[conversation=${input.conversation};prior=${input.previousSummary ?? '无'}]`,
  ),
}));

// 只替换 resolveSessionLlm，其他 extraction 导出（包括 SUMMARY_MAX_LEN）保留真实值
vi.mock('../../src/main/memory/extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/memory/extraction')>()),
  resolveSessionLlm: resolveSessionLlmMock,
}));

vi.mock('../../src/main/compaction/prompt', () => ({
  buildCompactionPrompt: buildPromptMock,
}));

import {
  generateCompaction,
  upsertSessionCompaction,
  getSessionCompaction,
  COMPACTION_SUMMARY_MAX_LEN,
} from '../../src/main/compaction/service';

// ─── 测试基建 ────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `ap-compaction-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const WORKSPACE_ID = 'ws-compaction';
/** beforeEach 内重建（insertSession 生成随机 id，测试统一引用本变量） */
let SESSION_ID = '';

function seedWorkspace(): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji, default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(WORKSPACE_ID, 'WS', '', '/tmp', 0, '@owner:s', '📁');
}

function makeLlm(content: string): { chat: typeof chatMock } {
  return { chat: chatMock.mockResolvedValue({ content, toolCalls: [], finishReason: 'stop' }) };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedWorkspace();
  SESSION_ID = insertSession({ workspaceId: WORKSPACE_ID, title: 'T', titleAuto: true, kind: 'chat' }).id;

  chatMock.mockReset();
  buildPromptMock.mockClear();
  resolveSessionLlmMock.mockReset();
  resolveSessionLlmMock.mockResolvedValue(makeLlm('结构化摘要内容'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 持久化原语（真实 SQL 效果） ────────────────────────────────────────────

describe('upsertSessionCompaction / getSessionCompaction', () => {
  it('不存在的会话 → getSessionCompaction 返回 null', () => {
    expect(getSessionCompaction('no-such-session')).toBeNull();
  });

  it('upsert 后可读回（summary/coveredUntil 往返保真）', () => {
    upsertSessionCompaction(SESSION_ID, '第一版摘要', 1000);
    expect(getSessionCompaction(SESSION_ID)).toEqual({ summary: '第一版摘要', coveredUntil: 1000 });
  });

  it('二次 upsert 同会话 → ON CONFLICT 替换（每会话单行）', () => {
    upsertSessionCompaction(SESSION_ID, '第一版摘要', 1000);
    upsertSessionCompaction(SESSION_ID, '第二版摘要', 2000);
    expect(getSessionCompaction(SESSION_ID)).toEqual({ summary: '第二版摘要', coveredUntil: 2000 });
  });

  it('超长摘要落库时截断到 COMPACTION_SUMMARY_MAX_LEN（硬帽）', () => {
    const long = '长'.repeat(COMPACTION_SUMMARY_MAX_LEN + 200);
    upsertSessionCompaction(SESSION_ID, long, 1000);
    const row = getSessionCompaction(SESSION_ID);
    expect(row?.summary.length).toBe(COMPACTION_SUMMARY_MAX_LEN);
    expect(row?.summary).toBe('长'.repeat(COMPACTION_SUMMARY_MAX_LEN));
  });
});

// ─── generateCompaction（brief Step 1 四用例） ──────────────────────────────

describe('generateCompaction', () => {
  it('① 成功生成：返回摘要，prompt 经 llm.chat（单 user 消息）', async () => {
    const r = await generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 你好' });
    expect(r.summary).toBe('结构化摘要内容');
    // prompt 纯函数产出作为唯一 user 消息送入 LLM（形状锁：不混入 system/多消息）
    expect(chatMock).toHaveBeenCalledTimes(1);
    const messages = chatMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('PROMPT[conversation=[用户]: 你好;prior=无]');
  });

  it('② llm 返回空摘要 → throw（显式反馈）', async () => {
    resolveSessionLlmMock.mockResolvedValue(makeLlm('   '));
    await expect(
      generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 你好' }),
    ).rejects.toThrow('压缩摘要生成为空');
  });

  it('③ 无 LLM 配置 → throw 指向「模型服务」', async () => {
    resolveSessionLlmMock.mockResolvedValue(null);
    await expect(
      generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 你好' }),
    ).rejects.toThrow('未配置可用模型服务');
  });

  it('④ 有 prior 行 → buildCompactionPrompt 收到 previousSummary（服务自读表）', async () => {
    upsertSessionCompaction(SESSION_ID, '旧版结构化摘要', 500);
    await generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 新一轮' });
    expect(buildPromptMock).toHaveBeenCalledWith({
      conversation: '[用户]: 新一轮',
      previousSummary: '旧版结构化摘要',
    });
    // prompt 文本里 prior 已并入（服务未直接拼旧摘要绕过纯函数）
    const messages = chatMock.mock.calls[0][0] as Array<{ content: string }>;
    expect(messages[0]!.content).toContain('prior=旧版结构化摘要');
  });

  it('⑤ llm.chat 抛错 → 包装中文错误向上 throw（不吞）', async () => {
    resolveSessionLlmMock.mockResolvedValue({
      chat: chatMock.mockRejectedValue(new Error('API 429')),
    });
    await expect(
      generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 你好' }),
    ).rejects.toThrow('压缩摘要生成失败');
  });

  it('成功产物截断到 COMPACTION_SUMMARY_MAX_LEN（LLM 超长输出硬帽）', async () => {
    resolveSessionLlmMock.mockResolvedValue(makeLlm('摘'.repeat(COMPACTION_SUMMARY_MAX_LEN + 50)));
    const r = await generateCompaction({ sessionId: SESSION_ID, conversation: 'x' });
    expect(r.summary.length).toBe(COMPACTION_SUMMARY_MAX_LEN);
  });

  it('generateCompaction 本身不落库（covered_until 由调用方决定）', async () => {
    await generateCompaction({ sessionId: SESSION_ID, conversation: '[用户]: 你好' });
    expect(getSessionCompaction(SESSION_ID)).toBeNull();
  });
});
