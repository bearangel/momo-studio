// electron/src/main/agent/runtime-entry.ts
//
// Agent runtime 子进程入口。由 runtime-manager.ts 通过 fork()/spawn() 启动，
// 配置通过环境变量 AGENT_CONFIG（JSON）传入。
//
// 启动流程：登录 Matrix → 等待首次 sync(PREPARED) → 在 team room 发"已上线" →
// 监听事件并执行完整 chat loop（LLM 思考 + 工具执行循环）。
//
// M2 集成三条能力线：
//   - Skill：启动时按 config.skills 初始化 SkillRegistry，索引注入 system prompt
//     （Layer 1），LLM 可调 loadSkill/readResource 虚拟工具展开（Layer 2/3）。
//   - MCP：工具定义启动时通过 IPC 向主进程发现（MCP Host 在主进程），调用时同样
//     走 IPC（process.send ↔ child.on('message')），工具名格式 mcp:<server>:<tool>。
//   - Dispatch：主 agent 为每个 sub agent 注册 dispatch:<slug> 工具，执行时发 dispatch
//     消息到 team room 并等待 task_reply；sub agent 监听 dispatch 事件跑 chat loop 后
//     回 task_reply。
//
// chat loop 流程（runChatLoop）：
//   1. 组装上下文（system prompt + 最近 10 条历史 + 当前消息）
//   2. 循环调用 LLM：若返回工具调用则路由执行（executeTool）并把结果回传，
//      否则返回最终文本（由调用方决定如何发送——m.room.message 或 task_reply）
//   3. 工具循环上限 MAX_TOOL_ROUNDS=10，防止 LLM 无限调用工具
//
// 注意：此入口运行在独立子进程中，不要 import 主进程模块（logger / MCP Host / DB）。
// MCP 调用通过 process.send/process.on('message') IPC 转发到主进程。统一用
// process.stdout/stderr 输出，由父进程 runtime-manager 转发到主日志。

import {
  createClient,
  ClientEvent,
  RoomEvent,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { WorkspaceFS } from '../files/workspace-fs';
import { createLLMProvider, type LLMMessage, type LLMToolCall, type LLMToolDef } from './llm-provider';
import {
  getBuiltinToolDefs,
  executeBuiltinTool,
  getVirtualToolDefs,
  getDispatchToolDefs,
  type SubAgentRef,
  type RuntimeSkillRef,
} from './builtin-tools';
import { SkillRegistry } from '../skill/registry';
import type { McpToolInfo } from '../mcp/types';
import {
  buildDispatchMessage,
  buildTaskReply,
  parseDispatchEvent,
  parseTaskReply,
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
  type DispatchContent,
} from './dispatch';

/** runtime-manager 通过 AGENT_CONFIG 传入的完整配置 */
interface RuntimeConfig {
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  teamRoomId: string;
  systemPrompt: string;
  modelProvider: 'openai' | 'anthropic';
  modelName: string;
  llmApiKey: string;
  workspaceDir: string;
  // === M2 集成 ===
  workspaceId: string;
  agentType: 'standalone' | 'main' | 'sub';
  subAgents: SubAgentRef[];
  skills: RuntimeSkillRef[];
  mcpNames: string[];
}

/** 工具调用循环上限，防止 LLM 无限调用工具导致子进程卡死 */
const MAX_TOOL_ROUNDS = 10;

/** 加载到上下文中的最近历史消息条数 */
const HISTORY_LIMIT = 10;

/** 等待子 agent task_reply 的超时时间（毫秒） */
const DISPATCH_REPLY_TIMEOUT_MS = 60_000;

/** 单次 MCP IPC 调用的超时时间（毫秒） */
const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * chat loop 运行时上下文：在启动时构建一次，后续每轮对话复用。
 * 把 SkillRegistry / 工具列表 / system prompt 等可复用状态集中管理，
 * 避免每条消息都重新发现工具或重新注册 skill。
 */
interface RuntimeContext {
  wsFs: WorkspaceFS;
  skillRegistry: SkillRegistry;
  tools: LLMToolDef[];
  /** 含 skill 索引的完整 system prompt（Layer 1 已注入） */
  systemPrompt: string;
}

/**
 * 从 AGENT_CONFIG 的 JSON 解析结果中抽取并校验配置字段。
 * M2 新增字段（agentType/subAgents/skills/mcpNames）缺省时给安全默认值，
 * 使旧版 AGENT_CONFIG 仍能正常运行（渐进式集成）。
 */
function parseConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AGENT_CONFIG 不是合法 JSON 对象');
  }
  const r = raw as Record<string, unknown>;
  const {
    botUserId,
    botAccessToken,
    homeserverUrl,
    teamRoomId,
    systemPrompt,
    modelProvider,
    modelName,
    llmApiKey,
    workspaceDir,
    workspaceId,
    agentType,
    subAgents,
    skills,
    mcpNames,
  } = r;
  if (
    typeof botUserId !== 'string' ||
    typeof botAccessToken !== 'string' ||
    typeof homeserverUrl !== 'string' ||
    typeof teamRoomId !== 'string' ||
    typeof systemPrompt !== 'string' ||
    typeof modelProvider !== 'string' ||
    typeof modelName !== 'string' ||
    typeof llmApiKey !== 'string' ||
    typeof workspaceDir !== 'string' ||
    typeof workspaceId !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（botUserId/botAccessToken/homeserverUrl/teamRoomId/' +
        'systemPrompt/modelProvider/modelName/llmApiKey/workspaceDir/workspaceId）',
    );
  }
  if (modelProvider !== 'openai' && modelProvider !== 'anthropic') {
    throw new Error(`不支持的 modelProvider: ${modelProvider}`);
  }
  // M2 字段：校验类型，缺省/不合法时用安全默认值（兼容旧配置 + 容错）
  const resolvedAgentType =
    agentType === 'main' || agentType === 'sub' ? agentType : 'standalone';
  const resolvedSubAgents = Array.isArray(subAgents)
    ? (subAgents.filter(isSubAgentRef) as SubAgentRef[])
    : [];
  const resolvedSkills = Array.isArray(skills)
    ? (skills.filter(isRuntimeSkillRef) as RuntimeSkillRef[])
    : [];
  const resolvedMcpNames = Array.isArray(mcpNames)
    ? mcpNames.filter((n): n is string => typeof n === 'string')
    : [];
  return {
    botUserId,
    botAccessToken,
    homeserverUrl,
    teamRoomId,
    systemPrompt,
    modelProvider,
    modelName,
    llmApiKey,
    workspaceDir,
    workspaceId,
    agentType: resolvedAgentType,
    subAgents: resolvedSubAgents,
    skills: resolvedSkills,
    mcpNames: resolvedMcpNames,
  };
}

/** 运行时类型守卫：SubAgentRef 必须含 slug/botUserId/description 三个字符串字段 */
function isSubAgentRef(v: unknown): v is SubAgentRef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.slug === 'string' &&
    typeof o.botUserId === 'string' &&
    typeof o.description === 'string'
  );
}

/** 运行时类型守卫：RuntimeSkillRef 必须含 slug/cachePath 两个字符串字段 */
function isRuntimeSkillRef(v: unknown): v is RuntimeSkillRef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.slug === 'string' && typeof o.cachePath === 'string';
}

async function main(): Promise<void> {
  const config = parseConfig(JSON.parse(process.env.AGENT_CONFIG ?? '{}'));

  const client: MatrixClient = createClient({
    baseUrl: config.homeserverUrl,
    userId: config.botUserId,
    accessToken: config.botAccessToken,
  });

  // 注册自动接受邀请：bot 被 owner 邀请进 team room 后需主动 join 才能收发消息。
  client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
    if (membership === 'invite') {
      void client.joinRoom(room.roomId).catch((err: unknown) => {
        process.stderr.write(`加入 room 失败 ${room.roomId}: ${(err as Error).message}\n`);
      });
    }
  });

  await client.startClient({ initialSyncLimit: 20 });
  await waitForPrepared(client);

  try {
    await client.joinRoom(config.teamRoomId);
  } catch (err) {
    process.stderr.write(`joinRoom team room 失败: ${(err as Error).message}\n`);
  }

  // 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具、合并工具列表、注入 skill 索引。
  // 在发"已上线"前完成，确保首条消息到达时工具已就绪。
  const ctx = await buildRuntimeContext(config);

  await client.sendEvent(
    config.teamRoomId,
    'm.room.message',
    { msgtype: 'm.text', body: '✅ 已上线，等待任务' },
    '',
  );

  client.on(ClientEvent.Event, (event: MatrixEvent) => {
    void handleEvent(client, event, config, ctx);
  });

  process.stdout.write('Agent runtime 已启动\n');
}

/**
 * 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具定义、合并全部工具列表、
 * 把 skill 索引注入 system prompt。单个 skill 注册失败或 MCP 发现失败均不致命——
 * 记录日志后跳过，保证 agent 仍能以剩余能力上线。
 */
async function buildRuntimeContext(config: RuntimeConfig): Promise<RuntimeContext> {
  const wsFs = new WorkspaceFS(config.workspaceDir);

  const skillRegistry = new SkillRegistry();
  for (const skill of config.skills) {
    try {
      skillRegistry.register(skill.cachePath);
    } catch (err) {
      process.stderr.write(
        `Skill ${skill.slug} 注册失败（已跳过）: ${(err as Error).message}\n`,
      );
    }
  }

  // Layer 1 渐进式披露：把 skill 索引注入 system prompt
  const skillIndex = skillRegistry.getIndex();
  const systemPrompt = skillIndex
    ? `${config.systemPrompt}

## 已安装技能索引
以下是你可用的技能。当任务匹配某技能描述时，应主动调用 loadSkill('<name>') 加载完整指令。

${skillIndex}`
    : config.systemPrompt;

  const tools: LLMToolDef[] = [
    ...getBuiltinToolDefs(),
    ...getVirtualToolDefs(skillRegistry),
    ...(await discoverMcpTools(config)),
    ...(config.agentType === 'main' ? getDispatchToolDefs(config.subAgents) : []),
  ];

  return { wsFs, skillRegistry, tools, systemPrompt };
}

/**
 * 等待客户端进入 PREPARED 同步状态（初始 sync 完成）。
 */
function waitForPrepared(client: MatrixClient): Promise<void> {
  return new Promise<void>((resolve) => {
    const handler = (state: SyncState): void => {
      if (state === SyncState.Prepared) {
        client.off(ClientEvent.Sync, handler);
        resolve();
      }
    };
    client.on(ClientEvent.Sync, handler);
  });
}

/**
 * 处理单条事件，按事件类型路由：
 *   - task_reply：匹配 pending dispatch 等待（主 agent 收到子 agent 的回执）
 *   - dispatch：子 agent 收到主 agent 的任务调度，跑 chat loop 后回 task_reply
 *   - m.room.message：仅响应 @ 提及本 bot 的消息，跑 chat loop 后回普通消息
 */
async function handleEvent(
  client: MatrixClient,
  event: MatrixEvent,
  config: RuntimeConfig,
  ctx: RuntimeContext,
): Promise<void> {
  const eventType = event.getType();
  const sender = event.getSender();

  if (eventType === TASK_REPLY_EVENT_TYPE) {
    if (sender === config.botUserId) return; // 忽略自己发的回执
    handleTaskReply(event.getContent());
    return;
  }

  if (eventType === DISPATCH_EVENT_TYPE) {
    if (sender === config.botUserId) return;
    const dispatch = parseDispatchEvent(event.getContent());
    if (!dispatch || dispatch.dispatch_to !== config.botUserId) return;
    try {
      await handleDispatch(client, event, config, ctx, dispatch);
    } catch (err) {
      process.stderr.write(`dispatch 处理异常: ${(err as Error).message}\n`);
    }
    return;
  }

  if (eventType !== 'm.room.message') return;
  if (sender === config.botUserId) return;

  const roomId = event.getRoomId();
  if (!roomId) return;

  const content = event.getContent();
  const body = typeof content.body === 'string' ? content.body : '';

  // Matrix v11 的 m.mentions 字段：{ user_ids: ['@bot:server', ...] }
  const mentions = content['m.mentions'] as { user_ids?: string[] } | undefined;
  const mentioned = mentions?.user_ids?.includes(config.botUserId) ?? false;
  if (!mentioned) return;

  try {
    const reply = await runChatLoop(client, roomId, body, config, ctx);
    await client.sendEvent(
      roomId,
      'm.room.message',
      { msgtype: 'm.text', body: reply },
      '',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`chat loop 异常: ${msg}\n`);
    await client.sendEvent(
      roomId,
      'm.room.message',
      { msgtype: 'm.text', body: `⚠️ 处理消息时出错: ${msg}` },
      '',
    );
  }
}

/**
 * 子 agent 处理主 agent 发来的 dispatch 任务：
 *   1. 回 task_reply(in_progress)
 *   2. 跑 chat loop（dispatch.body 作为用户输入）
 *   3. 把最终输出作为 task_reply(completed) 回传；失败则回 task_reply(failed)
 */
async function handleDispatch(
  client: MatrixClient,
  event: MatrixEvent,
  config: RuntimeConfig,
  ctx: RuntimeContext,
  dispatch: DispatchContent,
): Promise<void> {
  const roomId = event.getRoomId();
  if (!roomId) return;

  const inProgress = buildTaskReply({
    body: '开始处理...',
    taskId: dispatch.task_id,
    status: 'in_progress',
  });
  await client
    .sendEvent(roomId, inProgress.eventType, inProgress.content, '')
    .catch((err: unknown) => {
      process.stderr.write(`发送 in_progress 失败: ${(err as Error).message}\n`);
    });

  try {
    const result = await runChatLoop(client, roomId, dispatch.body, config, ctx);
    const completed = buildTaskReply({
      body: result,
      taskId: dispatch.task_id,
      status: 'completed',
    });
    await client.sendEvent(roomId, completed.eventType, completed.content, '');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dispatch 任务执行失败: ${msg}\n`);
    const failed = buildTaskReply({
      body: `任务失败: ${msg}`,
      taskId: dispatch.task_id,
      status: 'failed',
    });
    await client
      .sendEvent(roomId, failed.eventType, failed.content, '')
      .catch(() => {});
  }
}

/**
 * 完整 chat loop：组装上下文 → 循环调用 LLM（含工具执行）→ 返回最终文本。
 * 注意：本函数只返回最终文本，不负责发送（由调用方决定用 m.room.message 还是 task_reply）。
 */
async function runChatLoop(
  client: MatrixClient,
  roomId: string,
  currentBody: string,
  config: RuntimeConfig,
  ctx: RuntimeContext,
): Promise<string> {
  const llm = createLLMProvider(
    { provider: config.modelProvider, model: config.modelName },
    config.llmApiKey,
  );

  const messages: LLMMessage[] = [
    { role: 'system', content: ctx.systemPrompt },
    ...loadRecentHistory(client, roomId, config),
    { role: 'user', content: currentBody },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await llm.chat(messages, ctx.tools);

    if (response.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });
      for (const tc of response.toolCalls) {
        try {
          const result = await executeTool(tc, ctx, client, config);
          messages.push({ role: 'tool', content: result, toolCallId: tc.id });
        } catch (err) {
          // 工具执行失败也作为 tool result 回传，让 LLM 看到错误并自我纠正
          const errMsg = err instanceof Error ? err.message : String(err);
          messages.push({
            role: 'tool',
            content: `工具执行失败: ${errMsg}`,
            toolCallId: tc.id,
          });
        }
      }
      continue;
    }

    return response.content.trim() || '(空回复)';
  }

  process.stderr.write(`chat loop 达到 ${MAX_TOOL_ROUNDS} 轮上限仍未结束\n`);
  return `⚠️ 工具调用达到 ${MAX_TOOL_ROUNDS} 轮上限，已停止`;
}

/**
 * 统一工具执行路由：按工具名前缀分派到 builtin / 虚拟(skill) / dispatch / MCP 四类执行器。
 * 未知工具抛错（由 chat loop 捕获转成 tool result，LLM 可见并自我纠正）。
 */
async function executeTool(
  call: LLMToolCall,
  ctx: RuntimeContext,
  client: MatrixClient,
  config: RuntimeConfig,
): Promise<string> {
  const name = call.name;

  if (name === 'read_file' || name === 'write_file' || name === 'list_files') {
    return executeBuiltinTool(name, call.arguments, ctx.wsFs);
  }
  if (name === 'loadSkill') {
    return ctx.skillRegistry.loadFull(argToString(call.arguments.name, 'name'));
  }
  if (name === 'readResource') {
    const skill = argToString(call.arguments.skill, 'skill');
    const resPath = argToString(call.arguments.path, 'path');
    return ctx.skillRegistry.loadResource(skill, resPath);
  }
  if (name.startsWith('dispatch:')) {
    const subSlug = name.slice('dispatch:'.length);
    const task = argToString(call.arguments.task, 'task');
    return executeDispatch(subSlug, task, client, config);
  }
  if (name.startsWith('mcp:')) {
    // 格式 mcp:<mcpName>:<toolName>；toolName 理论上可含冒号，用剩余段拼接
    const parts = name.split(':');
    const mcpName = parts[1];
    const toolName = parts.slice(2).join(':');
    if (!mcpName || !toolName) throw new Error(`非法 MCP 工具名: ${name}`);
    return requestMcpCall(config.workspaceId, mcpName, toolName, call.arguments);
  }
  throw new Error(`未知工具: ${name}`);
}

/** 从 unknown 取 string，缺失/类型不符时抛错（给 LLM 明确反馈） */
function argToString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`参数 "${field}" 缺失或不是字符串`);
  }
  return value;
}

// === Dispatch：主 agent 等待子 agent 回执 ===

interface PendingReply {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** pending dispatch 回执：task_id → 等待中的 Promise（主 agent 发出 dispatch 后注册） */
const pendingReplies = new Map<string, PendingReply>();

/**
 * 主 agent 执行 dispatch：<slug> 工具——构建 dispatch 消息发到 team room，
 * 然后等待对应 task_id 的 task_reply（超时 DISPATCH_REPLY_TIMEOUT_MS）。
 */
async function executeDispatch(
  subSlug: string,
  task: string,
  client: MatrixClient,
  config: RuntimeConfig,
): Promise<string> {
  const sub = config.subAgents.find((s) => s.slug === subSlug);
  if (!sub) throw new Error(`未知子 agent: ${subSlug}`);

  const dispatch = buildDispatchMessage({
    body: task,
    fromBotUserId: config.botUserId,
    toBotUserId: sub.botUserId,
    deadlineMs: DISPATCH_REPLY_TIMEOUT_MS,
  });

  await client.sendEvent(config.teamRoomId, dispatch.eventType, dispatch.content, '');

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingReplies.has(dispatch.content.task_id)) {
        pendingReplies.delete(dispatch.content.task_id);
        reject(
          new Error(
            `等待子 agent ${subSlug} 回复超时（${DISPATCH_REPLY_TIMEOUT_MS / 1000}s）`,
          ),
        );
      }
    }, DISPATCH_REPLY_TIMEOUT_MS);
    pendingReplies.set(dispatch.content.task_id, { resolve, reject, timer });
  });
}

/**
 * 处理收到的 task_reply：若匹配某个 pending dispatch 则 resolve/reject 其 Promise。
 * completed → resolve(body)；其它状态（in_progress/failed/needs_input）→ reject。
 */
function handleTaskReply(content: Record<string, unknown>): void {
  const reply = parseTaskReply(content);
  if (!reply) return;
  const pending = pendingReplies.get(reply.task_id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingReplies.delete(reply.task_id);
  if (reply.status === 'completed') {
    pending.resolve(reply.body);
  } else {
    pending.reject(new Error(`子 agent 回复状态 "${reply.status}": ${reply.body}`));
  }
}

// === MCP：子进程通过 IPC 请求主进程执行 MCP 调用 ===

/**
 * 请求主进程列出某 MCP server 暴露的工具（启动时发现工具定义用）。
 * 通过 process.send 发送 mcp:listTools，监听 process('message') 等待配对响应。
 */
function requestMcpListTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]> {
  return new Promise<McpToolInfo[]>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('MCP 工具发现不可用：子进程未建立 IPC 通道'));
      return;
    }
    const id = randomId();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`MCP ${mcpName} 工具发现超时（${MCP_CALL_TIMEOUT_MS / 1000}s）`));
    }, MCP_CALL_TIMEOUT_MS);
    const handler = (msg: unknown): void => {
      const m = msg as {
        type?: string;
        id?: string;
        tools?: McpToolInfo[];
        error?: string;
      };
      if (m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        reject(new Error(m.error));
      } else {
        resolve(m.tools ?? []);
      }
    };
    process.on('message', handler);
    process.send({ type: 'mcp:listTools', id, workspaceId, mcpName });
  });
}

/** 请求主进程调用某 MCP 工具；语义同 requestMcpListTools 但走 mcp:callTool 通道 */
function requestMcpCall(
  workspaceId: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('MCP 调用不可用：子进程未建立 IPC 通道'));
      return;
    }
    const id = randomId();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`MCP ${mcpName}.${toolName} 调用超时（${MCP_CALL_TIMEOUT_MS / 1000}s）`));
    }, MCP_CALL_TIMEOUT_MS);
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; id?: string; result?: string; error?: string };
      if (m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) {
        reject(new Error(m.error));
      } else {
        resolve(m.result ?? '');
      }
    };
    process.on('message', handler);
    process.send({ type: 'mcp:callTool', id, workspaceId, mcpName, toolName, args });
  });
}

/**
 * 启动时发现全部配置 MCP server 的工具定义，转为 LLMToolDef（name 格式 mcp:<server>:<tool>）。
 * 单个 MCP 发现失败只记录日志并跳过，不阻塞 agent 上线。
 */
async function discoverMcpTools(config: RuntimeConfig): Promise<LLMToolDef[]> {
  const defs: LLMToolDef[] = [];
  for (const mcpName of config.mcpNames) {
    try {
      const tools = await requestMcpListTools(config.workspaceId, mcpName);
      for (const t of tools) {
        defs.push({
          name: `mcp:${mcpName}:${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    } catch (err) {
      process.stderr.write(
        `MCP ${mcpName} 工具发现失败（已跳过）: ${(err as Error).message}\n`,
      );
    }
  }
  return defs;
}

/** 生成短随机 id，用于 IPC 请求/响应配对 */
function randomId(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * 从 room 的 live timeline 抽取最近 HISTORY_LIMIT 条 m.room.message 历史，
 * 映射为 LLM 消息（bot 自己发的 → assistant，其他人发的 → user），按时间正序返回。
 */
function loadRecentHistory(
  client: MatrixClient,
  roomId: string,
  config: RuntimeConfig,
): LLMMessage[] {
  const room: Room | null = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline().getEvents();
  const recent = timeline.slice(-HISTORY_LIMIT - 1, -1);
  const history: LLMMessage[] = [];
  for (const e of recent) {
    if (e.getType() !== 'm.room.message') continue;
    const sender = e.getSender();
    if (!sender) continue;
    const msgContent = e.getContent();
    const msgBody = typeof msgContent.body === 'string' ? msgContent.body : '';
    if (!msgBody) continue;
    if (sender === config.botUserId) {
      history.push({ role: 'assistant', content: msgBody });
    } else {
      history.push({ role: 'user', content: msgBody });
    }
  }
  return history;
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
