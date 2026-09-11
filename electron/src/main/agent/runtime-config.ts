// electron/src/main/agent/runtime-config.ts
//
// Agent runtime 子进程配置类型——Task 13 从 runtime-manager.ts（v1 双轨，已删除）
// 迁出。spawn 站点（ipc.handlers / init-runtime）经 buildSpawnOpts 构造本配置，
// 经 AGENT_CONFIG 环境变量 JSON 序列化传入子进程（runtime-entry parseConfig 消费）。

import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import { isThinkingRequest, type ThinkingRequest } from '../llm/provider-presets';

/** 启动 agent 子进程所需的全部配置，会以 JSON 序列化后通过 AGENT_CONFIG 传递 */
export interface AgentRuntimeOpts {
  instanceId: string;
  workspaceId: string;
  workspaceDir: string;
  /**
   * v2（Task 10）：本地身份取代 Matrix 凭据
   * （botUserId/botAccessToken/homeserverUrl/ownerUserId/teamRoomId 已删除）。
   * agentAssignmentId 与 instanceId 同值（显式命名，供子进程侧区分语义）；
   * agentUserId 为展示名映射键。
   * v25（Task 15）：workspace 级团队会话 id 字段随团队会话概念退役删除——
   * dispatch/abort 目标会话一律用当前 executionSessionId（P0-8 语义定型）。
   */
  agentAssignmentId: string;
  agentUserId: string;
  systemPrompt: string;
  /** v1.3：传 modelName + modelBaseUrl + llmApiKey 给 runtime */
  modelName: string;
  modelBaseUrl?: string;
  /**
   * P3 Task 1：显式透传供应商 platform（'openai' | 'anthropic'），
   * 由 spawn-helpers buildSpawnOpts 从 model_providers.platform 列读取并注入。
   * undefined 时保持 v1.3 兼容——createLLMProvider 按 baseUrl 启发式检测
   * （存量 RuntimeConfig / 老单元测试不入此字段）。
   */
  modelPlatform?: 'openai' | 'anthropic';
  llmApiKey: string;
  // === v1.3 重命名（原 agentType） ===
  /** agent 角色，决定是否注册 dispatch 工具与监听 dispatch 事件；缺省按 standalone 处理 */
  role?: 'standalone' | 'main' | 'sub';
  /** 主 agent 名下的子 agent 列表（仅 role='main' 时有意义），用于构建 dispatch:<slug> 工具 */
  subAgents?: SubAgentRef[];
  /** 已安装 skill 引用，子进程启动时据此初始化 SkillRegistry */
  skills?: RuntimeSkillRef[];
  /** 该 agent 可用的 MCP server 名列表，工具定义在启动时通过 IPC 向主进程发现 */
  mcpNames?: string[];
  // === M3 工具权限白名单 ===
  /** 允许的工具名列表；空/缺省 = 不启用白名单（全部放行） */
  allowedTools?: string[];
  /** 禁止的工具名列表（优先级高于 allowedTools） */
  deniedTools?: string[];
  // === v25 会话快照（原 v1.1 M2 isCoordinator 改名，语义更换） ===
  /**
   * 会话快照判定：本实例是至少一个「有效成员数 > 1」会话的 is_leader
   * （spec §4.7 dispatch 注入条件；由 buildDispatchSnapshot 在 spawn 时
   * 计算并随 AGENT_CONFIG 定型）。旧「workspace 默认 agent」语义
   * 已随 v25 接待路由切会话 leader 而退役。
   */
  isLeader?: boolean;
  /** dev 模式标志（由 spawn 侧根据 !app.isPackaged 自动注入） */
  devMode?: boolean;
  // === v1.4 嵌套流式 ===
  /** bot 展示名（子 agent 嵌套时 chip 头部显示，来自 agent_definitions.name） */
  botName?: string;
  /** bot emoji 头像（来自 agent_definitions.icon_emoji） */
  botAvatar?: string;
  // === 压缩重构（spec 2026-09-09 §2.3）===
  /** 模型上下文窗口（token）；0=未知（fail-safe：不做自动阈值压缩）。由 buildSpawnOpts 经 resolveModelLimits 解析后注入 */
  contextWindow?: number;
  /** 模型最大输出 token；0=未知 */
  outputTokens?: number;
  // === 供应商预设（spec 2026-09-09-provider-presets）===
  /** 思维模式配置（resolveThinkingConfig 产出；缺省=不发任何 thinking 参数） */
  thinking?: ThinkingRequest;
}

/** runtime-spawner 通过 AGENT_CONFIG 传入的完整配置 */
export interface RuntimeConfig {
  /** v2（Task 10）：本地身份三件套（取代 botUserId/botAccessToken/homeserverUrl/teamRoomId/ownerUserId） */
  agentAssignmentId: string;
  /** agent 本地身份（agent_user_id；展示名映射 + 内部事件 sender） */
  agentUserId: string;
  systemPrompt: string;
  // v1.3 曾移除 modelProvider；P3 起 platform 经 modelPlatform 显式传入，缺省时才回退 baseUrl 启发式检测
  modelName: string;
  modelBaseUrl?: string;
  /**
   * P3 Task 1：显式透传供应商 platform，由 spawn-helpers 从 model_providers.platform 注入。
   * undefined 时回退到 v1.3 行为——createLLMProvider 按 baseUrl 启发式检测（兼容存量配置）。
   */
  modelPlatform?: 'openai' | 'anthropic';
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
  // === v25 会话快照（原 v1.1 M2 isCoordinator 改名） ===
  /** dispatch 注入条件：多成员会话 leader（spawn 时会话快照，spec §4.7） */
  isLeader: boolean;
  devMode: boolean;
  // === v1.4 流式 + 工具预算 ===
  /** 工具调用上限。-1=无限, 0=禁用, N=上限。runTaskChatLoop 按 dispatchContext.tool_budget 覆盖 */
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
  /** v2（B 子系统 Task B11）：当前关联的任务 ID（来自 task-driven runtime 派发），用于向 MemoryProvider 拉 task 上下文注入 system prompt */
  currentTaskId?: string;
  // === 压缩重构（spec 2026-09-09 §2.3）===
  /** 模型上下文窗口（token）；0=未知（auto 阈值压缩 fail-safe 跳过） */
  contextWindow: number;
  /** 模型最大输出 token；0=未知 */
  outputTokens: number;
  /** 思维模式配置；undefined=不发任何 thinking 参数（旧配置兼容） */
  thinking?: ThinkingRequest;
}

/**
 * v2（task-driven 切换 Task T3）：task-config IPC 消息体。
 *
 * 由主进程 AgentRunner.executeTask 通过 child.send({ type: 'task-config', ... }) 注入，
 * runtime 收到后调用 runTaskChatLoop 启动 chat loop。
 *
 * 与 agent-runner.ts 的 TaskConfig 字段保持兼容（taskId / executionSessionId / body /
 * streamSessionId / mentions），额外加 dispatchContext 承载 PM dispatch 时的父 agent 上下文。
 */
export interface TaskConfig {
  type: 'task-config';
  /** task 主键；null = ephemeral chat（非 task 调度的即时对话） */
  taskId: string | null;
  /** 执行房间 ID（agent 在此房间输出流式回复 + 持久化最终 m.room.message） */
  executionSessionId: string;
  /** 用户输入的正文（替代 v1 的 Matrix event body） */
  body: string;
  /** 流式会话 ID（贯穿 start→end chunk 的唯一标识；由 AgentRunner 分配，不在此处 randomUUID） */
  streamSessionId: string;
  /** 消息 metadata（mentions 等）；当前 runTaskChatLoop 不消费，留给后续 RouterService 扩展 */
  mentions?: string[];
  /**
   * dispatch 模式：父 agent（PM）派来的任务上下文。
   * 设置时本 task 是 sub-agent 收到 PM 的 dispatch；
   * 未设置时是顶层用户消息触发的即时对话。
   */
  dispatchContext?: {
    /** PM 的 assignmentId（dispatch event 的 dispatch_from） */
    fromAssignmentId: string;
    /** dispatch event 的 task_id（用于回 task_reply 关联） */
    task_id: string;
    /** PM 分配给本 sub-agent 的工具预算 */
    tool_budget?: number;
    /** PM 的 streamSessionId（用于 renderer 把子 agent 流嵌套渲染到 PM 气泡内对应 dispatch chip 下方） */
    tool_stream_session_id?: string;
  };
  /**
   * v2.2 修复（会话工具预算接线）：主进程按 executionSessionId 现解析的有效
   * 工具预算（sessions.settings_json.maxToolCalls → global_settings.maxToolCalls），
   * 每条消息派发时随 task-config 下发——修改会话/全局设置后下一条消息即生效，
   * 不受 warm runtime AGENT_CONFIG 定型影响。优先级低于 dispatchContext.tool_budget；
   * 缺省时回退 AGENT_CONFIG 的 maxToolCalls（parseConfig 默认 10）。
   */
  maxToolCalls?: number;
  /**
   * v2.6.0 断点续跑（spec §5.2/§5.4）：断点回合重建段载荷。设置时
   * runTaskChatLoop 把 messages 拼到 LLM 请求（不重复发 currentBody）、
   * 预算续扣 toolCallsUsed、未消费 steers 重放进 pendingSteers。
   * 缺省时 runChatLoop 行为与历史版本一致（既有 11 个调用点零改动）。
   */
  resume?: {
    /** 重建段 LLMMessage[]；首条 role=user 即原回合指令 */
    messages: import('./llm-provider').LLMMessage[];
    /** 断点前已消耗的工具预算（rebuildTurn.toolCallsUsed） */
    toolCallsUsed: number;
    /** 中断前未消费的中途补充（spec §5.3：流末无后续输出的 steer 入此数组） */
    steers: string[];
    /** 主进程 rebuildTurn 已评估；runtime 侧无需再判（沿用 main 决议） */
    degenerate: boolean;
  };
}

/**
 * 从 AGENT_CONFIG 的 JSON 解析结果中抽取并校验配置字段。
 * M2 新增字段（agentType/subAgents/skills/mcpNames）缺省时给安全默认值，
 * 使旧版 AGENT_CONFIG 仍能正常运行（渐进式集成）。
 */
export function parseConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AGENT_CONFIG 不是合法 JSON 对象');
  }
  const r = raw as Record<string, unknown>;
  const {
    agentAssignmentId,
    agentUserId,
    systemPrompt,
    modelName,
    modelBaseUrl,
    llmApiKey,
    modelPlatform,
    workspaceDir,
    workspaceId,
    role,
    subAgents,
    skills,
    mcpNames,
    allowedTools,
    deniedTools,
    isLeader,
    devMode,
  } = r;
  if (
    typeof agentAssignmentId !== 'string' ||
    typeof agentUserId !== 'string' ||
    typeof systemPrompt !== 'string' ||
    typeof modelName !== 'string' ||
    typeof llmApiKey !== 'string' ||
    typeof workspaceDir !== 'string' ||
    typeof workspaceId !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（agentAssignmentId/agentUserId/' +
        'systemPrompt/modelName/llmApiKey/workspaceDir/workspaceId）',
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
    agentAssignmentId,
    agentUserId,
    systemPrompt,
    modelName,
    modelBaseUrl: typeof modelBaseUrl === 'string' ? modelBaseUrl : undefined,
    // P3 Task 1：modelPlatform 仅在合法字面量时透传，否则保持 undefined 触发 baseUrl 启发式
    modelPlatform:
      modelPlatform === 'openai' || modelPlatform === 'anthropic'
        ? modelPlatform
        : undefined,
    llmApiKey,
    workspaceDir,
    workspaceId,
    role: resolvedRole,
    subAgents: resolvedSubAgents,
    skills: resolvedSkills,
    mcpNames: resolvedMcpNames,
    allowedTools: resolvedAllowedTools,
    deniedTools: resolvedDeniedTools,
    // v25：isLeader 缺省/类型不符时按「非 leader」处理（旧配置无旧兼容负担）
    isLeader: typeof isLeader === 'boolean' ? isLeader : false,
    devMode: typeof devMode === 'boolean' ? devMode : false,
    // v1.4：默认 10；dispatch 任务由 dispatchContext.tool_budget 覆盖
    maxToolCalls: typeof r.maxToolCalls === 'number' ? r.maxToolCalls : 10,
    botName: typeof r.botName === 'string' ? r.botName : undefined,
    botAvatar: typeof r.botAvatar === 'string' ? r.botAvatar : undefined,
    // v1.5：roomId/streamSessionId 缺省空字符串（spawn 时不带 per-message 状态）；
    //   parentStreamSessionId 缺省 undefined（非嵌套场景）。FileTools 不消费此三字段。
    roomId: typeof r.roomId === 'string' ? r.roomId : '',
    streamSessionId: typeof r.streamSessionId === 'string' ? r.streamSessionId : '',
    parentStreamSessionId:
      typeof r.parentStreamSessionId === 'string' ? r.parentStreamSessionId : undefined,
    currentTaskId:
      typeof r.currentTaskId === 'string' && r.currentTaskId.length > 0
        ? r.currentTaskId
        : undefined,
    // 压缩重构：窗口元数据缺省/非法按 0（未知）处理——旧 AGENT_CONFIG 兼容 + fail-safe
    contextWindow: typeof r.contextWindow === 'number' && r.contextWindow > 0 ? r.contextWindow : 0,
    outputTokens: typeof r.outputTokens === 'number' && r.outputTokens > 0 ? r.outputTokens : 0,
    // 供应商预设：thinking 结构守卫失败 → undefined（不发参数，fail-safe）
    thinking: isThinkingRequest(r.thinking) ? r.thinking : undefined,
  };
}

/** 运行时类型守卫：SubAgentRef 必须含 slug/assignmentId/description 三个字符串字段 */
function isSubAgentRef(v: unknown): v is SubAgentRef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.slug === 'string' &&
    typeof o.assignmentId === 'string' &&
    typeof o.description === 'string'
  );
}

/** 运行时类型守卫：RuntimeSkillRef 必须含 slug/cachePath 两个字符串字段 */
function isRuntimeSkillRef(v: unknown): v is RuntimeSkillRef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.slug === 'string' && typeof o.cachePath === 'string';
}

