// electron/tests/memory/extraction.test.ts
//
// 自动提取管线测试（v2.2 记忆 P2 Task 3，spec §6.4）：
//   - ADD-only 落库：候选按 scope 白名单落 global/workspace（pinned=0/confidence=0.7/source='auto'，不落 session 层）
//   - 坏 JSON 容错：平衡块解析 → 失败后逐对象扫描 salvage；坏 kind 丢弃
//   - 去重跳过：BM25 命中且首条与候选前 20 字高度重叠 → 跳过
//   - 双开关 gate：memoryEnabled=false 跳过；memoryExtractionEnabled 缺省仍运行（Task 5 正式接入前的当前语义）
//   - 去抖窗口：同会话 10 分钟内重复 → 仅一次 LLM 调用；过窗后下一次正常运行
//   - >40 压缩 upsert+游标：session_summaries ON CONFLICT 替换、covered_until=窗口最新消息 createdAt
//   - ≤40 不写摘要：chat 即使返回 session_summary 也不落库
//   - provider 解析失败：findReceptionAgent/getAgentDefinition/getProvider/resolveApiKey 任一失败静默跳过
//   - LLM 失败静默：runExtraction 直接调用 reject 不向上抛；scheduleExtraction 同源
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄：只 vi.mock llm-provider 的 createLLMProvider（网络边界）
//   - 其余全真实：prompt 拼装、kind 白名单、balance 解析、扫描 salvage、searchMemories、insertMemory
//     upsert、resolveApiKey（keychain fake 注入）、getConversationContext、getPinnedContext 全部走真实实现
//   - DB 隔离：AP_USER_DATA_DIR + runMigrations + closeDb（沿用 session-naming.test.ts 模式）
//   - 时间戳显式拉开（避免 created_at 同毫秒排序不保证，session-naming.test.ts 同款）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertSession,
  addSessionMember,
} from '../../src/main/storage/sessions/repo';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { getMemory, insertMemory } from '../../src/main/storage/memories/repo';
import { searchMemories as storageSearchMemories } from '../../src/main/storage/memories/search';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import {
  runExtraction,
  scheduleExtraction,
  EXTRACTION_DEBOUNCE_MS,
  SESSION_COMPRESS_THRESHOLD,
  TRIGGER_TURN_INTERVAL,
  __resetExtractionStateForTest,
} from '../../src/main/memory/extraction';
// WINDOW_LIMIT 内部常量未导出，评审回归锁直接硬码 50 与之对齐；
// 若 WINDOW_LIMIT 变更，此断言需同步调整（唯一真相源在 extraction.ts）。
const WINDOW_LIMIT = 50;
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

const tmpRoot = path.join(os.tmpdir(), `ap-extraction-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const PROVIDER_ID = 'p-ext';
const AGENT_DEF_ID = 'def-ext-lead';
const INSTANCE_ID = 'inst-ext-lead';
const WORKSPACE_ID = 'ws-ext';
const SESSION_ID = 's-ext-1';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function llmResp(content: string): LLMResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

function seedWorkspace(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji, default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, 'WS', '', '/tmp', 0, '@owner:s', '📁');
}
function seedProvider(db: ReturnType<typeof getDb>, id: string): void {
  db.prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, platform)
     VALUES (?, ?, ?, ?, 'openai')`,
  ).run(id, `prov-${id}`, 'https://api.example.com/v1', `provider.${id}.api_key`);
}
function seedAgentDef(db: ReturnType<typeof getDb>, id: string, providerId: string | null, modelName: string): void {
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji, model_provider_id)
     VALUES (?, ?, ?, '1', 'p', ?, '🤖', ?)`,
  ).run(id, 'Alpha', 'alpha', modelName, providerId);
}
function seedMember(db: ReturnType<typeof getDb>, instanceId: string, workspaceId: string, defId: string): void {
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(instanceId, workspaceId, defId, `@${instanceId}:s`);
}

/**
 * 创建一个完整可提取会话：ws + provider + def + leader 成员 + 会话 + 交替 user/agent 消息。
 * 返回 SessionRow.id；userMsgs/agentMsgs 控制消息总数，user 至少 2 才能进入 LLM 流程。
 */
function seedSession(opts: {
  userMsgs: number;
  agentMsgs: number;
  defProviderId?: string | null;
  withLeader?: boolean;
}): string {
  const db = getDb();
  const defProviderId = opts.defProviderId !== undefined ? opts.defProviderId : PROVIDER_ID;
  seedWorkspace(db, WORKSPACE_ID);
  seedProvider(db, PROVIDER_ID);
  seedAgentDef(db, AGENT_DEF_ID, defProviderId, 'gpt-4o-mini');
  seedMember(db, INSTANCE_ID, WORKSPACE_ID, AGENT_DEF_ID);

  const session = insertSession({ workspaceId: WORKSPACE_ID, title: 'T', titleAuto: true });
  if (opts.withLeader !== false) addSessionMember(session.id, INSTANCE_ID, true);

  let ts = 1000;
  const total = opts.userMsgs + opts.agentMsgs;
  let ui = 0;
  let ai = 0;
  for (let i = 0; i < total; i++) {
    const isUser = i % 2 === 0;
    if (isUser && ui >= opts.userMsgs) continue;
    if (!isUser && ai >= opts.agentMsgs) continue;
    const body = isUser ? `用户消息 ${++ui}` : `助手回复 ${++ai}`;
    const sender = isUser ? 'owner' : 'agent-alpha-1';
    const m = insertMessage({
      sessionId: session.id,
      sender,
      eventType: 'm.room.message',
      body,
      workspaceId: WORKSPACE_ID,
    });
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, m.id);
    ts += 1000;
  }
  return session.id;
}

function countMemoriesBySource(src: 'auto' | 'agent' | 'user'): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE source = ?')
    .get(src) as { n: number };
  return row.n;
}
function listSessionSummary(sessionId: string): { summary: string; covered_until: number; updated_at: number } | null {
  const row = getDb()
    .prepare('SELECT summary, covered_until, updated_at FROM session_summaries WHERE session_id = ?')
    .get(sessionId) as { summary: string; covered_until: number; updated_at: number } | undefined;
  return row ?? null;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

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
  __resetExtractionStateForTest();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// ─── 模块契约 ────────────────────────────────────────────────────────────────

describe('extraction 模块契约', () => {
  it('导出常量值锁定（供 Task 4 接线引用）', () => {
    expect(EXTRACTION_DEBOUNCE_MS).toBe(10 * 60 * 1000);
    expect(SESSION_COMPRESS_THRESHOLD).toBe(40);
    expect(TRIGGER_TURN_INTERVAL).toBe(20);
  });
});

// ─── runExtraction：ADD-only 落库 ───────────────────────────────────────────

describe('runExtraction —— ADD-only 落库', () => {
  it('成功：global + workspace 两候选按白名单落库，source=auto / pinned=0 / confidence=0.7，不落 session 层', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [
        { kind: 'preference', content: '用户偏好简洁回复', tags: ['回复', '偏好'], scope: 'global' },
        { kind: 'knowledge', content: '当前项目使用 pnpm 而非 npm', tags: ['工具'], scope: 'workspace' },
      ],
      session_summary: '',
    })));

    await runExtraction(sid);

    // createLLMProvider 边界：leader → def → provider 解析链（platform/model/baseUrl + apiKey）
    expect(createLLMProviderMock).toHaveBeenCalledWith(
      { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.example.com/v1' },
      'sk-test',
    );

    const all = getDb().prepare('SELECT id, scope, workspace_id, session_id, kind, pinned, source, confidence, content, tags FROM memories ORDER BY scope, kind').all() as Array<{
      id: string; scope: string; workspace_id: string | null; session_id: string | null;
      kind: string; pinned: number; source: string; confidence: number; content: string; tags: string;
    }>;
    expect(all).toHaveLength(2);

    const globalRow = all.find((r) => r.scope === 'global')!;
    expect(globalRow.kind).toBe('preference');
    expect(globalRow.workspace_id).toBeNull();
    expect(globalRow.session_id).toBeNull();
    expect(globalRow.pinned).toBe(0);
    expect(globalRow.source).toBe('auto');
    expect(globalRow.confidence).toBe(0.7);
    expect(JSON.parse(globalRow.tags)).toEqual(['回复', '偏好']);

    const wsRow = all.find((r) => r.scope === 'workspace')!;
    expect(wsRow.workspace_id).toBe(WORKSPACE_ID);
    expect(wsRow.session_id).toBeNull();
    expect(wsRow.pinned).toBe(0);
    expect(wsRow.source).toBe('auto');
    expect(wsRow.confidence).toBe(0.7);
  });

  it('kind/scope 白名单：非法 kind 丢弃，缺省 scope 视为 workspace', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [
        { kind: 'rule', content: '非法 kind 应丢弃', tags: [] },                 // 非白名单
        { kind: 'preference', content: '合法 preference', tags: ['t'], scope: 'session' }, // 非法 scope → 默认 workspace
        { kind: 'summary', content: '合法 summary', tags: [] },                  // 缺省 scope → workspace
      ],
    })));

    await runExtraction(sid);

    const rows = getDb().prepare('SELECT kind, scope, workspace_id, content FROM memories ORDER BY content').all() as Array<{ kind: string; scope: string; workspace_id: string | null; content: string }>;
    // rule 被丢弃；session scope 降级到 workspace；summary 缺省 workspace
    expect(rows.map((r) => r.content)).toEqual(['合法 preference', '合法 summary']);
    expect(rows.every((r) => r.scope === 'workspace')).toBe(true);
    expect(rows.every((r) => r.workspace_id === WORKSPACE_ID)).toBe(true);
  });
});

// ─── runExtraction：坏 JSON 容错 ─────────────────────────────────────────────

describe('runExtraction —— 坏 JSON 容错', () => {
  it('纯 JSON：平衡块一次解析成功', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: 'A', tags: [] }],
    })));
    await runExtraction(sid);
    expect(countMemoriesBySource('auto')).toBe(1);
  });

  it('平衡块被前置噪声包裹：仍能从首个 {…} 块解析', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValueOnce(llmResp(
      `前置废话与 Markdown 标记\n\`\`\`json\n${JSON.stringify({ memories: [{ kind: 'preference', content: 'B', tags: [] }] })}\n\`\`\`\n后置废话`,
    ));
    await runExtraction(sid);
    const rows = getDb().prepare('SELECT content FROM memories').all() as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toEqual(['B']);
  });

  it('外层 JSON 坏但内层单个对象仍可解析：逐对象扫描 salvage 合法 kind 项，丢弃坏对象', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    // 故意坏的外层：每条 memory 之间含非法 token；平衡块匹配整个首段会 parse 失败 → fallback 扫描
    chatMock.mockResolvedValueOnce(llmResp(
      `{"memories":[{not_json_here},` +
      `{"kind":"preference","content":"salvage-1","tags":[]},` +
      `{"kind":"knowledge","content":"salvage-2","tags":["x"]},` +
      `{bad_object},` +
      `{"kind":"summary","content":"salvage-3","tags":[]}]}`,
    ));
    await runExtraction(sid);
    const rows = getDb().prepare('SELECT content FROM memories ORDER BY content').all() as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toEqual(['salvage-1', 'salvage-2', 'salvage-3']);
  });

  it('完全不可解析：静默不抛错，不落库任何记忆', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValueOnce(llmResp('LLM 返回纯文本，无任何 JSON 结构'));
    await expect(runExtraction(sid)).resolves.toBeUndefined();
    expect(countMemoriesBySource('auto')).toBe(0);
  });

  it('解析异常不向上抛：chat 直接 reject → runExtraction 不 rethrow', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockRejectedValueOnce(new Error('LLM 429'));
    await expect(runExtraction(sid)).resolves.toBeUndefined();
    expect(countMemoriesBySource('auto')).toBe(0);
  });
});

// ─── runExtraction：去重跳过 ─────────────────────────────────────────────────

describe('runExtraction —— 去重跳过（BM25 + 首条内容重叠）', () => {
  it('已有近义记忆：候选内容被覆盖 → 跳过 + 不新增', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });

    // 预先插入既有记忆：内容是候选的前缀（≥20 字重叠）
    insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID,
      kind: 'knowledge', content: '当前项目使用 pnpm 而非 npm 进行依赖管理',
      source: 'agent',
    });

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: '当前项目使用 pnpm 而非 npm', tags: ['工具'] }],
    })));

    await runExtraction(sid);
    expect(countMemoriesBySource('auto')).toBe(0);
    expect(countMemoriesBySource('agent')).toBe(1); // 既有条目未变
  });

  it('无重叠命中：正常落库', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID,
      kind: 'knowledge', content: '数据库使用 PostgreSQL',
      source: 'agent',
    });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: '前端框架为 React 18', tags: ['前端'] }],
    })));
    await runExtraction(sid);
    expect(countMemoriesBySource('auto')).toBe(1);
  });
});

// ─── runExtraction：双开关 gate ─────────────────────────────────────────────

describe('runExtraction —— 双开关 gate', () => {
  it('memoryEnabled=false → 直接跳过，不调 LLM，不写库', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    updateGlobalSettings({ memoryEnabled: false });

    await runExtraction(sid);

    expect(chatMock).not.toHaveBeenCalled();
    expect(createLLMProviderMock).not.toHaveBeenCalled();
    expect(countMemoriesBySource('auto')).toBe(0);
  });

  it('memoryExtractionEnabled 缺省视为启用：未写入字段时正常调用 LLM', async () => {
    // 写入字段已正式接入 crud.getGlobalSettings（Task 5 落地）——未写入时
    // extraction 读取按 `?? true` 视为启用，不应误把 undefined 当关闭而跳过。
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({ memories: [] })));
    await runExtraction(sid);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('memoryExtractionEnabled=false → 直接跳过，不调 LLM，不写库（Task 5 crud 已正式接入字段）', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    updateGlobalSettings({ memoryExtractionEnabled: false });

    await runExtraction(sid);

    expect(chatMock).not.toHaveBeenCalled();
    expect(createLLMProviderMock).not.toHaveBeenCalled();
    expect(countMemoriesBySource('auto')).toBe(0);
  });
});

// ─── runExtraction：去抖窗口 ─────────────────────────────────────────────────

describe('runExtraction —— 去抖窗口', () => {
  it('同会话 10 分钟内连续两次：仅首次调 LLM', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValue(llmResp(JSON.stringify({ memories: [] })));

    await runExtraction(sid);
    await runExtraction(sid);
    await runExtraction(sid);

    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('过窗后下一次：正常运行（时间戳前进 10 分钟）', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    const originalNow = Date.now;
    chatMock.mockResolvedValue(llmResp(JSON.stringify({ memories: [] })));

    await runExtraction(sid);
    expect(chatMock).toHaveBeenCalledTimes(1);

    Date.now = () => originalNow() + EXTRACTION_DEBOUNCE_MS + 1;
    try {
      await runExtraction(sid);
      expect(chatMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalNow;
    }
  });

  it('LLM 失败不占去抖窗口：下次触发自然重试', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockRejectedValueOnce(new Error('LLM 临时故障'));
    await runExtraction(sid);
    expect(chatMock).toHaveBeenCalledTimes(1);

    // 紧随的第二次触发不应被去抖拦截（mark 已被失败路径清除）
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({ memories: [] })));
    await runExtraction(sid);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
});

// ─── runExtraction：会话压缩 upsert + 游标 ────────────────────────────────────

describe('runExtraction —— 会话压缩（spec §6.4 >40 阈值）', () => {
  it('>40 消息：session_summaries upsert 写入，covered_until=窗口最新消息 createdAt', async () => {
    const sid = seedSession({ userMsgs: 23, agentMsgs: 22 }); // 总数 45

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [],
      session_summary: '已完成登录重构；下一步接入 oauth',
    })));

await runExtraction(sid);

    const row = listSessionSummary(sid);
    expect(row).not.toBeNull();
    expect(row!.summary).toBe('已完成登录重构；下一步接入 oauth');

    // covered_until = 窗口最新消息 createdAt（最后插入消息时间戳）
    const maxCreatedAt = (getDb().prepare('SELECT MAX(created_at) AS t FROM messages WHERE session_id = ?').get(sid) as { t: number }).t;
    expect(row!.covered_until).toBe(maxCreatedAt);
  });

  it('>50 消息（评审修复回归锁）：窗口取最近 50 条，LLM prompt 含第 51+ 条消息，covered_until=全会话 MAX', async () => {
    // 60 条消息：30 用户 + 30 助手（seedSession 交替插入，去重后 60 条）。
    // 第 51 条起的内容必须出现在 prompt 转录中，证明 beforeTs 锚点生效；
    // 若窗口冻结为 ASC LIMIT 50（评审发现的旧实现），第 51+ 条被吞，回归锁立即红。
    const sid = seedSession({ userMsgs: 30, agentMsgs: 30 });
    const totalMessages = (getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sid) as { n: number }).n;
    expect(totalMessages).toBeGreaterThan(WINDOW_LIMIT);
    const maxCreatedAt = (getDb().prepare('SELECT MAX(created_at) AS t FROM messages WHERE session_id = ?').get(sid) as { t: number }).t;

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: '从最新窗口中拿到', tags: [] }],
      session_summary: '覆盖到第 60 条的摘要',
    })));
    await runExtraction(sid);

    // covered_until = 全会话最新消息 createdAt（非窗口内最早）
    const row = listSessionSummary(sid);
    expect(row?.covered_until).toBe(maxCreatedAt);

    // LLM prompt 转录必须包含「用户消息 30」「助手回复 30」（第 51+ 条消息的尾部内容）
    const promptMessages = chatMock.mock.calls[0]?.[0] as LLMMessage[] | undefined;
    const userPrompt = promptMessages?.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('用户消息 30');
    expect(userPrompt).toContain('助手回复 30');
    // 窗口恰好 50 条（prompt header 「共 N 条」+ 行计数）
    expect(userPrompt).toContain('共 50 条');
    const userLines = (userPrompt.match(/^用户：/gm) ?? []).length;
    const assistantLines = (userPrompt.match(/^助手：/gm) ?? []).length;
    expect(userLines + assistantLines).toBe(50);
    // 最旧的 10 条（第 1..10 行）必须被排除（冻结旧实现下会全量包含共 60 条）
    expect(userLines + assistantLines).toBeLessThan(60);
    // 精确断言最早 5 条用户消息不存在（用换行边界避免「用户消息 1」撞「用户消息 11..19」前缀）
    for (let i = 1; i <= 5; i++) {
      expect(userPrompt).not.toMatch(new RegExp(`用户：用户消息 ${i}(?!\\d)`));
    }
  });

  it('>40 消息：再次运行以新摘要覆盖（upsert 行为）', async () => {
    const sid = seedSession({ userMsgs: 23, agentMsgs: 22 });

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [], session_summary: '首版摘要 v1',
    })));
    await runExtraction(sid);
    expect(listSessionSummary(sid)?.summary).toBe('首版摘要 v1');

    // 时间推进过窗 → 第二次提取
    const originalNow = Date.now;
    Date.now = () => originalNow() + EXTRACTION_DEBOUNCE_MS + 1;
    try {
      chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
        memories: [], session_summary: '融合后摘要 v2',
      })));
      await runExtraction(sid);

      const row = listSessionSummary(sid);
      expect(row?.summary).toBe('融合后摘要 v2');
    } finally {
      Date.now = originalNow;
    }
  });

  it('≤40 消息：即使 LLM 返回 session_summary 也不落库', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 }); // 总数 4

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: 'X', tags: [] }],
      session_summary: '不应被写入的摘要',
    })));

    await runExtraction(sid);
    expect(countMemoriesBySource('auto')).toBe(1);
    expect(listSessionSummary(sid)).toBeNull();
  });

  it('>40 + 既有摘要：用户 prompt 包含既有摘要文本（融合续写输入）', async () => {
    const sid = seedSession({ userMsgs: 23, agentMsgs: 22 });

    // 预置既有摘要
    getDb()
      .prepare('INSERT INTO session_summaries (session_id, summary, covered_until, updated_at) VALUES (?, ?, ?, ?)')
      .run(sid, '既有摘要 v0——用户在做登录改造', 500, 100);

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [], session_summary: '融合后的摘要 v1',
    })));
    await runExtraction(sid);

    const promptMessages = chatMock.mock.calls[0]?.[0] as LLMMessage[] | undefined;
    const userPrompt = promptMessages?.find((m) => m.role === 'user')?.content ?? '';
    expect(userPrompt).toContain('既有摘要 v0');
    expect(userPrompt).toContain('融合');
  });
});

// ─── runExtraction：provider 解析失败静默跳过 ────────────────────────────────

describe('runExtraction —— provider 解析失败静默跳过', () => {
  it('会话无 leader 成员：不调 LLM，不抛错', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2, withLeader: false });
    await expect(runExtraction(sid)).resolves.toBeUndefined();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('leader agent def 未配置 provider：不调 LLM，不抛错', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2, defProviderId: null });
    await expect(runExtraction(sid)).resolves.toBeUndefined();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('窗口用户消息 <2：跳过 LLM', async () => {
    // seedSession 要求 userMsgs≥1；此处只塞 1 条用户消息 + 1 条 agent
    const sid = seedSession({ userMsgs: 1, agentMsgs: 1 });
    await expect(runExtraction(sid)).resolves.toBeUndefined();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('会话不存在：静默不抛错、不调 LLM', async () => {
    await expect(runExtraction('session-404')).resolves.toBeUndefined();
    expect(chatMock).not.toHaveBeenCalled();
  });
});

// ─── scheduleExtraction：fire-and-forget 包装 ─────────────────────────────────

describe('scheduleExtraction —— fire-and-forget 静默失败', () => {
  it('LLM 拒绝：调度自身不抛、未处理 rejection 不外漏', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockRejectedValueOnce(new Error('网络抖动'));

    expect(() => scheduleExtraction(sid)).not.toThrow();
    await flushMicrotasks();
    // 不留 unhandled rejection：等待一个额外 microtask 验证控制台未抛错
    await flushMicrotasks();
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('成功路径下仍调用真实 runExtraction 路径', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'preference', content: '通过 scheduleExtraction 落地', tags: [] }],
    })));

    scheduleExtraction(sid);
    await vi.waitFor(() => expect(countMemoriesBySource('auto')).toBe(1));
  });
});

// ─── P3 Task 1：数据信号净化（I-1 / M-5 / M-1）───────────────────────────────

describe('runExtraction —— 去重探测不污染热度信号（I-1）', () => {
  it('候选被判重复跳过：既有条目 use_count / last_used_at 保持不变', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    const existing = insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID,
      kind: 'knowledge', content: '用户偏好深色主题界面与等宽字体', source: 'agent',
    });
    // 候选是既有条目的子串 → BM25 必命中且双向包含 → 判定重复跳过。
    // 旧实现去重走 provider.searchMemories（命中即 touch）→ use_count 被去重探测污染。
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'preference', content: '用户偏好深色主题界面', tags: [] }],
    })));

    await runExtraction(sid);

    expect(countMemoriesBySource('auto')).toBe(0); // 判定重复，未新增
    const after = getMemory(existing.id)!;
    expect(after.useCount).toBe(0);
    expect(after.lastUsedAt).toBeNull();
  });

  it('候选无重叠正常落库：去重探测命中的既有条目同样不被 touch', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    // 既有条目是候选 tokens 的交错重排（同 token 集 → BM25 AND 语义必命中），
    // 但任意 20 字窗口无连续重叠 → 非重复 → 候选正常落库。
    // 旧实现去重探测经 provider 检索（命中即 touch）→ use_count 被污染。
    const existing = insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID,
      kind: 'knowledge', content: '用户宽偏好字体深色进行主题夜间界面编码与作业等', source: 'agent',
    });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'preference', content: '用户偏好深色主题界面与等宽字体进行夜间编码作业', tags: [] }],
    })));

    await runExtraction(sid);

    expect(countMemoriesBySource('auto')).toBe(1); // 非重复 → 正常落库
    const after = getMemory(existing.id)!;
    expect(after.useCount).toBe(0); // 但探测命中的既有条目不递增（旧实现 +1）
    expect(after.lastUsedAt).toBeNull();
  });
});

describe('runExtraction —— top3 去重（M-5）', () => {
  it('重复条目排在第 2 位（首位为高相关无重叠干扰项）时仍被识别跳过', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    // 候选 = HEAD(20字) + TAIL(20字)，恰 40 字 = DEDUP_PREFIX_LEN（去重 query 为完整候选）
    const HEAD = '夜间构建流水线需要在合并前完成全部检查项';
    const TAIL = '发布前必须确认版本号与变更清单及目录指引';
    const cand = HEAD + TAIL;
    // 干扰项：候选 tokens 的交错重排（同 token 集 → AND 语义命中；doc 更短 → rank 1），
    // 但任意 20 字窗口无连续重叠 → 非重复
    const decoy = insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID, kind: 'knowledge',
      content: '夜间发布构建前流水线必须需要确认在版本号合并与前变更完成清单全部及检查目录项指引', source: 'agent',
    });
    // 重复项：候选全文 + 长后缀（token 超集 → 命中；显著更长 → BM25 长度归一后排 rank 2；
    // content 含候选首 20 字 → 双向包含命中）
    const dup = insertMemory({
      scope: 'workspace', workspaceId: WORKSPACE_ID, kind: 'knowledge',
      content: cand + '（很早以前的旧版本归档记录，与当前候选重复但归档说明文字更长一些）', source: 'agent',
    });

    // 夹具自检：BM25 排序必须 decoy 第 1、dup 第 2（若排序不成立先修夹具内容，而非实现）
    const ranking = storageSearchMemories(cand, { workspaceId: WORKSPACE_ID, sessionId: null }, 10);
    expect(ranking[0]!.id).toBe(decoy.id);
    expect(ranking[1]!.id).toBe(dup.id);

    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: [{ kind: 'knowledge', content: cand, tags: [] }],
    })));

    await runExtraction(sid);

    // 旧实现只比对 hits[0]（decoy 非重复）→ 候选被误当新知识插入（红点）
    expect(countMemoriesBySource('auto')).toBe(0);
    expect(getMemory(decoy.id)!.useCount).toBe(0);
    expect(getMemory(dup.id)!.useCount).toBe(0);
  });
});

describe('runExtraction —— 解析容错续扫（M-1）', () => {
  it('首个平衡块合法 JSON 但 memories 非数组：候选继续 fallback 扫描提取', async () => {
    const sid = seedSession({ userMsgs: 2, agentMsgs: 2 });
    // LLM 把 memories 写成对象（形态错误）：外层 JSON 合法 → 旧实现直接返回空候选（红点）；
    // 期望：不放弃，fallback 逐对象扫描 salvage 出内层 {kind, content}
    chatMock.mockResolvedValueOnce(llmResp(
      '{"memories": {"kind":"knowledge","content":"嵌在错误结构里的记忆条目","tags":[]}}',
    ));

    await runExtraction(sid);

    const rows = getDb().prepare('SELECT content FROM memories').all() as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toEqual(['嵌在错误结构里的记忆条目']);
  });

  it('memories 非数组但 session_summary 合法：候选走扫描 + 外层摘要仍保留（回归锁）', async () => {
    // >40 消息触发压缩路径：外层 JSON 合法时 session_summary 可信，
    // 修复不得因 memories 形态错误而丢失摘要（旧实现本行为已正确，此处锁定）
    const sid = seedSession({ userMsgs: 23, agentMsgs: 22 });
    chatMock.mockResolvedValueOnce(llmResp(JSON.stringify({
      memories: '格式错误的记忆字段',
      session_summary: '会话摘要不因 memories 形态错误而丢失',
    })));

    await runExtraction(sid);

    expect(listSessionSummary(sid)?.summary).toBe('会话摘要不因 memories 形态错误而丢失');
    expect(countMemoriesBySource('auto')).toBe(0); // 扫描无可提取候选（外层对象无 kind）
  });
});