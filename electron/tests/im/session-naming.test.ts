// electron/tests/im/session-naming.test.ts
//
// 会话命名服务测试（v25 Task 8，spec §4.5 / D4）：
//   - applyFirstMessageTitle：首条用户消息截断占位（前 20 字 / 去换行 / 仅占位态生效）
//   - scheduleLlmTitle：LLM 异步替换（fire-and-forget 静默失败）+ title_auto 竞态锁
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄：只 vi.mock llm-provider 的 createLLMProvider（网络边界）；
//     prompt 拼装、接待成员解析、rename 守卫 SQL 全部走真实实现
//   - keychain 经生产 setKeychainImpl 注入 fake（OS 边界注入钩子），
//     resolveApiKey（override ?? provider key）真实执行
//   - DB 隔离沿用 session-ops.test.ts 模式（AP_USER_DATA_DIR + runMigrations + closeDb）
//   - created_at 同毫秒排序不保证 → 显式拉开消息时间戳（同 session-ops added_at 处理）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  addSessionMember,
  getSession,
  type SessionRow,
} from '../../src/main/storage/sessions/repo';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import {
  PLACEHOLDER_TITLE,
  applyFirstMessageTitle,
  scheduleLlmTitle,
} from '../../src/main/im/session-naming';
import { PLACEHOLDER_TITLE as SESSION_OPS_PLACEHOLDER } from '../../src/main/im/session-ops';
import type { LLMMessage, LLMResponse } from '../../src/main/agent/llm-provider';

// ─── LLM 边界 mock（仅网络边界；其余全真实）────────────────────────────────

const { createLLMProviderMock, chatMock } = vi.hoisted(() => ({
  createLLMProviderMock: vi.fn(),
  chatMock: vi.fn(),
}));

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: createLLMProviderMock,
}));

// ─── 测试基建 ────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `ap-session-naming-${Date.now()}`);

const PROVIDER_ID = 'p1';
const USER_BODY_LONG = '帮我写一个登录页面，要求支持手机号验证码登录，还要有记住密码功能';
// 去换行后前 20 字（含逗号）：正好到第二个「码」
const TRUNCATED_20 = '帮我写一个登录页面，要求支持手机号验证码';

/** 手动可控的异步结果（并发/竞态用例需要显式编排完成顺序） */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function llmResp(content: string): LLMResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

/** 排空微任务队列（fire-and-forget 链无定时器，setImmediate 前微任务必清空） */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

function seedWorkspace(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁', null);
}

function seedProvider(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, platform)
     VALUES (?, ?, ?, ?, 'openai')`,
  ).run(id, `prov-${id}`, 'https://api.example.com/v1', `provider.${id}.api_key`);
}

function seedAgentDef(
  db: ReturnType<typeof getDb>,
  id: string,
  name: string,
  providerId: string | null,
  modelName: string,
): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, system_prompt, model_name, icon_emoji, model_provider_id)
     VALUES (?, ?, ?, '1', 'p', ?, '🤖', ?)`,
  ).run(id, name, name.toLowerCase(), modelName, providerId);
}

function seedMember(
  db: ReturnType<typeof getDb>,
  instanceId: string,
  workspaceId: string,
  defId: string,
): void {
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(instanceId, workspaceId, defId, `@${instanceId}:s`);
}

/** 建一个「快速会话」形状的会话：占位标题 + title_auto=1 + leader 成员 + 首轮对话 */
function seedAutoSessionWithDialogue(opts?: {
  title?: string;
  titleAuto?: boolean;
  withLeader?: boolean;
  withUserMessage?: boolean;
  withReply?: boolean;
  defProviderId?: string | null;
}): SessionRow {
  const db = getDb();
  const {
    title = PLACEHOLDER_TITLE,
    titleAuto = true,
    withLeader = true,
    withUserMessage = true,
    withReply = true,
    defProviderId = PROVIDER_ID,
  } = opts ?? {};
  seedWorkspace(db, 'ws1');
  seedProvider(db, PROVIDER_ID);
  seedAgentDef(db, 'def-lead', 'Alpha', defProviderId, 'gpt-4o-mini');
  seedMember(db, 'inst-lead', 'ws1', 'def-lead');

  const session = insertSession({ workspaceId: 'ws1', title, titleAuto });
  if (withLeader) addSessionMember(session.id, 'inst-lead', true);

  let ts = 1000;
  if (withUserMessage) {
    const userMsg = insertMessage({
      sessionId: session.id,
      sender: 'owner',
      eventType: 'm.room.message',
      body: USER_BODY_LONG,
    });
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, userMsg.id);
    ts += 1000;
  }
  if (withReply) {
    const replyMsg = insertMessage({
      sessionId: session.id,
      sender: 'agent-alpha-1',
      eventType: 'm.room.message',
      body: '好的，我将实现登录页面，包含手机号验证码输入与倒计时逻辑',
    });
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, replyMsg.id);
  }
  return session;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  // keychain OS 边界注入 fake：resolveApiKey 真实执行（override ?? provider key）
  setKeychainImpl({
    async getSecret(key: string) {
      return key === `provider.${PROVIDER_ID}.api_key` ? 'sk-test' : null;
    },
    async setSecret() {},
    async deleteSecret() {},
  });

  chatMock.mockReset();
  createLLMProviderMock.mockReset();
  createLLMProviderMock.mockImplementation(() => ({ chat: chatMock }));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 模块契约 ────────────────────────────────────────────────────────────────

describe('session-naming 模块契约', () => {
  it('PLACEHOLDER_TITLE 值为「新会话」且与 session-ops 同源（单一真相）', () => {
    expect(PLACEHOLDER_TITLE).toBe('新会话');
    expect(PLACEHOLDER_TITLE).toBe(SESSION_OPS_PLACEHOLDER);
  });
});

// ─── applyFirstMessageTitle：截断占位 ────────────────────────────────────────

describe('applyFirstMessageTitle —— 截断占位（spec §4.5）', () => {
  it('占位态（title=新会话 且 title_auto=1）：截断为去换行后前 20 字，title_auto 保持 1（LLM 仍可接管）', () => {
    const session = seedAutoSessionWithDialogue();

    applyFirstMessageTitle(session.id, `第一段结尾\n${USER_BODY_LONG}\n尾部`);

    const after = getSession(session.id);
    // 去换行后正文 =「第一段结尾 + USER_BODY_LONG + 尾部」，前 20 字
    expect(after?.title).toBe('第一段结尾帮我写一个登录页面，要求支持手');
    expect(after?.titleAuto).toBe(true);
  });

  it('短消息（<20 字）不截断，整段成为标题', () => {
    const session = seedAutoSessionWithDialogue();

    applyFirstMessageTitle(session.id, '帮我修个 bug');

    expect(getSession(session.id)?.title).toBe('帮我修个 bug');
    expect(getSession(session.id)?.titleAuto).toBe(true);
  });

  it('去换行：多行消息的 \\r \\n 全部剔除后再截断', () => {
    const session = seedAutoSessionWithDialogue();

    applyFirstMessageTitle(session.id, '第一行\r\n第二行\n\n第三行内容继续往下写凑字数abc');

    const title = getSession(session.id)?.title ?? '';
    expect(title).not.toMatch(/[\r\n]/);
    expect(title).toBe('第一行第二行第三行内容继续往下写凑字数a');
  });

  it('用户已手动改名（title_auto=0）：截断不覆盖', () => {
    const session = seedAutoSessionWithDialogue({ title: '用户命名', titleAuto: false });

    applyFirstMessageTitle(session.id, USER_BODY_LONG);

    expect(getSession(session.id)?.title).toBe('用户命名');
    expect(getSession(session.id)?.titleAuto).toBe(false);
  });

  it('用户手动改名恰好叫「新会话」（title_auto=0）：同样不覆盖（锁死 title 条件不可独立生效）', () => {
    const session = seedAutoSessionWithDialogue({ title: '新会话', titleAuto: false });

    applyFirstMessageTitle(session.id, USER_BODY_LONG);

    expect(getSession(session.id)?.title).toBe('新会话');
    expect(getSession(session.id)?.titleAuto).toBe(false);
  });

  it('首条语义：第二次调用不覆盖首次截断结果', () => {
    const session = seedAutoSessionWithDialogue();

    applyFirstMessageTitle(session.id, '第一条消息占位标题素材');
    applyFirstMessageTitle(session.id, '第二条消息不应生效');

    expect(getSession(session.id)?.title).toBe('第一条消息占位标题素材');
  });

  it('空输入防御：空串 / 纯空白 / 纯换行 body → 保持占位不动、不抛错', () => {
    const session = seedAutoSessionWithDialogue();

    for (const emptyBody of ['', '   ', '\n\n', '\r\n \n']) {
      expect(() => applyFirstMessageTitle(session.id, emptyBody)).not.toThrow();
    }

    expect(getSession(session.id)?.title).toBe(PLACEHOLDER_TITLE);
    expect(getSession(session.id)?.titleAuto).toBe(true);
  });

  it('会话不存在：静默不抛错', () => {
    expect(() => applyFirstMessageTitle('session-404', USER_BODY_LONG)).not.toThrow();
  });
});

// ─── scheduleLlmTitle：LLM 异步替换 ─────────────────────────────────────────

describe('scheduleLlmTitle —— LLM 异步替换 + 竞态锁（spec §4.5）', () => {
  it('成功路径：先截断后 LLM 替换、title_auto 置 0；provider/model 按 leader 成员 def 解析；prompt 含首条用户消息与回复摘录', async () => {
    const session = seedAutoSessionWithDialogue();
    // leader 之外再放一个不同 def 的成员——锁死「接待成员（is_leader）」解析而非任意成员
    const db = getDb();
    seedAgentDef(db, 'def-sub', 'Beta', PROVIDER_ID, 'beta-model-x');
    seedMember(db, 'inst-sub', 'ws1', 'def-sub');
    addSessionMember(session.id, 'inst-sub', false);

    applyFirstMessageTitle(session.id, USER_BODY_LONG);
    expect(getSession(session.id)?.title).toBe(TRUNCATED_20);

    chatMock.mockResolvedValueOnce(llmResp('登录页实现'));
    scheduleLlmTitle(session.id);

    await vi.waitFor(() => expect(getSession(session.id)?.title).toBe('登录页实现'));
    expect(getSession(session.id)?.titleAuto).toBe(false);

    // LLM 边界：leader 成员 → def → model_providers 解析链（platform/model/baseUrl + key）
    expect(createLLMProviderMock).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.example.com/v1' },
      'sk-test',
    );

    // prompt 拼装：首条用户消息正文 + 首次回复摘录都进入 user 消息（真实拼装不 mock）
    const promptMessages = chatMock.mock.calls[0]?.[0] as LLMMessage[] | undefined;
    const userPrompt = promptMessages?.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('帮我写一个登录页面');
    expect(userPrompt).toContain('好的，我将实现登录页面');
  });

  it('失败静默：LLM 调用 reject → title 与 title_auto 保持，不产生未处理 rejection', async () => {
    const session = seedAutoSessionWithDialogue();
    applyFirstMessageTitle(session.id, USER_BODY_LONG);

    chatMock.mockRejectedValueOnce(new Error('LLM 429 限流'));
    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(getSession(session.id)?.title).toBe(TRUNCATED_20);
    expect(getSession(session.id)?.titleAuto).toBe(true);
  });

  it('title_auto=0（用户已命名）：跳过 LLM 调用，title 不变', async () => {
    const session = seedAutoSessionWithDialogue({ title: '用户命名', titleAuto: false });

    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(chatMock).not.toHaveBeenCalled();
    expect(getSession(session.id)?.title).toBe('用户命名');
    expect(getSession(session.id)?.titleAuto).toBe(false);
  });

  it('竞态锁：LLM 生成期间用户手动改名（title_auto→0）→ UPDATE 0 行放弃，保留用户标题', async () => {
    const session = seedAutoSessionWithDialogue();

    const flight = defer<LLMResponse>();
    chatMock.mockImplementationOnce(() => flight.promise);
    scheduleLlmTitle(session.id);
    await vi.waitFor(() => expect(chatMock).toHaveBeenCalled());

    // 模拟用户在 LLM 飞行中手动改名（rename + title_auto=0 终态）
    getDb()
      .prepare("UPDATE sessions SET title = '用户手动名', title_auto = 0 WHERE id = ?")
      .run(session.id);

    flight.resolve(llmResp('LLM 迟到标题'));
    await flushMicrotasks();

    expect(getSession(session.id)?.title).toBe('用户手动名');
    expect(getSession(session.id)?.titleAuto).toBe(false);
  });

  it('并发双 final：两次调度只生效一次——先完成者胜，后到者 0 行放弃', async () => {
    const session = seedAutoSessionWithDialogue();

    const first = defer<LLMResponse>();
    const second = defer<LLMResponse>();
    chatMock.mockImplementationOnce(() => first.promise);
    chatMock.mockImplementationOnce(() => second.promise);

    scheduleLlmTitle(session.id);
    scheduleLlmTitle(session.id);
    await vi.waitFor(() => expect(chatMock).toHaveBeenCalledTimes(2));

    first.resolve(llmResp('标题一'));
    await vi.waitFor(() => expect(getSession(session.id)?.title).toBe('标题一'));
    expect(getSession(session.id)?.titleAuto).toBe(false);

    second.resolve(llmResp('标题二'));
    await flushMicrotasks();

    expect(getSession(session.id)?.title).toBe('标题一');
    expect(getSession(session.id)?.titleAuto).toBe(false);
  });

  it('LLM 输出空白：视为无效放弃，title 与 title_auto 保持', async () => {
    const session = seedAutoSessionWithDialogue();
    applyFirstMessageTitle(session.id, USER_BODY_LONG);

    chatMock.mockResolvedValueOnce(llmResp('   \n  '));
    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(getSession(session.id)?.title).toBe(TRUNCATED_20);
    expect(getSession(session.id)?.titleAuto).toBe(true);
  });

  it('无首条用户消息：不调 LLM（无可命名素材）', async () => {
    const session = seedAutoSessionWithDialogue({ withUserMessage: false, withReply: false });

    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(chatMock).not.toHaveBeenCalled();
    expect(getSession(session.id)?.title).toBe(PLACEHOLDER_TITLE);
  });

  it('无 leader 成员（有成员但都非接待）：不调 LLM', async () => {
    const session = seedAutoSessionWithDialogue({ withLeader: false });
    addSessionMember(session.id, 'inst-lead', false);

    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(chatMock).not.toHaveBeenCalled();
  });

  it('接待 agent 的 def 未配置 provider：静默跳过不调 LLM', async () => {
    const session = seedAutoSessionWithDialogue({ defProviderId: null });

    scheduleLlmTitle(session.id);
    await flushMicrotasks();

    expect(chatMock).not.toHaveBeenCalled();
    expect(getSession(session.id)?.title).toBe(PLACEHOLDER_TITLE);
  });

  it('会话不存在：静默不抛错、不调 LLM', async () => {
    expect(() => scheduleLlmTitle('session-404')).not.toThrow();
    await flushMicrotasks();
    expect(chatMock).not.toHaveBeenCalled();
  });
});
