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
import { randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../files/workspace-fs';
import { createLLMProvider, type LLMMessage, type LLMToolCall, type LLMToolDef } from './llm-provider';
import { logToolCall } from './tools/shared/audit';
import { assertToolAllowed } from './tools/shared/permission';
import {
  getVirtualToolDefs,
  getDispatchToolDefs,
  type SubAgentRef,
  type RuntimeSkillRef,
} from './builtin-tools';
import { buildToolRegistry, executeTool as executeToolModule, getAllToolDefs } from './tools';
import type { ToolModule, ToolContext } from './tools/types';
import { getTodosForSession } from './tools/todo-tools';
import type { TodoItem } from './tools/todo-types';
import { SkillRegistry } from '../skill/registry';
import type { McpToolInfo } from '../mcp/types';
import { sendStreamChunk, type StreamChunk } from './stream-chunk';
import {
  buildDispatchMessage,
  buildTaskReply,
  parseDispatchEvent,
  parseTaskReply,
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
  ABORT_DISPATCH_EVENT_TYPE,
  buildAbortDispatchMessage,
  type DispatchContent,
} from './dispatch';

/** 协调 agent 触发判定结果：响应或跳过 */
export type ResponseDecision = 'respond' | 'skip';

/**
 * 决定本 agent 是否响应某条团队群消息。三路互斥，不重复响应（详见 v1.1 设计 3.4）：
 *   1. 明确 @ 我 → 响应（原有路径）
 *   2. 没人被 @ + 在团队群 + 我是协调 agent + 发送者是 owner → 自动接待
 *      （仅接待 owner 的无指名消息；子 agent 的直接回复没有 m.mentions，
 *       若不限制会与"@ 别人不插嘴"冲突——协调会抢答子 agent 的回执）
 *   3. 其它（@ 了别人 / 非团队群 / 我不是协调 / 非 owner 发送） → 跳过
 */
export function decideResponse(opts: {
  mentioned: boolean;
  hasAnyMention: boolean;
  isTeamRoom: boolean;
  isCoordinator: boolean;
  isOwnerMessage: boolean;
}): ResponseDecision {
  if (opts.mentioned) return 'respond';
  if (!opts.hasAnyMention && opts.isTeamRoom && opts.isCoordinator && opts.isOwnerMessage) {
    return 'respond';
  }
  return 'skip';
}

/** 协调 agent 自动接待时的上下文提示（仅团队群无 @ 时注入用户消息前；直接 @ 时不注入） */
const COORDINATOR_AUTO_RECEPTION_HINT = `[你是本群的协调 agent。这条消息没有指名 @ 任何人，由你自动接待：
- 能自己回答的直接回答；
- 需要专项能力时用 dispatch:<子agent> 工具把子任务派给合适的子 agent，等其回传结果后汇总回复。]`;

/** runtime-manager 通过 AGENT_CONFIG 传入的完整配置 */
export interface RuntimeConfig {
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  teamRoomId: string;
  /** workspace owner 的 Matrix userId —— 仅接受此人发出的 room 邀请（防恶意 room 渗透） */
  ownerUserId: string;
  systemPrompt: string;
  // v1.3：移除 modelProvider，createLLMProvider 按 baseUrl 自动检测 platform
  modelName: string;
  modelBaseUrl?: string;
  llmApiKey: string;
  workspaceDir: string;
  // === M2 集成 ===
  workspaceId: string;
  /** v1.3 重命名（原 agentType） */
  role: 'standalone' | 'main' | 'sub';
  subAgents: SubAgentRef[];
  skills: RuntimeSkillRef[];
  mcpNames: string[];
  // === M3 工具权限白名单 ===
  /** 允许的工具名列表；空数组表示不启用白名单（全部放行，仅 deniedTools 生效） */
  allowedTools: string[];
  /** 禁止的工具名列表（优先级高于 allowedTools，命中即拒绝） */
  deniedTools: string[];
  // === v1.1 M2 协调 agent ===
  isCoordinator: boolean;
  devMode: boolean;
  // === v1.4 流式 + 工具预算 ===
  /** 工具调用上限。-1=无限, 0=禁用, N=上限。由 handleEvent/handleDispatch 通过 IPC 解析后覆盖 */
  maxToolCalls: number;
  // === v1.4 嵌套流式 ===
  /** v1.4 嵌套：bot 展示名（子 agent 嵌套 chip 头部显示，来自 agent_definitions.name） */
  botName?: string;
  /** v1.4 嵌套：bot emoji 头像（来自 agent_definitions.icon_emoji） */
  botAvatar?: string;
  // === v1.5 工具库共享上下文 ===
  /** 当前活跃的 Matrix room ID；运行时未必可知，FileTools 不消费，留空字符串兼容 */
  roomId?: string;
  /** 流式会话 ID（每条用户消息分配新 UUID）；同 roomId，FileTools 不消费 */
  streamSessionId?: string;
  /** 父 agent 流式会话 ID（v1.4 dispatch 嵌套场景）；非嵌套时为 undefined */
  parentStreamSessionId?: string;
}

/** maxToolCalls 的硬编码兜底默认值（IPC 解析失败或子进程无 process.send 时使用） */
const DEFAULT_MAX_TOOL_CALLS = 10;

/** resolveMaxToolCalls IPC 请求的超时时间（毫秒），超时后回退到 DEFAULT_MAX_TOOL_CALLS */
const RESOLVE_MAX_TOOL_CALLS_TIMEOUT_MS = 5_000;

/** 加载到上下文中的最近历史消息条数 */
const HISTORY_LIMIT = 10;

/** 渐进式 dispatch 回复超时：第一阶段 3 分钟，第二阶段 6 分钟，合计 9 分钟 */
const DISPATCH_STAGE_TIMEOUTS_MS = [180_000, 360_000];
/** dispatch 总最大等待时间（所有阶段之和） */
const DISPATCH_TOTAL_TIMEOUT_MS = DISPATCH_STAGE_TIMEOUTS_MS.reduce((a, b) => a + b, 0);

/** 单次 MCP IPC 调用的超时时间（毫秒） */
const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * chat loop 运行时上下文：在启动时构建一次，后续每轮对话复用。
 * 把 SkillRegistry / 工具列表 / system prompt 等可复用状态集中管理，
 * 避免每条消息都重新发现工具或重新注册 skill。
 */
export interface RuntimeContext {
  wsFs: WorkspaceFS;
  skillRegistry: SkillRegistry;
  tools: LLMToolDef[];
  /** 含 skill 索引的完整 system prompt（Layer 1 已注入） */
  systemPrompt: string;
  // === v1.5 工具库共享上下文（与 ToolContext 对齐，子集） ===
  /** workspace UUID——FileTools 不消费，Phase 2+ 的 git/lsp/todo 按 workspace 索引 store */
  workspaceId: string;
  /** workspace 绝对路径——Phase 2+ 的 ShellTools/GitTools 的 cwd */
  workspaceDir: string;
  /** 当前 Matrix room ID；Phase 1 FileTools 不消费 */
  roomId: string;
  /** 流式会话 ID（每条用户消息分配新 UUID）；Phase 1 FileTools 不消费 */
  streamSessionId: string;
  /** 父 agent 流式会话 ID（v1.4 dispatch 嵌套场景）；非嵌套时为 undefined */
  parentStreamSessionId?: string;
  /** 流式 chunk 推送回调（兼容 v1.4 wire format：直接 process.send(chunk)） */
  sendStreamChunk: (chunk: StreamChunk) => void;
  /** 工具模块注册表（启动时构建一次，doExecuteTool 复用） */
  toolModules: ToolModule[];
  /**
   * v1.5.1：当前 chat loop 的 abortSignal。
   * executeDispatch 监听此 signal，被中断时立即 reject（否则 PM 在 await dispatch
   * 阻塞 6 分钟渐进式超时期间无法响应停止按钮）。
   */
  abortSignal?: AbortSignal;
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
    ownerUserId,
    systemPrompt,
    modelName,
    modelBaseUrl,
    llmApiKey,
    workspaceDir,
    workspaceId,
    role,
    subAgents,
    skills,
    mcpNames,
    allowedTools,
    deniedTools,
    isCoordinator,
    devMode,
  } = r;
  if (
    typeof botUserId !== 'string' ||
    typeof botAccessToken !== 'string' ||
    typeof homeserverUrl !== 'string' ||
    typeof teamRoomId !== 'string' ||
    typeof ownerUserId !== 'string' ||
    typeof systemPrompt !== 'string' ||
    typeof modelName !== 'string' ||
    typeof llmApiKey !== 'string' ||
    typeof workspaceDir !== 'string' ||
    typeof workspaceId !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（botUserId/botAccessToken/homeserverUrl/teamRoomId/' +
        'ownerUserId/systemPrompt/modelName/llmApiKey/workspaceDir/workspaceId）',
    );
  }
  // v1.3 字段：role（原 agentType 重命名）；缺省/不合法时按 standalone 处理
  const resolvedRole =
    role === 'main' || role === 'sub' ? role : 'standalone';
  const resolvedSubAgents = Array.isArray(subAgents)
    ? (subAgents.filter(isSubAgentRef) as SubAgentRef[])
    : [];
  const resolvedSkills = Array.isArray(skills)
    ? (skills.filter(isRuntimeSkillRef) as RuntimeSkillRef[])
    : [];
  const resolvedMcpNames = Array.isArray(mcpNames)
    ? mcpNames.filter((n): n is string => typeof n === 'string')
    : [];
  // M3 工具权限：缺省/不合法时按"不限制"处理（空 allowedTools = 全放行，空 deniedTools = 无禁用）
  const resolvedAllowedTools = Array.isArray(allowedTools)
    ? allowedTools.filter((n): n is string => typeof n === 'string')
    : [];
  const resolvedDeniedTools = Array.isArray(deniedTools)
    ? deniedTools.filter((n): n is string => typeof n === 'string')
    : [];
  return {
    botUserId,
    botAccessToken,
    homeserverUrl,
    teamRoomId,
    ownerUserId,
    systemPrompt,
    modelName,
    modelBaseUrl: typeof modelBaseUrl === 'string' ? modelBaseUrl : undefined,
    llmApiKey,
    workspaceDir,
    workspaceId,
    role: resolvedRole,
    subAgents: resolvedSubAgents,
    skills: resolvedSkills,
    mcpNames: resolvedMcpNames,
    allowedTools: resolvedAllowedTools,
    deniedTools: resolvedDeniedTools,
    // v1.1 M2：缺省/类型不符时按"非协调"处理（旧配置向后兼容）
    isCoordinator: typeof isCoordinator === 'boolean' ? isCoordinator : false,
    devMode: typeof devMode === 'boolean' ? devMode : false,
    // v1.4：默认 10，由 handleEvent/handleDispatch 通过 IPC 解析后覆盖
    maxToolCalls: typeof r.maxToolCalls === 'number' ? r.maxToolCalls : 10,
    botName: typeof r.botName === 'string' ? r.botName : undefined,
    botAvatar: typeof r.botAvatar === 'string' ? r.botAvatar : undefined,
    // v1.5：roomId/streamSessionId 缺省空字符串（runtime-manager 不带 per-message 状态）；
    //   parentStreamSessionId 缺省 undefined（非嵌套场景）。FileTools 不消费此三字段。
    roomId: typeof r.roomId === 'string' ? r.roomId : '',
    streamSessionId: typeof r.streamSessionId === 'string' ? r.streamSessionId : '',
    parentStreamSessionId:
      typeof r.parentStreamSessionId === 'string' ? r.parentStreamSessionId : undefined,
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

let traceEnabled = false;

function trace(event: string, fields?: Record<string, unknown>): void {
  if (!traceEnabled) return;
  const parts = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  process.stdout.write(`${event}${parts}\n`);
}

async function main(): Promise<void> {
  const config = parseConfig(JSON.parse(process.env.AGENT_CONFIG ?? '{}'));
  traceEnabled = config.devMode;

  const client: MatrixClient = createClient({
    baseUrl: config.homeserverUrl,
    userId: config.botUserId,
    accessToken: config.botAccessToken,
  });

  // 只接受 owner 发出的邀请：bot 被邀请进恶意 room 后若 auto-join 会导致数据泄露。
  // 邀请者 = bot 的 m.room.member(invite) 事件的 sender。
  // 不用 getLiveTimeline().getEvents()——对未加入的 invite 房间该时间线为空，
  // lastEvent 恒 undefined → 误判为非 owner → 拒绝所有新房间邀请（仅团队群因启动时
  // 显式 joinRoom 而幸免）。改从 membership 事件取 sender。
  client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
    if (membership !== 'invite') return;
    const inviteEvent = room.getMember(config.botUserId)?.events.member;
    const inviter = inviteEvent?.getSender();
    if (inviter !== config.ownerUserId) {
      process.stderr.write(
        `拒绝非 owner 邀请: ${room.roomId} (inviter=${inviter ?? 'unknown'}, owner=${config.ownerUserId})\n`,
      );
      return;
    }
    process.stderr.write(`接受 owner 邀请，加入 room: ${room.roomId}\n`);
    void client.joinRoom(room.roomId).catch((err: unknown) => {
      process.stderr.write(`加入 room 失败 ${room.roomId}: ${(err as Error).message}\n`);
    });
  });

  await client.startClient({ initialSyncLimit: 20 });
  await waitForPrepared(client);

  try {
    await client.joinRoom(config.teamRoomId);
  } catch (err) {
    process.stderr.write(`joinRoom team room 失败: ${(err as Error).message}\n`);
  }

  // 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具、合并工具列表、注入 skill 索引。
  // 在注册事件监听前完成，确保首条消息到达时工具已就绪。
  const ctx = await buildRuntimeContext(config);

  client.on(ClientEvent.Event, (event: MatrixEvent) => {
    void handleEvent(client, event, config, ctx);
  });

  process.stdout.write('Agent runtime 已启动\n');
}

/**
 * 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具定义、合并全部工具列表、
 * 把 skill 索引注入 system prompt、构建工具模块注册表（v1.5）。单个 skill 注册失败或
 * MCP 发现失败均不致命——记录日志后跳过，保证 agent 仍能以剩余能力上线。
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

  const basePrompt = config.systemPrompt;

  // Layer 1 渐进式披露：把 skill 索引注入 system prompt
  const skillIndex = skillRegistry.getIndex();
  const systemPrompt = skillIndex
    ? `${basePrompt}

## 已安装技能索引
以下是你可用的技能。当任务匹配某技能描述时，应主动调用 loadSkill('<name>') 加载完整指令。

${skillIndex}`
    : basePrompt;

  // v1.5：在 buildRuntimeContext 内一次性构建工具注册中心；permissionConfig 在
  //   doExecuteTool 前置 assertToolAllowed 时校验（注册中心仅持有模块列表，不重复）。
  //   wire format 必须保持 { type, ... } 与 v1.4 一致——runtime-manager.handleChildMessage
  //   据 m.type 分发到对应渲染器，包成 { type: 'stream:chunk', chunk } 会丢 type 导致不转发。
  const toolModules = buildToolRegistry({
    wsFs,
    workspaceId: config.workspaceId,
    workspaceDir: config.workspaceDir,
    skillRegistry,
    streamSessionId: config.streamSessionId ?? '',
    parentStreamSessionId: config.parentStreamSessionId,
    roomId: config.roomId ?? '',
    sendStreamChunk,
    permissionConfig: { allowedTools: config.allowedTools, deniedTools: config.deniedTools },
  });

  const tools: LLMToolDef[] = [
    ...getAllToolDefs(toolModules),
    ...getVirtualToolDefs(skillRegistry),
    ...(await discoverMcpTools(config)),
    ...(config.role === 'main' ? getDispatchToolDefs(config.subAgents) : []),
    // v1.5.6 task_complete 主动分段——chat loop 内联处理（不走 ToolModule）。
    // 让 LLM 知道这个工具存在；执行逻辑在 runChatLoop 工具循环顶部。
    {
      name: 'task_complete',
      description: '完成本段回复并持久化为一条消息。当回复内容超过约 3KB 或完成阶段性子任务时调用，把当前累积文本作为一段发出，然后继续输出下一段。避免长回复触发 PDU 截断丢失 thinking/tool_calls。最多 5 段。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '本段内容（写入 Matrix 消息 body）',
          },
          nextStep: {
            type: 'string',
            description: '下一段要做什么（提示自己继续；可选）',
          },
        },
        required: ['summary'],
      },
    },
  ];

  return {
    wsFs,
    skillRegistry,
    tools,
    systemPrompt,
    workspaceId: config.workspaceId,
    workspaceDir: config.workspaceDir,
    roomId: config.roomId ?? '',
    streamSessionId: config.streamSessionId ?? '',
    parentStreamSessionId: config.parentStreamSessionId,
    sendStreamChunk,
    toolModules,
  };
}

/** 等待 Matrix sync 的最长时限，超时则判定 sync 不可达（避免永久挂起） */
const SYNC_TIMEOUT_MS = 60_000;

/**
 * 等待客户端进入 PREPARED 同步状态（初始 sync 完成）。
 * 加 60s 超时 + Error 状态处理：sync 一直失败时拒绝而非永久挂起。
 */
function waitForPrepared(client: MatrixClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(ClientEvent.Sync, handler);
      reject(new Error('等待 Matrix sync 超时（60s）'));
    }, SYNC_TIMEOUT_MS);

    const handler = (state: SyncState): void => {
      if (state === SyncState.Prepared) {
        clearTimeout(timeout);
        client.off(ClientEvent.Sync, handler);
        resolve();
      } else if (state === SyncState.Error) {
        clearTimeout(timeout);
        client.off(ClientEvent.Sync, handler);
        reject(new Error('Matrix sync 失败'));
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

  const roomId = event.getRoomId();
  if (!roomId) return;

  const isTeamRoom = roomId === config.teamRoomId;

  // dispatch / task_reply 仅限 team room：防恶意 room 投递伪造调度或回执。
  // m.room.message 允许任意已加入房间，但仅响应直接 @ 本 bot 的消息（decideResponse 控制）。
  if (!isTeamRoom && (eventType === DISPATCH_EVENT_TYPE || eventType === TASK_REPLY_EVENT_TYPE)) {
    return;
  }

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

  const content = event.getContent();
  const body = typeof content.body === 'string' ? content.body : '';

  // Matrix v11 的 m.mentions 字段：{ user_ids: ['@bot:server', ...] }
  const mentions = content['m.mentions'] as { user_ids?: string[] } | undefined;
  const mentioned = mentions?.user_ids?.includes(config.botUserId) ?? false;
  const hasAnyMention = (mentions?.user_ids?.length ?? 0) > 0;
  // 仅对 owner 的无指名消息自动接待，不抢答子 agent 的直接回复（其消息无 m.mentions）
  const isOwnerMessage = sender === config.ownerUserId;
  // 三路互斥触发：@我 / 没人@且我是协调且是owner / 否则跳过（详见 v1.1 设计 3.4）
  const decision = decideResponse({
    mentioned,
    hasAnyMention,
    isTeamRoom,
    isCoordinator: config.isCoordinator,
    isOwnerMessage,
  });
  if (decision === 'skip') {
    trace('→ 跳过', { reason: decision, mentioned, coordinator: config.isCoordinator });
    return;
  }

  trace('→ 决定响应', { mentioned, coordinator: config.isCoordinator });

  trace('→ 收到消息', { room: roomId.slice(0, 12), from: (sender ?? '?').slice(0, 15), body: `${body.length}字` });

  // 协调 agent 自动接待（团队群无 @）时注入上下文提示；直接 @ 时用原始消息
  const effectiveBody =
    !mentioned && config.isCoordinator
      ? `${COORDINATOR_AUTO_RECEPTION_HINT}\n\n${body}`
      : body;

  try {
    const maxToolCalls = await resolveMaxToolCalls(roomId);
    const configWithBudget: RuntimeConfig = { ...config, maxToolCalls };
    await runChatLoop(client, roomId, effectiveBody, configWithBudget, ctx);
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

  trace('→ 收到 dispatch', { from: event.getSender()?.slice(0, 15), task: `${dispatch.body.length}字` });
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
  trace('→ 发送 in_progress');

  try {
    // 预算优先级：dispatch 消息携带的 tool_budget > 房间级 IPC 解析
    const maxToolCalls =
      dispatch.tool_budget !== undefined
        ? dispatch.tool_budget
        : await resolveMaxToolCalls(roomId);
    const configWithBudget: RuntimeConfig = { ...config, maxToolCalls };
    const stats: RunChatLoopStats = { toolCallsUsed: 0 };
    // v1.4 嵌套：把 PM 生成的子 stream session ID 透传给 runChatLoop，
    // 子 agent 的 start chunk 据此关联到 PM 气泡内的 dispatch chip
    const parentStreamSessionId = dispatch.tool_stream_session_id;

    // v1.5.3：监听 team_room 的 abort_dispatch event，PM 中断时触发本地 abortController。
    // 解决时序竞态：PM 中断时本子进程可能还没注册到主进程 activeStreams，
    // 主进程的 abortStream IPC 找不到本子进程；Matrix event 兜底确保一定能收到。
    const dispatchAbort = new AbortController();
    const abortHandler = (event: MatrixEvent): void => {
      if (event.getType() !== ABORT_DISPATCH_EVENT_TYPE) return;
      const content = event.getContent() as { task_id?: string };
      if (content.task_id === dispatch.task_id) {
        dispatchAbort.abort();
      }
    };
    client.on(ClientEvent.Event, abortHandler);
    // 兜底：如果 signal 已 abort（极小概率，PM 在 sendEvent 之前就中断），立即触发
    if (dispatchAbort.signal.aborted) {
      dispatchAbort.abort();
    }

    try {
      const result = await runChatLoop(
        client,
        roomId,
        dispatch.body,
        configWithBudget,
        ctx,
        stats,
        parentStreamSessionId,
        dispatchAbort.signal,
      );
      trace('→ 发送 completed', { body: `${result.length}字`, tools: stats.toolCallsUsed });
      const completed = buildTaskReply({
        body: result,
        taskId: dispatch.task_id,
        status: 'completed',
        toolCallsUsed: stats.toolCallsUsed,
      });
      await client.sendEvent(roomId, completed.eventType, completed.content, '');
    } finally {
      client.off(ClientEvent.Event, abortHandler);
    }
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

/** runChatLoop 的统计输出（handleDispatch 据此上报 task_reply.tool_calls_used） */
export interface RunChatLoopStats {
  toolCallsUsed: number;
}

/** 持久化到 Matrix 消息的工具调用记录（renderer 渲染卡片用） */
interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  /** v1.4 嵌套：dispatch 委派标记 */
  isDispatch?: boolean;
  /** v1.4 嵌套：子 agent 流式 session ID（renderer 据此查找子 agent 的 StreamState） */
  subStreamSessionId?: string;
  /** v1.4 嵌套：子 agent 展示名 */
  subAgentName?: string;
  /** v1.4 嵌套：子 agent emoji 头像 */
  subAgentAvatar?: string;
}

/**
 * 完整 chat loop（v1.4 流式版）：组装上下文 → 循环调用 chatStream →
 * 逐 chunk 通过 process.send 推送到 renderer → 最终发送 m.room.message 持久化。
 *
 * 返回值：最终文本（handleDispatch 据此构建 task_reply body）。
 * 副作用：发送流式 chunk + 最终 m.room.message（含 thinking / tool_calls 元数据）。
 *
 * 预算管理：maxToolCalls=-1 映射 Infinity（无限），0 禁用工具（传 undefined 给 LLM），
 * N>0 递减，耗尽时发 end(budget_exhausted)。
 * 中断支持：监听 process('message') 的 abort 指令，触发 AbortController.abort()。
 */
export async function runChatLoop(
  client: MatrixClient,
  roomId: string,
  currentBody: string,
  config: RuntimeConfig,
  ctx: RuntimeContext,
  stats?: RunChatLoopStats,
  /** v1.4 嵌套：子 agent 收到 dispatch 时传入 PM 的 streamSessionId，start chunk 据此关联 */
  parentStreamSessionId?: string,
  /**
   * v1.5.3：外部 abort signal（如 handleDispatch 监听 team_room 的 abort_dispatch event）。
   * 被触发时转发到本地 abortController，统一走原有的 abort 路径（chatStream reject / 工具 catch 跳出）。
   */
  externalAbortSignal?: AbortSignal,
): Promise<string> {
  const llm = createLLMProvider(
    { model: config.modelName, baseUrl: config.modelBaseUrl },
    config.llmApiKey,
  );

  const budgetHint = formatBudgetHint(config.maxToolCalls);
  const systemContent = budgetHint
    ? ctx.systemPrompt + budgetHint
    : ctx.systemPrompt;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemContent },
    ...loadRecentHistory(client, roomId, config),
    { role: 'user', content: currentBody },
  ];

  // 子 agent（dispatch 模式）复用 PM 分配的 subStreamSessionId 作为自身 session ID，
  // 使 renderer 的 DispatchChip 能通过 streams.get(subStreamSessionId) 找到子 agent 的 StreamState。
  // 顶层 agent（普通消息）生成新 UUID。
  const streamSessionId = parentStreamSessionId ?? randomUUID();
  const maxToolCalls = config.maxToolCalls;
  let budgetRemaining = maxToolCalls === -1 ? Infinity : maxToolCalls;
  let toolCallCount = 0;
  // v1.5.6 task_complete 分段计数：每调一次 +1，超 MAX_TASK_SEGMENTS 强制结束
  let segmentCount = 0;
  const toolCallHistory: ToolCallRecord[] = [];
  let accumulatedThinking = '';
  let accumulatedText = '';

  const abortController = new AbortController();
  // v1.5.1：把 signal 暴露给 ctx，doExecuteTool 调 executeDispatch 时透传，
  // 使 PM 在 await dispatch 期间也能响应中断
  ctx.abortSignal = abortController.signal;
  // v1.5.3：转发外部 abort signal（如 handleDispatch 监听 team_room 的 abort_dispatch event）
  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) abortController.abort();
    else externalAbortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  const abortListener = (msg: unknown): void => {
    const m = msg as { type?: string; streamSessionId?: string };
    if (m.type === 'abort' && m.streamSessionId === streamSessionId) {
      abortController.abort();
    }
  };
  process.on('message', abortListener);

  sendStreamChunk({
    type: 'start',
    streamSessionId,
    roomId,
    botUserId: config.botUserId,
    // v1.4 嵌套：子 agent 携带父 session ID + 自身展示信息，renderer 据此把子流
    // 嵌套渲染到 PM 气泡内对应 dispatch chip 下方
    ...(parentStreamSessionId
      ? {
          parentStreamSessionId,
          subAgentName: config.botName,
          subAgentAvatar: config.botAvatar,
        }
      : {}),
  });

  for (let round = 0; ; round++) {
    const tools = budgetRemaining <= 0 ? undefined : ctx.tools;
    trace(`→ LLM #${round + 1}`, { model: config.modelName, msg: messages.length, tools: tools?.length ?? 0 });

    const toolCalls: LLMToolCall[] = [];
    let finishReason: 'stop' | 'tool_use' = 'stop';

    try {
      for await (const delta of llm.chatStream(messages, tools, abortController.signal)) {
        switch (delta.type) {
          case 'thinking':
            accumulatedThinking += delta.content;
            sendStreamChunk({ type: 'thinking', streamSessionId, delta: delta.content });
            break;
          case 'text':
            accumulatedText += delta.content;
            sendStreamChunk({ type: 'text', streamSessionId, delta: delta.content });
            break;
          case 'tool_use':
            toolCalls.push(delta.toolCall);
            break;
          case 'done':
            finishReason = delta.finishReason;
            break;
        }
      }
    } catch (err) {
      process.off('message', abortListener);
      if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
        sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
        if (stats) stats.toolCallsUsed = toolCallCount;
        return accumulatedText;
      }
      sendStreamChunk({
        type: 'end',
        streamSessionId,
        finishReason: 'error',
        error: (err as Error).message,
      });
      if (stats) stats.toolCallsUsed = toolCallCount;
      throw err;
    }

    if (finishReason === 'stop' || toolCalls.length === 0) {
      process.off('message', abortListener);
      const finalText = accumulatedText.trim() || '(空回复)';
      await sendFinalMessage(
        client,
        roomId,
        streamSessionId,
        finalText,
        accumulatedThinking,
        toolCallHistory,
        parentStreamSessionId,
        getTodosForSession(streamSessionId),
      );
      sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
      if (stats) stats.toolCallsUsed = toolCallCount;
      return finalText;
    }

    messages.push({ role: 'assistant', content: accumulatedText, toolCalls });

    for (const tc of toolCalls) {
      if (budgetRemaining <= 0) {
        process.off('message', abortListener);
        const finalText = accumulatedText.trim() || '(工具预算耗尽)';
        await sendFinalMessage(
          client,
          roomId,
          streamSessionId,
          finalText,
          accumulatedThinking,
          toolCallHistory,
          parentStreamSessionId,
          getTodosForSession(streamSessionId),
        );
        sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'budget_exhausted' });
        if (stats) stats.toolCallsUsed = toolCallCount;
        return finalText;
      }

      // v1.5.6：task_complete 主动分段——LLM 调此工具时持久化当前累积 text 为一条
      // Matrix 消息，然后重置 accumulatedText 继续下一段。chat loop 不退出。
      // 防止 LLM 单次回复超 PDU 64KB 触发 4 级截断丢 thinking/tool_calls/dispatches。
      if (tc.name === 'task_complete') {
        const summary = typeof tc.arguments.summary === 'string' ? tc.arguments.summary : '';
        const nextStep = typeof tc.arguments.nextStep === 'string' ? tc.arguments.nextStep : '';
        segmentCount++;
        if (segmentCount > MAX_TASK_SEGMENTS) {
          // 防无限分段：超过上限时强制结束 chat loop
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || summary || '(分段上限)';
          await sendFinalMessage(
            client, roomId, streamSessionId, finalText,
            accumulatedThinking, toolCallHistory, parentStreamSessionId,
            getTodosForSession(streamSessionId),
          );
          sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
          if (stats) stats.toolCallsUsed = toolCallCount;
          return finalText;
        }

        // 持久化当前段：summary（如有）优先，否则用 accumulatedText
        const segText = summary || accumulatedText.trim() || '(空段)';
        // 分段持久化的 session id 加后缀，避免与最终消息冲突
        const segSessionId = `${streamSessionId}#seg${segmentCount}`;
        try {
          await client.sendEvent(
            roomId,
            'm.room.message',
            {
              msgtype: 'm.text',
              body: segText,
              'io.momo-studio.stream_session_id': segSessionId,
              ...(parentStreamSessionId
                ? { 'io.momo-studio.parent_stream_session_id': parentStreamSessionId }
                : {}),
              'io.momo-studio.segment_index': segmentCount,
              'io.momo-studio.segment_of': streamSessionId,
            },
            '',
          );
        } catch (err) {
          // 持久化失败不致命：LLM 仍能继续工作，只是这一段没存到 Matrix
          console.warn(`[task_complete] 分段持久化失败：${(err as Error).message}`);
        }

        // 重置累积，让 LLM 下一轮生成新段
        accumulatedText = '';
        accumulatedThinking = '';

        // 推 stream chunk 让 renderer 知道分段了（可选 UI 提示）
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          toolName: 'task_complete',
          args: tc.arguments,
        });
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          toolName: 'task_complete',
          result: `第 ${segmentCount}/${MAX_TASK_SEGMENTS} 段已持久化。${nextStep ? `继续：${nextStep}` : '继续工作'}`,
          success: true,
        });

        // tool_result 推回 LLM，提示继续
        messages.push({
          role: 'assistant',
          content: summary,
          toolCalls: [tc],
        });
        messages.push({
          role: 'tool',
          content: `第 ${segmentCount}/${MAX_TASK_SEGMENTS} 段已发送。${nextStep ? `下一步：${nextStep}` : '请继续工作，输出到合适段落时再次调用 task_complete'}`,
          toolCallId: tc.id,
        });
        toolCallCount++;
        budgetRemaining--;
        continue;
      }

      const isDispatch = tc.name.startsWith('dispatch:');

      // v1.4 嵌套：dispatch 工具预生成子 stream session ID，发增强 tool_call chunk
      // 携带 isDispatch/subStreamSessionId/subAgentName/subAgentAvatar，renderer 据此
      // 在 PM 气泡内渲染 dispatch chip 并等待子 agent 的 start chunk 关联
      let subStreamSessionId: string | undefined;
      if (isDispatch) {
        subStreamSessionId = randomUUID();
        const subSlug = tc.name.slice('dispatch:'.length);
        const subRef = config.subAgents.find((s) => s.slug === subSlug);
        const subAgentName = subRef?.description ?? subRef?.slug ?? tc.name;
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          toolName: tc.name,
          args: tc.arguments,
          isDispatch: true,
          subStreamSessionId,
          subAgentName,
          subAgentAvatar: '🤖',
        });
      } else {
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          toolName: tc.name,
          args: tc.arguments,
        });
      }

      // dispatch 工具传剩余预算（减去本次 dispatch 本身占用的 1 次）
      let dispatchToolBudget: number | undefined;
      if (isDispatch) {
        dispatchToolBudget =
          budgetRemaining === Infinity ? -1 : Math.max(0, budgetRemaining - 1);
      }

      const dispatchInfo = isDispatch ? { toolCallsUsed: 0 } : undefined;
      let result: string;
      let success = true;
      try {
        result = await executeTool(tc, ctx, client, config, dispatchToolBudget, dispatchInfo, subStreamSessionId);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          toolName: tc.name,
          result,
          success: true,
          ...(isDispatch ? { subStatus: 'completed' as const } : {}),
        });
      } catch (err) {
        // v1.5.2: 工具因 abort 失败（executeDispatch 监听 signal 立即 reject / bash 被 SIGKILL 等）
        // 立即跳出整个 chat loop，不推 tool_result 给 LLM——否则 LLM 看到失败结果后重试，
        // 形成"中断-重试-中断"死循环（用户症状：停止按钮按下后 agent 仍持续输出）。
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || '(中断)';
          await sendFinalMessage(
            client,
            roomId,
            streamSessionId,
            finalText,
            accumulatedThinking,
            toolCallHistory,
            parentStreamSessionId,
            getTodosForSession(streamSessionId),
          );
          sendStreamChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) stats.toolCallsUsed = toolCallCount;
          return finalText;
        }

        success = false;
        const errMsg = err instanceof Error ? err.message : String(err);
        result = `工具执行失败: ${errMsg}`;
        // dispatch 超时（executeDispatch 的渐进式计时器 reject）→ 'timeout'；其它 → 'failed'
        const subStatus = isDispatch
          ? errMsg.includes('超时')
            ? ('timeout' as const)
            : ('failed' as const)
          : undefined;
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          toolName: tc.name,
          result,
          success: false,
          ...(subStatus ? { subStatus } : {}),
        });
      }

      const subAgentName = isDispatch
        ? (config.subAgents.find((s) => s.slug === tc.name.slice('dispatch:'.length))?.description
          ?? config.subAgents.find((s) => s.slug === tc.name.slice('dispatch:'.length))?.slug
          ?? tc.name)
        : undefined;
      toolCallHistory.push({
        name: tc.name, args: tc.arguments, result, success,
        ...(isDispatch ? {
          isDispatch: true,
          subStreamSessionId,
          subAgentName,
          subAgentAvatar: '🤖',
        } : {}),
      });
      toolCallCount++;
      budgetRemaining--; // dispatch 本身计 1 次
      if (dispatchInfo && dispatchInfo.toolCallsUsed > 0 && budgetRemaining !== Infinity) {
        budgetRemaining -= dispatchInfo.toolCallsUsed;
      }

      messages.push({ role: 'tool', content: result, toolCallId: tc.id });
    }
  }
}

/**
 * 格式化预算提示，注入 system prompt 末尾。
 * -1（无限）→ 不提示；0 → 禁用；N → 提示上限。
 */
export function formatBudgetHint(maxToolCalls: number): string {
  if (maxToolCalls === -1) return '';
  if (maxToolCalls === 0) return '\n\n## 工具调用预算\n本任务禁止使用任何工具。';
  return `\n\n## 工具调用预算\n本任务工具调用上限：${maxToolCalls} 次（所有参与 agent 共享此预算）。请合理规划工具使用。`;
}

/** Matrix PDU 上限 65535 字节；留 ~10KB 给协议开销，内容限制 55KB */
const MAX_EVENT_CONTENT_BYTES = 55_000;

/**
 * v1.5.6 task_complete 最大分段次数。
 * 防止 LLM 误用（每次 task_complete 都触发 sendEvent + 重置上下文，无限分段会浪费 token + 持久化垃圾）。
 * 5 段足够覆盖典型长任务（每段 ~5KB → 总 25KB，仍在 PDU 内但已分批）。
 */
const MAX_TASK_SEGMENTS = 5;

/**
 * 截断工具调用记录中的大字段：result 截到 200 字符，args 值截到 500 字符。
 * 复杂任务（如 read_file 大文件、write_file 整个文件内容）的工具记录极易撑爆 PDU。
 */
function truncateToolCallFields(calls: ToolCallRecord[]): ToolCallRecord[] {
  return calls.map((tc) => ({
    ...tc,
    result: tc.result.length > 200 ? tc.result.slice(0, 200) + '...' : tc.result,
    args: truncateArgs(tc.args),
  }));
}

/** 截断 args 对象中超过 500 字符的字符串值 */
function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 500) {
      out[key] = value.slice(0, 500) + '...';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 渐进式截断 event content，确保 JSON 序列化后不超过 MAX_EVENT_CONTENT_BYTES。
 * 降级顺序：截断工具字段 → 截断 thinking → 删除 thinking → 删除 tool_calls → 截断 body。
 * body（正文）保留优先级最低但仍兜底（最坏情况至少能发出消息，避免 sendEvent 抛错导致
 * chat loop 把 sendFinal 失败当 dispatch 失败 retry，形成死循环）。
 *
 * v1.5.5：`io.momo-studio.dispatches` 字段永不参与截断——dispatch 元数据小（每个 ~100 字节）
 * 但删除后重启 DispatchChip 完全消失。dispatch 单独存字段而非混在 tool_calls 内。
 */
function fitEventContent(
  content: Record<string, unknown>,
  thinking: string,
  toolCalls: ToolCallRecord[],
): Record<string, unknown> {
  const jsonSize = (obj: unknown): number => Buffer.byteLength(JSON.stringify(obj), 'utf-8');

  // 0级：完整内容
  if (jsonSize(content) <= MAX_EVENT_CONTENT_BYTES) return content;

  // 1级：截断工具调用中的大字段
  if (toolCalls.length > 0) {
    content['io.momo-studio.tool_calls'] = truncateToolCallFields(toolCalls);
    if (jsonSize(content) <= MAX_EVENT_CONTENT_BYTES) return content;
  }

  // 2级：截断 thinking 到 3000 字符
  if (thinking) {
    content['io.momo-studio.thinking'] = thinking.slice(0, 3000) + '\n...(思考过程已截断)';
    if (jsonSize(content) <= MAX_EVENT_CONTENT_BYTES) return content;
  }

  // 3级：删除 thinking
  delete content['io.momo-studio.thinking'];
  if (jsonSize(content) <= MAX_EVENT_CONTENT_BYTES) return content;

  // 4级：删除 tool_calls（只保留 body + dispatches）
  delete content['io.momo-studio.tool_calls'];
  if (jsonSize(content) <= MAX_EVENT_CONTENT_BYTES) return content;

  // 5级：body 截断到 10KB（最坏情况，至少能发出去，不让 sendEvent 抛错）
  const bodyStr = typeof content.body === 'string' ? content.body : '';
  if (bodyStr.length > 10_000) {
    content.body = bodyStr.slice(0, 10_000) + '\n\n...(正文已截断，原长度 ' + bodyStr.length + ' 字符)';
    delete content['io.momo-studio.todos'];
  }
  return content;
}

/**
 * 从 toolCallHistory 提取 dispatch 委派项，单独持久化到 `io.momo-studio.dispatches`。
 * 与 tool_calls 分离的原因：fitEventContent 4 级删除 tool_calls 时不会丢失 dispatch 元数据，
 * 重启后 DispatchChip 仍可还原。
 */
function extractDispatches(toolCalls: ToolCallRecord[]): Array<{
  name: string;
  success: boolean;
  subStreamSessionId?: string;
  subAgentName?: string;
  subAgentAvatar?: string;
}> {
  return toolCalls
    .filter((tc) => tc.isDispatch === true || tc.name.startsWith('dispatch:'))
    .map((tc) => ({
      name: tc.name,
      success: tc.success,
      ...(tc.subStreamSessionId ? { subStreamSessionId: tc.subStreamSessionId } : {}),
      ...(tc.subAgentName ? { subAgentName: tc.subAgentName } : {}),
      ...(tc.subAgentAvatar ? { subAgentAvatar: tc.subAgentAvatar } : {}),
    }));
}

/** v1.5.5：导出供单测验证 PDU 截断时 dispatches 字段保留 */
export const __fitEventContentForTest = fitEventContent;
export const __extractDispatchesForTest = extractDispatches;

/**
 * 发送最终 Matrix m.room.message（含持久化元数据）。
 * renderer 据此渲染 thinking 折叠区 + 工具调用卡片 + 正文。
 * 渐进式截断防止 PDU 超过 64KB 限制（复杂任务 tool_calls + thinking 可达数万字）。
 *
 * v1.5：todos 参数携带该会话的最终任务列表，写入 `io.momo-studio.todos` 字段，
 * renderer 重启后可据此还原 todo 面板（与 thinking / tool_calls 同等的持久化待遇）。
 */
async function sendFinalMessage(
  client: MatrixClient,
  roomId: string,
  streamSessionId: string,
  text: string,
  thinking: string,
  toolCalls: ToolCallRecord[],
  /** v1.4 嵌套：子 agent 的最终消息携带此字段，renderer/MessageList 据此把它嵌套到 PM 气泡 */
  parentStreamSessionId?: string,
  /** v1.5 todowrite：本会话的最终任务列表；空数组不写入（避免无意义的空字段） */
  todos?: TodoItem[],
): Promise<void> {
  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body: text,
    'io.momo-studio.stream_session_id': streamSessionId,
  };
  if (thinking) content['io.momo-studio.thinking'] = thinking;
  if (toolCalls.length > 0) content['io.momo-studio.tool_calls'] = toolCalls;
  if (parentStreamSessionId) {
    content['io.momo-studio.parent_stream_session_id'] = parentStreamSessionId;
  }
  if (todos && todos.length > 0) content['io.momo-studio.todos'] = todos;
  // v1.5.5：dispatch 单独持久化，避免 tool_calls 被 4 级截断删除时丢失
  const dispatches = extractDispatches(toolCalls);
  if (dispatches.length > 0) content['io.momo-studio.dispatches'] = dispatches;

  // 渐进式截断，确保不超 Matrix PDU 限制
  const fitted = fitEventContent(content, thinking, toolCalls);

  // v1.5.5：sendEvent 兜底——即使 fitEventContent 后仍超 PDU（极端情况），
  // 也不能让 sendFinalMessage 抛错（chat loop 会把失败当 dispatch 错误重试，死循环）。
  // 降级到 body-only 重发；仍失败则吞掉错误并打 warning（消息丢失好过死循环）。
  try {
    await client.sendEvent(roomId, 'm.room.message', fitted, '');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[sendFinalMessage] sendEvent 失败 (${errMsg})，降级到 body-only 重发`);
    const minimal: Record<string, unknown> = {
      msgtype: 'm.text',
      body: typeof fitted.body === 'string' ? fitted.body.slice(0, 10_000) : '(正文超长)',
      'io.momo-studio.stream_session_id': streamSessionId,
    };
    if (dispatches.length > 0) minimal['io.momo-studio.dispatches'] = dispatches;
    if (parentStreamSessionId) {
      minimal['io.momo-studio.parent_stream_session_id'] = parentStreamSessionId;
    }
    try {
      await client.sendEvent(roomId, 'm.room.message', minimal, '');
    } catch (err2) {
      // 极端情况（服务端故障/网络断）：吞掉错误，避免 chat loop 死循环
      console.error(
        `[sendFinalMessage] body-only 重发也失败：${err2 instanceof Error ? err2.message : String(err2)}`,
      );
    }
  }
}

/**
 * 通过 IPC 向主进程请求某房间的有效 maxToolCalls。
 * 主进程的 handler 在 Task 4 实现；在此之前超时回退到 DEFAULT_MAX_TOOL_CALLS。
 */
async function resolveMaxToolCalls(roomId: string): Promise<number> {
  if (!process.send) return DEFAULT_MAX_TOOL_CALLS;
  return new Promise<number>((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      process.off('message', handler);
      resolve(DEFAULT_MAX_TOOL_CALLS);
    }, RESOLVE_MAX_TOOL_CALLS_TIMEOUT_MS);
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; id?: string; maxToolCalls?: number };
      if (m.type === 'settings:resolved' && m.id === id) {
        clearTimeout(timer);
        process.off('message', handler);
        resolve(typeof m.maxToolCalls === 'number' ? m.maxToolCalls : DEFAULT_MAX_TOOL_CALLS);
      }
    };
    process.on('message', handler);
    process.send?.({ type: 'settings:resolveMaxToolCalls', id, roomId });
  });
}

/**
 * 统一工具执行路由（含审计插桩）：计时 + try/finally 包装 doExecuteTool，
 * 无论成功或失败都通过 IPC 发送审计日志。原路由逻辑见 doExecuteTool。
 */
async function executeTool(
  call: LLMToolCall,
  ctx: RuntimeContext,
  client: MatrixClient,
  config: RuntimeConfig,
  toolBudget?: number,
  dispatchInfo?: { toolCallsUsed: number },
  /** v1.4 嵌套：dispatch 工具的子 stream session ID，透传到 executeDispatch → buildDispatchMessage */
  toolStreamSessionId?: string,
): Promise<string> {
  const startTime = Date.now();
  let success = true;
  let output = '';
  trace(`→ 工具: ${call.name}`, { input: `${JSON.stringify(call.arguments).length}字` });
  try {
    output = await doExecuteTool(call, ctx, client, config, toolBudget, dispatchInfo, toolStreamSessionId);
    trace(`← 工具: ${call.name}`, { ms: Date.now() - startTime, ok: '✓' });
    return output;
  } catch (err) {
    success = false;
    output = err instanceof Error ? err.message : String(err);
    trace(`← 工具: ${call.name}`, { ms: Date.now() - startTime, ok: '✗' });
    throw err;
  } finally {
    logToolCall({
      toolName: call.name,
      inputSummary: JSON.stringify(call.arguments),
      outputSummary: output,
      success,
      durationMs: Date.now() - startTime,
    });
  }
}

/**
 * 统一工具执行路由：按工具名前缀分派到 builtin / 虚拟(skill) / dispatch / MCP 四类执行器。
 * 未知工具抛错（由 chat loop 捕获转成 tool result，LLM 可见并自我纠正）。
 */
export async function doExecuteTool(
  call: LLMToolCall,
  ctx: RuntimeContext,
  client: MatrixClient,
  config: RuntimeConfig,
  toolBudget?: number,
  dispatchInfo?: { toolCallsUsed: number },
  toolStreamSessionId?: string,
): Promise<string> {
  const name = call.name;

  // M3 工具权限强制：deniedTools 优先于 allowedTools。抛错由 executeTool 的审计
  // 包装捕获并记为失败，再回传给 LLM 自我纠正。判定逻辑见 tools/shared/permission.ts。
  assertToolAllowed(name, config);

  // v1.5：内置工具统一委托给 tools/index.ts 注册中心。按 ToolModule.handles() 路由——
  //   覆盖 file/search/shell/git/web/todo/lsp 全部 7 类 24 个工具（含 21 个 v1.5 新增：
  //   edit_file/mkdir/rm/mv/exists/grep/glob/bash/git_*/webfetch/todowrite/lsp_*）。
  //   必须置于 loadSkill/readResource/dispatch:/mcp: 之前——后者是带特殊路由需求的虚拟/
  //   前缀工具，与注册中心正交，不存在名字冲突（注册中心不含这些名字），故前置不会误吞。
  //   permissionConfig 在前置 assertToolAllowed 已校验，注册中心内不再重复。
  if (ctx.toolModules.some((m) => m.handles(name))) {
    const toolCtx: ToolContext = {
      wsFs: ctx.wsFs,
      workspaceId: ctx.workspaceId,
      workspaceDir: ctx.workspaceDir,
      skillRegistry: ctx.skillRegistry,
      streamSessionId: ctx.streamSessionId,
      parentStreamSessionId: ctx.parentStreamSessionId,
      roomId: ctx.roomId,
      sendStreamChunk: ctx.sendStreamChunk,
      permissionConfig: { allowedTools: config.allowedTools, deniedTools: config.deniedTools },
      // v1.5.1：长任务工具（bash/webfetch）监听此 signal，停止按钮立即生效
      abortSignal: ctx.abortSignal,
    };
    return executeToolModule(name, call.arguments, toolCtx, ctx.toolModules);
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
    // v1.5.1：传 abortSignal，PM 在 await dispatch 时也能响应停止按钮
    const dispatchResult = await executeDispatch(subSlug, task, client, config, toolBudget, toolStreamSessionId, ctx.abortSignal);
    if (dispatchInfo) dispatchInfo.toolCallsUsed = dispatchResult.toolCallsUsed;
    return dispatchResult.body;
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
  /** v1.4：resolve 携带 body + toolCallsUsed，供主 agent 扣减共享预算 */
  resolve: (value: { body: string; toolCallsUsed: number }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  stage: number;
  subSlug: string;
}

/** pending dispatch 回执：task_id → 等待中的 Promise（主 agent 发出 dispatch 后注册） */
const pendingReplies = new Map<string, PendingReply>();

/**
 * 主 agent 执行 dispatch：<slug> 工具——构建 dispatch 消息发到 team room，
 * 然后等待对应 task_id 的 task_reply（超时 DISPATCH_REPLY_TIMEOUT_MS）。
 *
 * 防竞态：必须先注册 pending 再发送消息。若先发送后注册，子 agent 极快回执时
 * task_reply 会在 pending.set 之前到达，handleTaskReply 找不到 pending 导致回执丢失。
 */
export async function executeDispatch(
  subSlug: string,
  task: string,
  client: MatrixClient,
  config: RuntimeConfig,
  toolBudget?: number,
  /** v1.4 嵌套：子 agent 流 session ID，写入 dispatch 消息供子 agent 关联 PM 气泡 */
  toolStreamSessionId?: string,
  /**
   * v1.5.1：PM chat loop 的 abortSignal。被 abort 时立即 reject（清理 pendingReplies），
   * 否则 PM 会阻塞到渐进式超时（3+6=9 分钟）才退出，期间停止按钮无效。
   */
  signal?: AbortSignal,
): Promise<{ body: string; toolCallsUsed: number }> {
  const sub = config.subAgents.find((s) => s.slug === subSlug);
  if (!sub) throw new Error(`未知子 agent: ${subSlug}`);

  trace('→ dispatch', { target: subSlug, task: `${task.length}字`, budget: toolBudget });

  const dispatch = buildDispatchMessage({
    body: task,
    fromBotUserId: config.botUserId,
    toBotUserId: sub.botUserId,
    deadlineMs: DISPATCH_TOTAL_TIMEOUT_MS,
    toolBudget,
    toolStreamSessionId,
  });

  // 先注册 pending，再发送——防竞态
  const resultPromise = new Promise<{ body: string; toolCallsUsed: number }>((resolve, reject) => {
    pendingReplies.set(dispatch.content.task_id, {
      resolve,
      reject,
      timer: setTimeout(() => {}, 0), // 占位，armDispatchTimer 会替换
      stage: 0,
      subSlug,
    });
    armDispatchTimer(dispatch.content.task_id);

    // v1.5.1：监听 abortSignal，被中断时立即清理 + reject（不等渐进式超时）
    if (signal) {
      const onAbort = (): void => {
        const entry = pendingReplies.get(dispatch.content.task_id);
        if (entry) {
          clearTimeout(entry.timer);
          pendingReplies.delete(dispatch.content.task_id);
        }
        // v1.5.3：发 abort_dispatch event 兜底通知子 agent。
        // 子 agent 此时可能还没启动 + 注册到主进程 activeStreams，主进程的 abortStream 找不到它；
        // Matrix event 持久化保证子 agent 后续启动时也能收到并终止。
        const abortEvt = buildAbortDispatchMessage({
          taskId: dispatch.content.task_id,
          subStreamSessionId: toolStreamSessionId,
        });
        client.sendEvent(config.teamRoomId, abortEvt.eventType, abortEvt.content, '').catch(() => {
          // Matrix 发送失败不影响 PM 本地的 abort 流程
        });
        const err = new Error('dispatch 被中断');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  await client.sendEvent(config.teamRoomId, dispatch.eventType, dispatch.content, '');

  return resultPromise;
}

/**
 * 渐进式超时计时器管理：
 * stage 0 → 等待 3 分钟 → 超时则进入 stage 1
 * stage 1 → 等待 6 分钟 → 超时则最终判失败
 * 收到 in_progress 时调用此函数重置当前阶段计时器。
 */
function armDispatchTimer(taskId: string): void {
  const pending = pendingReplies.get(taskId);
  if (!pending) return;
  clearTimeout(pending.timer);
  const timeoutMs = DISPATCH_STAGE_TIMEOUTS_MS[pending.stage];
  if (timeoutMs === undefined) return;
  pending.timer = setTimeout(() => {
    if (pending.stage < DISPATCH_STAGE_TIMEOUTS_MS.length - 1) {
      pending.stage++;
      console.log(`[dispatch] 等待 ${pending.subSlug} 超时，进入第 ${pending.stage + 1} 阶段`, { taskId });
      armDispatchTimer(taskId);
    } else {
      pendingReplies.delete(taskId);
      const totalMin = Math.round(DISPATCH_TOTAL_TIMEOUT_MS / 60000);
      pending.reject(new Error(
        `等待子 agent ${pending.subSlug} 回复超时（已等待 ${totalMin} 分钟）。任务可能仍在后台执行，请直接查看该 agent 的回复。`,
      ));
    }
  }, timeoutMs);
}

/**
 * 处理收到的 task_reply：若匹配某个 pending dispatch 则 resolve/reject 其 Promise。
 * in_progress → 进度通知，保持 pending（子 agent 处理中途合法地先发此状态）；
 * completed → resolve(body)；failed/needs_input → reject。
 */
export function handleTaskReply(content: Record<string, unknown>): void {
  const reply = parseTaskReply(content);
  if (!reply) return;
  const pending = pendingReplies.get(reply.task_id);
  if (!pending) {
    console.warn(`[dispatch] 收到迟到的 task_reply（taskId=${reply.task_id}, status=${reply.status}）— 已超时或已处理`);
    return;
  }
  if (reply.status === 'in_progress') {
    trace('← reply: in_progress');
    armDispatchTimer(reply.task_id);
    return;
  }
  trace('← reply', { status: reply.status, body: `${reply.body.length}字` });
  clearTimeout(pending.timer);
  pendingReplies.delete(reply.task_id);
  if (reply.status === 'completed') {
    pending.resolve({ body: reply.body, toolCallsUsed: reply.tool_calls_used ?? 0 });
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

// 仅在被 runtime-manager fork（注入 AGENT_CONFIG 环境变量）时启动主流程；
// 其它场景（如单测 import 本模块以测 decideResponse 纯函数）不触发 main()，
// 避免在缺少配置时 parseConfig 抛错 → process.exit(1) 把测试进程一并杀掉。
if (process.env.AGENT_CONFIG !== undefined) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
