// electron/tests/agent/dispatch-visibility.test.ts
//
// dispatch 工具暴露面回归锁（2026-09-07 二段修复）：
// 上一段修复让单成员快速会话的 dispatch「调用被拒」，但工具定义与教学 prompt
// 仍静态注入（spawn 快照）——agent 以为自己能委派，先 brag 再被拒（浪费一轮
// 工具调用 + 误导用户）。
//
// 修复语义：runChatLoop 每轮按「当前会话」（roomId = executionSessionId）动态过滤：
//   1. 快速/单成员会话 → chatStream 的 tools 不含任何 dispatch:* 工具，
//      system prompt 不含「任务拆分指南」——agent 不知道自己有这能力
//   2. 多成员 leader 会话 → 只暴露「当前会话成员 ∩ config.subAgents」的
//      dispatch 工具（跨会话成员不暴露）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import type { LLMMessage, LLMToolDef, StreamDelta } from '../../src/main/agent/llm-provider';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';
import type { WorkspaceFS } from '../../src/main/files/workspace-fs';

vi.mock('../../src/main/agent/llm-provider', () => ({
  createLLMProvider: vi.fn(),
}));

import { createLLMProvider } from '../../src/main/agent/llm-provider';
import {
  runChatLoop,
  type RuntimeConfig,
  type RuntimeContext,
} from '../../src/main/agent/runtime-entry';
import {
  __setMemoryProviderForTest,
  __resetMemoryProviderForTest,
  type MemoryProvider,
} from '../../src/main/memory';

const stubMemoryProvider: MemoryProvider = {
  getTaskContext: async () => null,
  getConversationContext: async () => ({ messages: [] }),
  getAgentContext: async () => ({ preferences: [], learnedPatterns: [] }),
  getUserContext: async () => ({ preferences: [] }),
  getWorkspaceContext: async () => null,
  getPinnedContext: async () => ({ hint: '', truncatedCount: 0, pinnedIds: [] }),
  searchMemories: async () => { throw new Error('测试 stub 不落库'); },
  saveMemory: async () => { throw new Error('测试 stub 不落库'); },
  deleteMemory: async () => { throw new Error('测试 stub 不落库'); },
};

const sentChunks: unknown[] = [];

/** 模拟 spawn 时静态注入的工具集：基础工具 + 两个 dispatch 工具（快照并集） */
const STATIC_TOOLS: LLMToolDef[] = [
  { name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: {} } },
  { name: 'dispatch:researcher', description: '研究员', inputSchema: { type: 'object', properties: {} } },
  { name: 'dispatch:outsider', description: '外会话成员', inputSchema: { type: 'object', properties: {} } },
];

function makeConfig(): RuntimeConfig {
  return {
    agentAssignmentId: 'inst-bot',
    agentUserId: '@bot:localhost',
    systemPrompt: 'You are a test bot.',
    modelName: 'test-model',
    llmApiKey: 'test-key',
    workspaceDir: '/tmp/test',
    workspaceId: 'ws',
    role: 'main',
    subAgents: [
      { slug: 'researcher', assignmentId: 'inst-researcher', description: '研究员' },
      { slug: 'outsider', assignmentId: 'inst-outsider', description: '外会话成员' },
    ],
    skills: [],
    mcpNames: [],
    allowedTools: [],
    deniedTools: [],
    isLeader: true, // spawn 快照：曾是某多成员会话 leader（bug 触发前提）
    devMode: false,
    maxToolCalls: -1,
  };
}

function makeContext(): RuntimeContext {
  const mockWsFs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listDir: vi.fn(),
  } as unknown as WorkspaceFS;
  return {
    wsFs: mockWsFs,
    skillRegistry: { getIndex: () => '', loadFull: () => '', loadResource: () => '', has: () => false, list: () => [], register: () => { throw new Error('unused'); } } as never,
    tools: STATIC_TOOLS,
    systemPrompt: 'You are a test bot.',
    workspaceId: 'ws',
    workspaceDir: '/tmp/test',
    roomId: '',
    streamSessionId: '',
    sendStreamChunk: (chunk: StreamChunk) => {
      sentChunks.push(chunk);
    },
    toolModules: [],
    creatorUserId: '@o',
  };
}

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-visibility-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function seedAgentInstance(instanceId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run(instanceId, instanceId, instanceId);
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, 'ws', ?, ?)`,
  ).run(instanceId, instanceId, `agent-${instanceId}`);
}

function seedSession(members: Array<{ instanceId: string; isLeader?: boolean }>): string {
  for (const m of members) seedAgentInstance(m.instanceId);
  const sess = insertSession({ workspaceId: 'ws', title: 'visibility' });
  for (const m of members) addSessionMember(sess.id, m.instanceId, m.isLeader === true);
  return sess.id;
}

/** 单轮纯文本回复的 mock chatStream；记录每次调用的 (messages, tools) */
function captureChatCalls(): Array<{ messages: LLMMessage[]; tools: LLMToolDef[] | undefined }> {
  const calls: Array<{ messages: LLMMessage[]; tools: LLMToolDef[] | undefined }> = [];
  vi.mocked(createLLMProvider).mockReturnValue({
    chat: vi.fn(),
    chatStream: vi.fn(async function* (messages: LLMMessage[], tools?: LLMToolDef[]): AsyncGenerator<StreamDelta> {
      calls.push({ messages, tools });
      yield { type: 'text', content: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    }),
  });
  return calls;
}

const originalSend = process.send;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb().prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  sentChunks.length = 0;
  __setMemoryProviderForTest(stubMemoryProvider);
  process.send = (() => true) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  __resetMemoryProviderForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('dispatch 工具暴露面（runChatLoop 按当前会话动态过滤）', () => {
  it('快速会话（单成员）→ tools 无任何 dispatch:* + system prompt 无任务拆分指南', async () => {
    const quickSess = seedSession([{ instanceId: 'inst-bot', isLeader: true }]);
    const calls = captureChatCalls();
    await runChatLoop(quickSess, '你能调度子agent吗', makeConfig(), makeContext());
    expect(calls).toHaveLength(1);
    const toolNames = (calls[0]!.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('read_file'); // 基础工具保留
    expect(toolNames.filter((n) => n.startsWith('dispatch:'))).toEqual([]); // 核心断言
    expect(calls[0]!.messages[0]!.content).not.toContain('任务拆分指南');
  });

  it('多成员 leader 会话 → 只暴露当前会话成员的 dispatch 工具（跨会话成员不暴露）', async () => {
    // researcher 在会话内；outsider 只在 config.subAgents 快照里（另一会话的成员）
    const teamSess = seedSession([
      { instanceId: 'inst-bot', isLeader: true },
      { instanceId: 'inst-researcher' },
    ]);
    const calls = captureChatCalls();
    await runChatLoop(teamSess, '拆任务', makeConfig(), makeContext());
    const toolNames = (calls[0]!.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('dispatch:researcher');
    expect(toolNames).not.toContain('dispatch:outsider'); // 跨会话成员不暴露
    expect(calls[0]!.messages[0]!.content).toContain('任务拆分指南');
    expect(calls[0]!.messages[0]!.content).toContain('dispatch:researcher');
    expect(calls[0]!.messages[0]!.content).not.toContain('dispatch:outsider');
  });

  it('多成员会话但自己不是 leader → 无 dispatch 工具 + 无指南', async () => {
    const sess = seedSession([
      { instanceId: 'inst-other', isLeader: true },
      { instanceId: 'inst-bot' },
      { instanceId: 'inst-researcher' },
    ]);
    const calls = captureChatCalls();
    await runChatLoop(sess, '帮我', makeConfig(), makeContext());
    const toolNames = (calls[0]!.tools ?? []).map((t) => t.name);
    expect(toolNames.filter((n) => n.startsWith('dispatch:'))).toEqual([]);
    expect(calls[0]!.messages[0]!.content).not.toContain('任务拆分指南');
  });
});
