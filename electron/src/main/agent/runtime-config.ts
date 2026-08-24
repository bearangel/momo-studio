// electron/src/main/agent/runtime-config.ts
//
// Agent runtime 子进程配置类型——Task 13 从 runtime-manager.ts（v1 双轨，已删除）
// 迁出。spawn 站点（ipc.handlers / init-runtime）经 buildSpawnOpts 构造本配置，
// 经 AGENT_CONFIG 环境变量 JSON 序列化传入子进程（runtime-entry parseConfig 消费）。

import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';

/** 启动 agent 子进程所需的全部配置，会以 JSON 序列化后通过 AGENT_CONFIG 传递 */
export interface AgentRuntimeOpts {
  instanceId: string;
  workspaceId: string;
  workspaceDir: string;
  /**
   * v2（Task 10）：本地身份三件套取代 Matrix 凭据五件套
   * （botUserId/botAccessToken/homeserverUrl/ownerUserId/teamRoomId 已删除）。
   * agentAssignmentId 与 instanceId 同值（显式命名，供子进程侧区分语义）；
   * agentUserId 为展示名映射键；teamSessionId 为团队会话（sessions 表）ID。
   */
  agentAssignmentId: string;
  agentUserId: string;
  teamSessionId: string;
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
  // === v1.1 M2 协调 agent ===
  /** 本实例是否为所属 workspace 的协调 agent（团队群非@消息由其接待） */
  isCoordinator?: boolean;
  /** dev 模式标志（由 spawn 侧根据 !app.isPackaged 自动注入） */
  devMode?: boolean;
  // === v1.4 嵌套流式 ===
  /** bot 展示名（子 agent 嵌套时 chip 头部显示，来自 agent_definitions.name） */
  botName?: string;
  /** bot emoji 头像（来自 agent_definitions.icon_emoji） */
  botAvatar?: string;
}

/** runtime-spawner 通过 AGENT_CONFIG 传入的完整配置 */
export interface RuntimeConfig {
  /** v2（Task 10）：本地身份三件套（取代 botUserId/botAccessToken/homeserverUrl/teamRoomId/ownerUserId） */
  agentAssignmentId: string;
  /** agent 本地身份（agent_user_id；展示名映射 + 内部事件 sender） */
  agentUserId: string;
  /** 团队会话 ID（sessions 表主键；dispatch/abort 的目标会话） */
  teamSessionId: string;
  systemPrompt: string;
  // v1.3：移除 modelProvider，createLLMProvider 按 baseUrl 自动检测 platform
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
  // === v1.1 M2 协调 agent ===
  isCoordinator: boolean;
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
   * 未设置时是顶层用户消息触发的 ephemeral chat。
   */
  dispatchContext?: {
    /** PM 的 assignmentId（dispatch event 的 dispatch_from） */
    fromAssignmentId: string;
    /** dispatch event 的 task_id（用于回 task_reply 关联） */
    task_id: string;
    /** PM 分配给本 sub-agent 的工具预算 */
    tool_budget?: number;
    /** PM 的 streamSessionId（用于 renderer 把子 agent 流嵌套渲染到 PM 气泡内对应 chip 下方） */
    tool_stream_session_id?: string;
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
    teamSessionId,
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
    isCoordinator,
    devMode,
  } = r;
  if (
    typeof agentAssignmentId !== 'string' ||
    typeof agentUserId !== 'string' ||
    typeof teamSessionId !== 'string' ||
    typeof systemPrompt !== 'string' ||
    typeof modelName !== 'string' ||
    typeof llmApiKey !== 'string' ||
    typeof workspaceDir !== 'string' ||
    typeof workspaceId !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（agentAssignmentId/agentUserId/teamSessionId/' +
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
    teamSessionId,
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
    // v1.1 M2：缺省/类型不符时按"非协调"处理（旧配置向后兼容）
    isCoordinator: typeof isCoordinator === 'boolean' ? isCoordinator : false,
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

