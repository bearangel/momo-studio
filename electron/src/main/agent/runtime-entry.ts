// electron/src/main/agent/runtime-entry.ts
//
// Agent runtime 子进程入口（task-driven 单轨）。由 runtime-spawner.ts fork 启动，
// 配置经 AGENT_CONFIG（JSON）传入；入站经 task-config / task-reply / shutdown IPC，
// 出站 dispatch/task_reply/abort 经内部事件桥（child IPC → 主进程 RouterService），
// 最终消息由 chunk 路径落 SQLite。
//
// 能力线：Skill（SkillRegistry + 虚拟工具）/ MCP（IPC 桥发现与调用，见 mcp-bridge.ts）/
// Dispatch（dispatch:<slug> 工具 + pending 等待，见 dispatch-wait.ts）。
// chat loop：组装上下文 → 循环 LLM + 工具执行（预算 -1/0/N）→ 流式 chunk。
//
// 注意：此入口运行在独立子进程中，不要 import 主进程模块（logger / MCP Host / DB）。
// 统一用 process.stdout/stderr 输出，由父进程 runtime-spawner 转发到主日志。

import { randomUUID } from 'node:crypto';
import { WorkspaceFS } from '../files/workspace-fs';
import { createLLMProvider, type LLMMessage, type LLMToolCall, type LLMToolDef } from './llm-provider';
import { parseConfig, type RuntimeConfig, type TaskConfig } from './runtime-config';
import { formatBudgetHint, formatDispatchHint, formatTaskHint, buildMandateHint } from './prompt-hints';
import { logToolCall } from './tools/shared/audit';
import { assertToolAllowed } from './tools/shared/permission';
import {
  estimateTokens,
  estimateConversation,
  COMPACTION_BUFFER_TOKENS,
  COMPACTION_KEEP_TOKENS,
  COMPACTION_MIN_TRIGGER,
} from './tools/shared/token-estimate';
import { serializeMessages } from '../compaction/serialize';
import { getWorkspace } from '../workspace/crud';
import {
  getVirtualToolDefs,
  getDispatchToolDefs,
  getOrchestrationToolDefs,
  getBuiltinLoopToolDefs,
} from './builtin-tools';
import { buildToolRegistry, executeTool as executeToolModule, getAllToolDefs } from './tools';
import type { ToolModule, ToolContext } from './tools/types';
import { ReadTracker } from './tools/shared/read-tracker';
import { SkillRegistry } from '../skill/registry';
import { sendStreamChunk, type StreamChunk } from './stream-chunk';
// v2.6.0 断点续跑：仅取类型（import type 编译期擦除）——turn-reconstructor
// 传递依赖 logger / storage（主进程模块），本子进程入口不引入运行时耦合
import type { RebuiltTurn } from './turn-reconstructor';
import { discoverMcpTools, requestMcpCall } from './mcp-bridge';
import { buildTaskReply } from './dispatch';
// v2（P1 Task 5）：内部事件桥——dispatch/task_reply/abort_dispatch 经 child IPC
// 直达主进程 RouterService，取代 Matrix 自定义 event 传输
import { sendTaskReplyEvent } from './internal-event';
import {
  executeDispatch,
  executeDispatchBg,
  executeFollowup,
  executeGather,
  executeStatus,
  executeCancel,
  handleTaskReplyIpc,
  setDispatchTraceEnabled,
  getSessionDispatchScope,
} from './dispatch-wait';
import { getMemoryProvider, type ConversationContext, type TaskContext } from '../memory';
import { getTodosForSession } from './tools/todo-tools';
import type { TodoItem } from './tools/todo-types';
import { getDb } from '../storage/db';
import { setJournalStore } from '../journal/recorder';
import { createJournalStore } from '../journal/store';

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
  /** v2.3 任务工具注入：creatorUserId 从 workspaces.owner_id 派生，LLM 不可覆盖 */
  creatorUserId: string;
  /**
   * v1.5.1：当前 chat loop 的 abortSignal。
   * executeDispatch 监听此 signal，被中断时立即 reject（否则 PM 在 await dispatch
   * 阻塞 6 分钟渐进式超时期间无法响应停止按钮）。
   */
  abortSignal?: AbortSignal;
}

let traceEnabled = false;

// v2.3 Read-before-Edit：进程级 ReadTracker 单例。
// task-driven runtime = 一任务一进程（WarmPool.release 也是销毁不复用），进程退出即
// 生命周期终点，故无需 clear()。buildRuntimeContext 与 doExecuteTool 两处 ctx 组装点
// 共用此实例，保证 read 标记（read_file）与守门判定（edit_file / write_file）落在
// 同一存储上——此前两处均未注入，可选链静默失效导致守门在生产 no-op（终审 C1）。
const readTracker = new ReadTracker();

// ─── 压缩合成条前缀（spec §6.1/§6.2 + Task 4 审查交接） ─────────────────────
//
// 三类「role=user 但非真实用户发言」的合成条。两个跳过点共用本清单（防漂移）：
//   1. head 序列化跳过：主进程已从 DB 读 prior 摘要合并进新摘要——再序列化
//      这些条目 = prior 双重计入；
//   2. 尾部选择锚定跳过： mandate 锚点必须是真实用户消息，锚到合成条会把
//      当前 user 消息误判进可压缩区（切断 mandate 所在轮）。
const COMPACTION_SYNTHETIC_USER_PREFIXES = [
  '[此前对话压缩摘要]',   // 主进程 getConversationContext 注入的 prior 摘要（T4）
  '[历史压缩摘要]',       // 本回合内压缩产出的摘要条
  '[系统] 上下文已自动压缩', // auto 压缩后的续行合成条（spec §6.2）
] as const;

/** mandate 锚点/序列化共用的合成条判定：role=user 且 content 命中任一前缀 */
function isSyntheticUserMessage(m: LLMMessage): boolean {
  return (
    m.role === 'user' &&
    COMPACTION_SYNTHETIC_USER_PREFIXES.some((p) => m.content.startsWith(p))
  );
}

/** auto 压缩后的续行合成条全文（spec §6.2 逐字） */
const AUTO_COMPACT_NOTICE =
  '[系统] 上下文已自动压缩。若仍有未完成的用户请求步骤请继续；否则输出总结并停下。';

/**
 * provider 上下文溢出错误特征（spec §7，T6）：错误信息命中即视为「上下文超限」，
 * 可尝试压缩恢复。措辞覆盖 OpenAI（maximum context length / too many tokens）与
 * Anthropic（prompt is too long / token limit exceeded）的典型 4xx 报错。
 * `.{0,20}` 有界距离：避免 'token ... 一大段无关文本 ... limit' 的过拟合误吞。
 */
const OVERFLOW_ERROR_RE = /context|token.{0,20}(limit|exceed)|maximum.{0,20}length|too (long|many)/i;

/** runCompaction 的结果：成功携带计数与双态判定（tool result 文案消费） */
type CompactionRunResult =
  | { ok: true; beforeCount: number; tailCount: number; mandateGated: boolean; pendingUser: boolean }
  | { ok: false; error: string };

function trace(event: string, fields?: Record<string, unknown>): void {
  if (!traceEnabled) return;
  const parts = fields
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  process.stdout.write(`${event}${parts}\n`);
}

// ─── 压缩 IPC 桥（spec §4.4） ────────────────────────────────────────────────
//
// 桥实现已迁出至 compaction-ipc.ts（压缩改造 Task 5：requestCompaction 是
// compact 工具/auto 阈值共用的 IPC 副作用边界，独立模块便于测试在边界 mock）。
// 此处 re-export 维持既有导入路径（tests/compaction/ipc-bridge.test.ts 经
// runtime-entry 导入三符号）——不改变任何行为。
export {
  requestCompaction,
  handleCompactionResultIpc,
  COMPACTION_REQUEST_TIMEOUT_MS,
} from './compaction-ipc';
import { requestCompaction, handleCompactionResultIpc } from './compaction-ipc';

async function main(): Promise<void> {
  const config = parseConfig(JSON.parse(process.env.AGENT_CONFIG ?? '{}'));
  traceEnabled = config.devMode;
  setDispatchTraceEnabled(config.devMode);

  // v2.5 变更账本：子进程内直接开 SQLite WAL 连接记账（MemoryTools getDb()
  // 同款生产形态——audit 桥注释的「无法访问主进程连接」指内存单例不可跨进程，
  // 文件级 WAL 多进程访问是 memory 工具既有先例）。注入失败仅降级跳过记账
  // （change-journal 的 warn-once 路径），不阻塞 agent 启动——安全网自身
  // 不能变成故障点。
  try {
    setJournalStore(createJournalStore(getDb()));
  } catch (err) {
    process.stderr.write(`变更账本 store 初始化失败（记账降级）: ${(err as Error).message}\n`);
  }

  const ctx = await buildRuntimeContext(config);
  process.stdout.write('Agent runtime 已启动（task-driven 模式）\n');

  // task-config IPC handler：主进程 AgentRunner.executeTask 通过 child.send({type:'task-config',...})
  // 注入 task 配置，runtime 收到后调 runTaskChatLoop 跑一次 chat loop 并退出。
  // task-reply IPC handler：主进程 AgentRunner.notifyTaskReply 转发的子 agent 回执，
  // 经 handleTaskReplyIpc 消费（resolve 本进程 pendingReplies 里的 dispatch promise）。
  // shutdown handler：runtime-spawner.stopRuntime 发此消息优雅退出。
  const taskMessageListener = async (msg: unknown): Promise<void> => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: string };

    if (m.type === 'task-config') {
      try {
        await runTaskChatLoop(msg as TaskConfig, config, ctx);
      } catch (err) {
        process.stderr.write(`task-config 处理失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
    } else if (m.type === 'task-reply') {
      handleTaskReplyIpc(msg);
    } else if (m.type === 'compaction:result') {
      handleCompactionResultIpc(msg);
    } else if (m.type === 'shutdown') {
      process.stdout.write('收到 shutdown 信号，退出 runtime\n');
      process.exit(0);
    }
  };
  process.on('message', taskMessageListener);
}


/**
 * 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具定义、合并全部工具列表、
 * 把 skill 索引注入 system prompt、构建工具模块注册表（v1.5）。单个 skill 注册失败或
 * MCP 发现失败均不致命——记录日志后跳过，保证 agent 仍能以剩余能力上线。
 *
 * v25 Task 10 导出：dispatch 快照契约测试以本函数为真实消费者
 * （生产者 buildSpawnOpts 产出 → AGENT_CONFIG 线协议 → 此处注册 dispatch 工具）。
 */
export async function buildRuntimeContext(config: RuntimeConfig): Promise<RuntimeContext> {
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
  //   wire format 必须保持 { type, ... }——主进程 handleChildMessage 据 m.type
  //   分发，包成 { type: 'stream:chunk', chunk } 会丢 type 导致不转发。
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
    // v2.3 任务工具注入：creatorUserId 从 workspaces.owner_id 派生，LLM 不可覆盖
    creatorUserId: getWorkspace(config.workspaceId)?.ownerId ?? 'unknown',
    // v2.3 Read-before-Edit：进程级单例注入（终审 C1——缺此字段守门静默失效）
    readTracker,
  });

  const tools: LLMToolDef[] = [
    ...getAllToolDefs(toolModules),
    ...getVirtualToolDefs(skillRegistry),
    ...(await discoverMcpTools(config)),
    // v25 Task 10（spec §4.7）：dispatch 注入条件 = 会话快照判定
    // （isLeader && subAgents 非空，取代 v1 role==='main'）
    ...(config.isLeader && config.subAgents.length > 0
      ? getDispatchToolDefs(config.subAgents)
      : []),
    ...getBuiltinLoopToolDefs(),
  ];

  // v1.7.1 修复：把动态注册的工具（loadSkill / readResource / dispatch:* / mcp:*
  // / task_complete / compact）加进 allowedTools 白名单。
  // 否则 v1.6 T4 修复 allowedTools 真正生效后，这些虚拟/动态工具虽暴露给 LLM
  // 但调用时被 permission.ts 拒绝（"工具 X 不在允许列表中"）。
  // 这些工具的暴露本身已受控（有 skill 才暴露 loadSkill；main 才暴露 dispatch:*；
  // 配置 MCP 才暴露 mcp:*），故加入白名单不削弱安全模型——它们是 agent 能力配置的
  // 直接体现，与 read_file/bash 等内置工具同等地位。
  if (config.allowedTools.length > 0) {
    const dynamicNames = tools.map((t) => t.name);
    config.allowedTools = [...new Set([...config.allowedTools, ...dynamicNames])];
  }

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
    creatorUserId: getWorkspace(config.workspaceId)?.ownerId ?? 'unknown',
  };
}

/**
 * runChatLoop 的统计输出（handleDispatch 据此上报 task_reply.tool_calls_used）。
 * endChunkSent / aborted 是 runChatLoop → runTaskChatLoop 的单向出参：
 *   - endChunkSent：本轮是否已发过 end chunk（runTaskChatLoop 错误兜底
 *     据此防重——旧实现 LLM 错误路径连发两个 end chunk，renderer 聚合混乱）
 *   - aborted：是否因 abort（AbortError / 外部 signal）提前返回
 *     （runTaskChatLoop 据此把 dispatch 回执 status 从 completed 改为 failed）
 */
export interface RunChatLoopStats {
  toolCallsUsed: number;
  endChunkSent?: boolean;
  aborted?: boolean;
}

/**
 * 完整 chat loop（流式）：组装上下文 → 循环调用 chatStream → 逐 chunk 通过
 * process.send 推送（renderer 中继 + SQLite 落盘由主进程 chunk 路径承载）。
 *
 * 返回值：最终文本（runTaskChatLoop 据此构建 task_reply body）。
 * 副作用：发送流式 chunk（start/thinking/text/tool_call/tool_result/end）。
 *
 * 预算管理：maxToolCalls=-1 映射 Infinity（无限），0 禁用工具（传 undefined 给 LLM），
 * N>0 递减，耗尽时发 end(budget_exhausted)。
 * 中断支持：监听 process('message') 的 abort 指令，触发 AbortController.abort()。
 */
export async function runChatLoop(
  roomId: string,
  currentBody: string,
  config: RuntimeConfig,
  ctx: RuntimeContext,
  stats?: RunChatLoopStats,
  /** 嵌套：子 agent 收到 dispatch 时传入 PM 的 streamSessionId，start chunk 据此关联 */
  parentStreamSessionId?: string,
  /**
   * v1.5.3：外部 abort signal。被触发时转发到本地 abortController，
   * 统一走原有的 abort 路径（chatStream reject / 工具 catch 跳出）。
   */
  externalAbortSignal?: AbortSignal,
  /**
   * v2（task-driven 切换 T3）：由 AgentRunner 分配的 streamSessionId。
   * 优先级：streamSessionIdOverride > parentStreamSessionId > randomUUID()。
   */
  streamSessionIdOverride?: string,
  /**
   * v2.6.0 断点续跑（plan Task 4）：断点回合重建段（T1 rebuildTurn 产物，由
   * T5 resumeTask 经 TaskConfig.resume 载荷透传到这里）。存在且重建段非空时：
   * messages 直接拼重建段（不追加 currentBody）、预算续扣 toolCallsUsed、
   * 未消费 steer 重放；缺省或重建段为空时行为与历史版本一致。
   */
  resumeTurn?: RebuiltTurn,
  /**
   * v2.8.0 Orchestration 元语（Task 2）：followup 续聊前缀——上游把先前回合
   * 上下文（LLMMessage[]）拼进本轮请求。无 resumeTurn 时拼接在 system 之后、
   * convMessages 之前（fresh session 下 convMessages 恒空，实际形态
   * [system, ...前缀, user(currentBody)]）；与 resumeTurn 互斥（派发侧保证），
   * 同现时 resumeTurn 优先、前缀忽略 + warn。缺省时行为与历史版本逐字节一致。
   */
  historyPrefix?: LLMMessage[],
): Promise<string> {
  const llm = createLLMProvider(
    // P3 Task 1：modelPlatform 显式透传（来自 buildSpawnOpts provider.platform）。
    // undefined 时 createLLMProvider 退回到 baseUrl 启发式（v1.3 兼容路径）。
    { model: config.modelName, baseUrl: config.modelBaseUrl, ...(config.modelPlatform ? { provider: config.modelPlatform } : {}) },
    config.llmApiKey,
    // 供应商预设：思维配置随 AGENT_CONFIG 定型（缺省 = 不发参数）
    config.thinking ? { thinking: config.thinking } : undefined,
  );

  const budgetHint = formatBudgetHint(config.maxToolCalls);
  // 会话边界二段修复（2026-09-07）：dispatch 工具集与教学 prompt 按「当前会话」
  // （roomId）动态过滤——spawn 快照是实例级（跨会话并集），单成员快速会话若只靠
  // 执行时拒绝，agent 仍会以为自己能委派（先 brag 再被拒，浪费一轮 + 误导用户）。
  // 不满足会话边界时工具与指南根本不注入，LLM 不知道自己有这能力。
  const sessionSubs = getSessionDispatchScope(roomId, config);
  // 注入门统一 length 判定（T7 Minor 修正）：getSessionDispatchScope 的 filter
  // 可返回空数组（多成员会话 + 自己是 leader + subAgents 快照与会话成员交集为空），
  // 而 [] 在 JS 为 truthy——若 hint 门判 length、工具门判 truthy，即出现
  // 「无教学 hint 却注入 4 个静态编排工具」的门不一致。全部注入门收敛到同一布尔。
  const hasSessionSubs = sessionSubs !== null && sessionSubs.length > 0;
  const dispatchHint = formatDispatchHint({
    ...config,
    isLeader: hasSessionSubs,
    subAgents: sessionSubs ?? [],
  });
  // v2.8.0 Orchestration（Task 7）：5 类编排工具 defs（4 静态 + dispatch_bg:<slug>
  // 随成员动态）——与 dispatch:<slug> 同门（sessionSubs 非空才注入，非 leader 会话
  // 工具与教学 prompt 均不出现，LLM 不知道自己有这能力）。
  const orchestrationDefs = hasSessionSubs ? getOrchestrationToolDefs(sessionSubs) : [];
  // 白名单同步：编排工具仅在下方 chatTools 组装层注入（逐轮），不经
  // buildRuntimeContext 的动态工具名扩充（那里只覆盖启动时静态快照）——带
  // allowedTools 白名单的 leader 若不同步，调用编排工具会被 assertToolAllowed
  // 拒绝。注入即授权，同 dispatch:* 白名单先例（v1.7.1）。
  if (hasSessionSubs && config.allowedTools.length > 0) {
    config.allowedTools = [
      ...new Set([...config.allowedTools, ...orchestrationDefs.map((t) => t.name)]),
    ];
  }

  // v2（B 子系统 Task B11）：MemoryProvider 取代 loadRecentHistory。
  // 子 agent（parentStreamSessionId 非空）走 fresh session 不拉房间历史，
  // 故原 v1.7.4 dispatchModeHint 字符串提示移除——fresh 行为由空 convCtx 自然实现。
  const memory = getMemoryProvider();
  const [taskCtx, convCtx]: [TaskContext | null, ConversationContext] = await Promise.all([
    config.currentTaskId ? memory.getTaskContext(config.currentTaskId) : Promise.resolve(null),
    parentStreamSessionId
      ? Promise.resolve({ messages: [] })
      : memory.getConversationContext(roomId, { limit: 20 }),
  ]);

  const taskHint = taskCtx ? formatTaskHint(taskCtx) : '';
  // v2.2：三层记忆常驻注入（spec §6.3）——每轮现拉，UI 修改下一条消息即生效；
  // 子 agent（parentStreamSessionId 非空）不带会话记忆（fresh-session 语义对齐）
  const pinnedMem = await memory.getPinnedContext({
    workspaceId: config.workspaceId,
    sessionId: parentStreamSessionId ? null : roomId,
  });
  // 子 agent（dispatch 模式）复用 PM 分配的 subStreamSessionId 作为自身 session ID，
  // 使 renderer 的 DispatchChip 能通过 streams.get(subStreamSessionId) 找到子 agent 的 StreamState。
  // 顶层 agent（普通消息）生成新 UUID。
  // v2 task-driven：AgentRunner 通过 streamSessionIdOverride 传入预分配的 session ID（替代 randomUUID）。
  // turn-mandate Task 3：提前到此处声明，让 assembly 区 buildMandateHint 闭包可引用。
  const streamSessionId = streamSessionIdOverride ?? parentStreamSessionId ?? randomUUID();
  // turn-mandate Task 3（spec §2「每轮重写」）：static 段一次组装；
  // mandate 尾段每轮基于 mandate 状态对象重写——
  // 「中途补充」与「未完成项」保持实时跨压缩存活
  const staticSystem = ctx.systemPrompt + budgetHint + dispatchHint + taskHint + pinnedMem.hint;
  // v2.6.0 断点续跑：mandate.userBody 取重建段首条 user 消息正文（原回合指令）；
  // 首条非 user（dispatch 子流重建段可能 assistant 开头，T1 兜底语义）或重建段
  // 为空时回退 currentBody（恢复载荷的 body 兜底）
  const resumeFirst = resumeTurn?.messages[0];
  const mandate = {
    userBody: resumeFirst && resumeFirst.role === 'user' ? resumeFirst.content : currentBody,
    steers: [] as string[],
  };
  const refreshSystem = (): void => {
    messages[0] = {
      role: 'system',
      content: staticSystem + buildMandateHint({ ...mandate, streamSessionId }),
    };
  };
  // turn mandate（spec §5.1/§5.2）：与 todo-tools.hasPendingUserTodos 同谓词的本地取数
  // 闭包——compact 双态的布尔判定与文案里的条数 K 共用同一份过滤（单一来源，
  // 防两份过滤条件漂移导致「判定说有、文案说无」）。谓词：source=user 且未完成。
  const pendingUserItems = (): TodoItem[] =>
    getTodosForSession(streamSessionId).filter(
      (t) => t.status !== 'completed' && t.source === 'user',
    );

  // ─── 压缩统一执行体（spec §6.1，compact 工具触发与 auto 阈值共用） ──────────
  /** 单条消息估算成本：content + assistant 工具调用 JSON（与 estimateConversation 同口径） */
  const messageTokens = (m: LLMMessage): number => {
    let t = estimateTokens(m.content ?? '');
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        t += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments));
      }
    }
    return t;
  };

  /**
   * 执行一次完整压缩流程（spec §6.1 五步）：
   *   ① 尾部选择：从 messages 末尾向前按 KEEP 预算累计——锚点（最后一条真实
   *      user 消息，跳过合成条）未覆盖前预算不截断（不得切断当前 user 消息与
   *      mandate 所在轮），覆盖后超预算即停（保护最近若干轮完整回合 verbatim）；
   *      切点不得落在 role:'tool' 消息上（工具对原子性——孤儿 tool 消息会被
   *      provider 400 拒绝）
   *   ② head 序列化（跳过合成摘要条——主进程已读 DB prior，防双重计入）
   *   ③ coveredUntil = head 末条真实消息的已知 createdAt（见下），随
   *      requestCompaction IPC 上报主进程 upsert
   *   ④ 成功：messages = [system, user(摘要+双态尾部指令), ...尾部 verbatim]，
   *      按 mandate 双态置 wrapUpMode，refreshSystem 重建 mandate 段
   *   ⑤ 失败：messages 原样不动，返回 ok:false（调用方决定报错/降级）
   *
   * head 为空（全部消息落尾部保留预算内）时无物可压，返回 ok:false——
   * auto 路径自然跳过，工具路径向 LLM 报「无需压缩」。
   *
   * coveredUntil 语义（T5 遗留 Important-1 修复）：created_at ≤ coveredUntil 的
   * 历史已被摘要覆盖，下轮收缩（getConversationContext 的 afterTs 过滤）不再
   * 拉取。取「尾部起始前一条（head 末条）的已知时刻」而非压缩时刻 Date.now()——
   * 压缩时刻必然晚于本轮已落库的尾部消息，用当下时刻会把未摘要的尾部消息一并
   * 过滤（未摘要却消失）。head 末条：convCtx 来源 → 精确 timestamp（convTimes
   * 命中）；回合内消息 → turnStart - 1（回合内消息 createdAt ≥ turnStart，
   * -1 保证严格小于恒安全；锚点保护下当前 user 消息若入 head 则已被摘要，
   * 覆盖它语义正确）。合成条无 DB 行，跳过。
   */
  const runCompaction = async (): Promise<CompactionRunResult> => {
    const body = messages.slice(1); // system（messages[0]）不参与尾部选择，永不压缩

    // mandate 锚点：最后一条真实 user 消息（跳过三类合成条，防锚到摘要条上）
    let anchorIdx = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i]!.role === 'user' && !isSyntheticUserMessage(body[i]!)) {
        anchorIdx = i;
        break;
      }
    }

    let acc = 0;
    let tailStart = body.length;
    for (let i = body.length - 1; i >= 0; i--) {
      const cost = messageTokens(body[i]!);
      const anchorCovered = anchorIdx < 0 || tailStart <= anchorIdx;
      if (anchorCovered && acc + cost > COMPACTION_KEEP_TOKENS) {
        // 工具对原子性（审查 Critical）：切点（tailStart = i+1）落在 role:'tool'
        // 消息上 = 制造孤儿——协议中 tool 结果紧随所属 assistant，其 assistant
        // 必在 head 侧，OpenAI/Anthropic 请求体均硬性 400。此情形不 break，
        // 继续纳入直到切点移出 tool 边界（不计预算，同锚点保护语义——
        // 正确性优先于预算上限）。
        if (body[i + 1]?.role !== 'tool') break;
      }
      acc += cost;
      tailStart = i;
    }

    const head = body.slice(0, tailStart).filter((m) => !isSyntheticUserMessage(m));
    if (head.length === 0) {
      return { ok: false, error: '无可压缩的更早历史（当前轮已全部位于尾部保留预算内）' };
    }

    // coveredUntil：从切点向前找 head 末条真实消息（跳过合成条）的已知时刻。
    // head 非空保证循环必然命中；防御性兜底取 turnStart - 1。
    let coveredUntil = turnStart - 1;
    for (let i = tailStart - 1; i >= 0; i--) {
      const m = body[i]!;
      if (isSyntheticUserMessage(m)) continue;
      coveredUntil = convTimes.get(m) ?? turnStart - 1;
      break;
    }

    let summary: string;
    try {
      summary = await requestCompaction(roomId, serializeMessages(head), coveredUntil);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // 双态判定（沿 turn-mandate spec §5.1）：仅顶层 chat 路径 mandate 门控；
    // task 域 / dispatch 子路径维持「基于总结继续当前任务」中性语义
    const mandateGated = parentStreamSessionId == null && !config.currentTaskId;
    const pendingItems = pendingUserItems();
    const pendingUser = mandateGated && pendingItems.length > 0;
    wrapUpMode = mandateGated && !pendingUser;

    const tailDirective = pendingUser
      ? '[历史已压缩。本轮仍有用户请求的未完成工作，请继续完成]'
      : mandateGated
        ? '[本轮用户请求已无未完成项，请输出简短总结后结束本轮，不要开始新工作]'
        : '[历史已压缩。请基于总结继续当前任务]';

    const beforeCount = messages.length;
    const tail = body.slice(tailStart);
    const systemMsg = messages[0]!;
    messages.length = 0;
    messages.push(systemMsg);
    messages.push({
      role: 'user',
      content: `[历史压缩摘要]\n${summary}\n\n${tailDirective}`,
    });
    messages.push(...tail);
    // 压缩清空了历史，基于当前 todo 状态重写 system（mandate 段实时，spec §2）
    refreshSystem();
    return { ok: true, beforeCount, tailCount: tail.length, mandateGated, pendingUser };
  };

  const convMessages: LLMMessage[] = convCtx.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // ─── coveredUntil 精确化支撑（T5 遗留 Important-1，T6 修复） ────────────────
  // 回合开始时刻：回合内生成消息（assistant/tool/steer）的 DB 落库时刻下界——
  // LLM 首轮请求发生在 turnStart 之后，chunk 路径落库只会更晚。
  const turnStart = Date.now();
  // convCtx 来源消息的精确 DB createdAt（ContextMessage.timestamp）。WeakMap 按
  // 引用跟随：runCompaction 重建 messages 数组后，尾部的 convCtx 条目仍携带
  // 精确时刻；查不到 = 回合内消息 → 保守取 turnStart - 1（见 runCompaction）。
  const convTimes = new WeakMap<LLMMessage, number>();
  convCtx.messages.forEach((m, i) => convTimes.set(convMessages[i]!, m.timestamp));

  // v2.6.0 断点续跑：resumeTurn 存在且重建段非空 → 重建段 verbatim 拼接
  // （首条即原 user 消息，T1 保证），不追加 currentBody（防指令重复）；
  // 重建段为空（degenerate 兜底，等价全新回合）或无 resumeTurn → currentBody
  // 作为本轮 user 消息（与历史行为逐字节一致）
  const turnMessages: LLMMessage[] =
    resumeTurn && resumeTurn.messages.length > 0
      ? resumeTurn.messages
      : [{ role: 'user', content: currentBody }];
  // v2.8.0 Orchestration 元语（Task 2）：followup 续聊前缀拼接。与 resumeTurn
  // 互斥由派发侧保证，此处防御性兜底：同现时 resumeTurn 优先（前缀忽略 +
  // warn 不抛错——断点续跑的重建段语义完整自洽，与「全新回合的上下文补充」
  // 混拼会产生双重历史）；空数组等价无前缀（展开零副作用）
  let effectivePrefix: LLMMessage[] = [];
  if (historyPrefix) {
    if (resumeTurn) {
      process.stderr.write(
        'historyPrefix 与 resumeTurn 同现：resumeTurn 优先，historyPrefix 前缀已忽略\n',
      );
    } else {
      effectivePrefix = historyPrefix;
    }
  }
  const messages: LLMMessage[] = [
    { role: 'system', content: '' }, // 占位，refreshSystem 立即填充
    ...effectivePrefix,
    ...convMessages,
    ...turnMessages,
  ];
  refreshSystem();
  const maxToolCalls = config.maxToolCalls;
  // v2.6.0 断点续跑：预算续扣——断点前已消耗的 toolCallsUsed 预先扣除
  // （Math.max 钳制 ≥0，防 toolCallsUsed 越过上限时出现负预算）；-1 无限保持
  let budgetRemaining =
    maxToolCalls === -1
      ? Infinity
      : resumeTurn
        ? Math.max(0, maxToolCalls - resumeTurn.toolCallsUsed)
        : maxToolCalls;
  let toolCallCount = 0;
  // v1.5.6 task_complete 分段计数：每调一次 +1，超 MAX_TASK_SEGMENTS 强制结束
  let segmentCount = 0;
  let accumulatedText = '';
  // turn mandate（spec §5.1）：收尾模式标记——置位后下一轮 LLM 请求不传 tools，
  // 模型无工具可调只能输出终文，回合机械终止。仅顶层 chat 路径的 compact 分支
  // 置位；steer drain 出新指令时清除（新指令优先于收尾）。回合级内存状态，
  // 随回合结束消亡。
  let wrapUpMode = false;
  // 溢出恢复标记（spec §7，T6）：回合级——本回合内只允许一次「溢出 → 压缩 →
  // 重放」恢复，二次溢出按原错误路径终止（防「压缩-重放-再溢出」死循环）。
  let overflowRecovered = false;

  const abortController = new AbortController();
  // v1.5.1：把 signal 暴露给 ctx，doExecuteTool 调 executeDispatch 时透传，
  // 使 PM 在 await dispatch 期间也能响应中断
  ctx.abortSignal = abortController.signal;
  // v1.5.3：转发外部 abort signal（如 handleDispatch 监听 team_room 的 abort_dispatch event）
  if (externalAbortSignal) {
    if (externalAbortSignal.aborted) abortController.abort();
    else externalAbortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  // v2.3 steer：与 abort 同监听器（共享全部 process.off 清理点）——
  // push 进闭包队列，chat loop 每轮构建 LLM 请求前 drain（spec §5.2）
  const pendingSteers: string[] = [];
  // v2.6.0 断点续跑：未消费 steer 重放——断点前到达但从未进入 LLM 上下文的
  // 中途补充重放进 pendingSteers，经既有 drain 路径注入（user 消息 / mandate
  // 同步 / steer 事件落库三件事由 drain 统一完成）。不在此预写 mandate.steers：
  // drain 循环自身会 push，预写 = mandate 段与溢出重放双份重复
  if (resumeTurn && resumeTurn.steers.length > 0) {
    pendingSteers.push(...resumeTurn.steers);
  }
  // v2.3.1 消息滚动：自上次 roll 后是否产过新文本——drain 时据此决定是否换行
  //（防「连续 steer 在同一等待期」产生空新行，spec §2.2）
  let hasNewTextSinceLastRoll = false;
  const abortListener = (msg: unknown): void => {
    const m = msg as { type?: string; streamSessionId?: string; body?: unknown };
    if (m.streamSessionId !== streamSessionId) return;
    if (m.type === 'abort') {
      abortController.abort();
      return;
    }
    if (m.type === 'steer' && typeof m.body === 'string') {
      pendingSteers.push(m.body);
    }
  };
  process.on('message', abortListener);

  // minor-7：end chunk 统一经此发送并标记 stats.endChunkSent——
  // runTaskChatLoop 的错误兜底据此防重（否则 LLM 错误路径连发两个 end）
  const sendEndChunk = (chunk: Extract<StreamChunk, { type: 'end' }>): void => {
    sendStreamChunk(chunk);
    if (stats) stats.endChunkSent = true;
  };

  // v2.8.0 链路打标（Task 5）：任务板任务（currentTaskId）或 dispatch 链（chainTaskId）——
  // start chunk 携带 taskId，主进程 stream-relay 据此给该流全部消息行落 messages.task_id
  // （rebuildSubConversation / read_task_progress 的查询键）。普通 chat 流（两者皆无）
  // 不带字段，wire 协议零变化。currentTaskId 优先（同设时任务板语义为准）。
  const tagTaskId = config.currentTaskId ?? config.chainTaskId;

  sendStreamChunk({
    type: 'start',
    streamSessionId,
    // Task 6 字段迁移：roomId→sessionId、botUserId→senderAgentId。
    // v2（Task 10）：值 = agent 本地身份 agentUserId（messages.sender 落库 +
    // renderer botNameMap 据此解析展示名）
    sessionId: roomId,
    senderAgentId: config.agentUserId,
    ...(tagTaskId ? { taskId: tagTaskId } : {}),
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

  // v1.5.6: 循环检测——记录最近工具调用，连续重复 N 次强制终止
  const recentToolCallSignatures: string[] = [];
  const MAX_DUPLICATE_TOOLS = 3;

  /**
   * v2 dispatch 并行（docs/specs/2026-08-25-dispatch-parallel-design.md §4.1）：
   * 单个 dispatch 工具调用的执行体——并发批次的成员。
   * 同步段：预生成 subStreamSessionId + 发 tool_call chip（批次启动时 K 个 chip 即刻全部出现，
   *   P0-7 查找键语义不变——renderer DispatchChip 据此关联子流）。
   * 异步段：executeTool（内部 executeDispatch 发内部事件等 task_reply）→ settle 时发 tool_result chip。
   * 非 abort 错误转 result 字符串返回（allSettled 不短路，LLM 下一轮可见自行纠正，与串行语义一致）；
   * abort 错误原样 reject（批次边界统一走中断退出，不回填 tool result——防「中断-重试」死循环）。
   */
  const execDispatchCall = (
    tc: LLMToolCall,
    /** 段级均分 sub-budget（D3）：段前预算 - 段长；-1 = 无限 */
    subBudget: number,
    /** 本成员独立的回执计数（§6.3 禁止跨成员共享对象，预算追扣据此） */
    dispatchInfo: { toolCallsUsed: number },
  ): Promise<string> => {
    const subStreamSessionId = randomUUID();
    const subSlug = tc.name.slice('dispatch:'.length);
    const subRef = config.subAgents.find((s) => s.slug === subSlug);
    const subAgentName = subRef?.description ?? subRef?.slug ?? tc.name;
    sendStreamChunk({
      type: 'tool_call',
      streamSessionId,
      callId: tc.id,
      toolName: tc.name,
      args: tc.arguments,
      isDispatch: true,
      subStreamSessionId,
      subAgentName,
      subAgentAvatar: '🤖',
    });
    return executeTool(tc, ctx, config, subBudget, dispatchInfo, subStreamSessionId, streamSessionId, roomId)
      .then((result) => {
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: true,
          subStatus: 'completed' as const,
        });
        return result;
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) throw err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const result = `工具执行失败: ${errMsg}`;
        // dispatch 超时（executeDispatch 渐进式计时器 reject）→ 'timeout'；其它 → 'failed'
        const subStatus = errMsg.includes('超时') ? ('timeout' as const) : ('failed' as const);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: false,
          subStatus,
        });
        return result;
      });
  };

  for (let round = 0; ; round++) {
    // turn-mandate Task 3（spec §2「每轮重写」）：每轮构建 LLM 请求前先把
    // system 消息重写到最新 mandate 状态——未完成项可能已被 todowrite 工具
    // 推进/完成，跨压缩存活也走此路径保证 mandate 视图一致。
    refreshSystem();
    // v2.3 steer 注入（spec §5.2）：每轮构建 LLM 请求前 drain——上一轮工具
    // 执行期间到达的用户补充在此进入上下文；最后一轮自然结束后未消费的
    // 补充保留在会话历史（消息已落库），下轮对话可见，不重派发
    if (pendingSteers.length > 0) {
      // v2.3.1 消息滚动（spec §2.2）：有新文本先换行——旧行定格，新行承接本轮
      //（切点安全：drain 在工具循环结束后，无悬空 tool_call 事件对）
      if (hasNewTextSinceLastRoll) {
        sendStreamChunk({ type: 'message_roll', streamSessionId });
        hasNewTextSinceLastRoll = false;
      }
    }
    let drained = false;
    while (pendingSteers.length > 0) {
      // turn-mandate Task 3：把 steer 同步进 mandate 状态对象——
      // 下一次 refreshSystem 即把补充纳入 mandate 尾段，
      // 跨压缩存活路径同步生效。
      const steer = pendingSteers.shift()!;
      mandate.steers.push(steer);
      messages.push({ role: 'user', content: `[用户中途补充] ${steer}` });
      // v2.6.0 断点续跑：steer 事件持久化（spec §2 + v2.5 C1 教训）。
      // 走既有 event buffer 落库（event_type='steer' / payload={body}），
      // 重启后 turn-reconstructor 据此重建本条 [用户中途补充] user 消息，
      // 已 drain steer 不会进 steers[]，未 drain 由流末判定入 steers[]。
      // 纯事件追加（不动消息行状态），与 thinking/text/todo_update 同型。
      sendStreamChunk({ type: 'steer', streamSessionId, body: steer });
      drained = true;
    }
    if (drained) {
      wrapUpMode = false; // 新指令优先于收尾（spec §5.1）——清除后下一轮恢复工具
      refreshSystem();
    }

    // 会话边界二段修复：静态快照注入的 dispatch:* 剔除，换成当前会话命中成员
    // （与 hint / 白名单同步同一 hasSessionSubs 门——sessionSubs=[] 时不注入）
    const chatTools: LLMToolDef[] = hasSessionSubs
      ? [
          ...ctx.tools.filter((t) => !t.name.startsWith('dispatch:')),
          ...getDispatchToolDefs(sessionSubs),
          // v2.8.0：5 类编排工具同门注入（bg→gather 工作流 / followup 续接）
          ...orchestrationDefs,
        ]
      : ctx.tools.filter((t) => !t.name.startsWith('dispatch:'));

    // ─── auto 阈值自动压缩（spec §6.2，置于每轮 refreshSystem 后） ─────────────
    //
    // 窗口未知（0）整体跳过（fail-safe）；收尾模式不重复压缩；task 域
    // （currentTaskId 非空）跳过（非目标——mandate=task + complete_task 终态
    // 已足够，仅保留 NL compact 工具路径）。估算对象 = system + 全部 messages
    // + 工具定义；超阈值即机械执行与 compact 工具相同的压缩流程（不经 LLM 决策）。
    if (config.contextWindow > 0 && !wrapUpMode && !config.currentTaskId) {
      const est = estimateConversation({
        system: messages[0]!.content,
        messages,
        tools: chatTools,
      });
      if (
        est > config.contextWindow - Math.max(config.outputTokens, COMPACTION_BUFFER_TOKENS) &&
        est > COMPACTION_MIN_TRIGGER
      ) {
        // coveredUntil 由 runCompaction 内部按 head 末条已知时刻计算（T5 Important-1）
        const autoResult = await runCompaction();
        if (autoResult.ok) {
          if (autoResult.pendingUser) {
            // 有 user 挂靠 → 注入续行合成条后继续（工具照常，spec §6.2）
            messages.push({ role: 'user', content: AUTO_COMPACT_NOTICE });
          }
          // 无挂靠 → runCompaction 内已置 wrapUpMode（下一轮无工具，机械收口）
        } else {
          // auto 失败不阻塞回合（spec §9）：warn 后按原 messages 继续，下轮再试
          process.stderr.write(`auto 压缩失败（已跳过，下轮再试）: ${autoResult.error}\n`);
        }
      }
    }

    // turn mandate（spec §5.1）：收尾模式不传工具——模型无工具可调只能输出终文，
    // finishReason=stop 机械退出（先例：预算耗尽同样传 undefined）
    const tools = wrapUpMode || budgetRemaining <= 0 ? undefined : chatTools;
    trace(`→ LLM #${round + 1}`, { model: config.modelName, msg: messages.length, tools: tools?.length ?? 0 });

    const toolCalls: LLMToolCall[] = [];
    let finishReason: 'stop' | 'tool_use' = 'stop';

    try {
      for await (const delta of llm.chatStream(messages, tools, abortController.signal)) {
        switch (delta.type) {
          case 'thinking':
            sendStreamChunk({ type: 'thinking', streamSessionId, delta: delta.content });
            break;
          case 'text':
            accumulatedText += delta.content;
            hasNewTextSinceLastRoll = true;
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
      if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
        process.off('message', abortListener);
        sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
        if (stats) {
          stats.toolCallsUsed = toolCallCount;
          stats.aborted = true;
        }
        return accumulatedText;
      }
      // ─── 溢出恢复（spec §7，T6）：abort 分支之后、原错误终止之前 ────────────
      // provider 上下文溢出（错误信息特征匹配）且本回合未恢复过、仍有可压内容
      // （est > MIN_TRIGGER）→ 压缩一次后重放本轮授权继续本轮。压缩失败或二次
      // 溢出 → 落入下方原错误路径终止（end error + throw，错误不吞不改）。
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        !overflowRecovered &&
        OVERFLOW_ERROR_RE.test(errMsg) &&
        estimateConversation({
          system: messages[0]!.content,
          messages,
          tools: chatTools,
        }) > COMPACTION_MIN_TRIGGER
      ) {
        const recovered = await runCompaction();
        if (recovered.ok) {
          overflowRecovered = true;
          // 重放本轮授权（mandate 双要素 verbatim 逐条 push 为 user 消息）：
          // 压缩可能已把本轮首条 user 消息 / 早前 steer 摘要走，模型需要以
          // user 回合形态重新拿到授权才能继续。只 push 消息、绝不回写 mandate
          // 状态对象——steers 再进 mandate.steers 会令 system 授权提示段翻倍
          // （重放≠再授权）。
          messages.push({ role: 'user', content: mandate.userBody });
          for (const steer of mandate.steers) {
            messages.push({ role: 'user', content: `[用户中途补充] ${steer}` });
          }
          // 重放 = 用户指令重新到达：清除收尾模式（沿 steer drain「新指令优先
          // 于收尾」先例）——恢复的语义是重试本轮，而非机械收口后浪费这次压缩
          wrapUpMode = false;
          continue;
        }
      }
      process.off('message', abortListener);
      sendEndChunk({
        type: 'end',
        streamSessionId,
        finishReason: 'error',
        error: errMsg,
      });
      if (stats) stats.toolCallsUsed = toolCallCount;
      throw err;
    }

    if (finishReason === 'stop' || toolCalls.length === 0) {
      process.off('message', abortListener);
      const finalText = accumulatedText.trim() || '(空回复)';
      sendEndChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
      if (stats) stats.toolCallsUsed = toolCallCount;
      return finalText;
    }

    messages.push({ role: 'assistant', content: accumulatedText, toolCalls });

    // v1.5.6: 每轮 push 后重置累积文本——否则 accumulatedText 跨轮叠加，
    // 后续轮次的 assistant content 会包含之前所有轮的文本。
    // LLM 看到大量重复的自己说过的话 → 模仿 → 无限重复输出。
    // 根因不是上下文长度（1M tokens 17 轮用不到 2%），是文本累积导致 LLM 行为退化。
    accumulatedText = '';

    // v2 dispatch 并行（spec §4）：游标推进三段式。
    //   ① 预检逐位原顺序（重复检测 / 预算耗尽 / task_complete / compact 内联处理）
    //   ② 非 dispatch 工具：原路径串行执行（零行为差异）
    //   ③ 极大连续 dispatch 段：一次 Promise.allSettled 并发（段长 1 行为与原路径逐位一致）
    let ti = 0;
    while (ti < toolCalls.length) {
      const tc = toolCalls[ti]!;
      // v1.5.6: 循环检测——同名 + 同参数连续重复 MAX_DUPLICATE_TOOLS 次强制终止。
      // 防 LLM 上下文爆炸后失忆，每轮重复相同操作（如反复 list_files 同一目录）。
      const sig = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      recentToolCallSignatures.push(sig);
      if (recentToolCallSignatures.length > MAX_DUPLICATE_TOOLS) {
        recentToolCallSignatures.shift();
      }
      const dupCount = recentToolCallSignatures.filter((s) => s === sig).length;
      if (dupCount >= MAX_DUPLICATE_TOOLS) {
        process.off('message', abortListener);
        const finalText = accumulatedText.trim() || `(检测到连续 ${MAX_DUPLICATE_TOOLS} 次重复操作 ${tc.name}，已强制终止防循环)`;
        sendEndChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
        if (stats) stats.toolCallsUsed = toolCallCount;
        return finalText;
      }

      if (budgetRemaining <= 0) {
        process.off('message', abortListener);
        const finalText = accumulatedText.trim() || '(工具预算耗尽)';
        sendEndChunk({ type: 'end', streamSessionId, finishReason: 'budget_exhausted' });
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
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'stop' });
          if (stats) stats.toolCallsUsed = toolCallCount;
          return finalText;
        }

        // 持久化当前段：summary（如有）优先，否则用 accumulatedText
        const segText = summary || accumulatedText.trim() || '(空段)';
        // 分段持久化的 session id 加后缀，避免与最终消息冲突
        const segSessionId = `${streamSessionId}#seg${segmentCount}`;
        // 分段行由 segment_boundary chunk 经主进程 routeChunkToBuffer 落 SQLite。
        // A7 fix：通知主进程为这段创建独立的 SQLite message row（segment_of/segment_index）。
        // 主进程 routeChunkToBuffer 据此 INSERT 分段行；后续 events 仍关联父 message。
        sendStreamChunk({
          type: 'segment_boundary',
          streamSessionId,
          segmentIndex: segmentCount,
          segmentBody: segText,
          segmentStreamSessionId: segSessionId,
        });

        // 重置累积，让 LLM 下一轮生成新段
        accumulatedText = '';

        // 推 stream chunk 让 renderer 知道分段了（可选 UI 提示）
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          callId: tc.id,
          toolName: 'task_complete',
          args: tc.arguments,
        });
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: 'task_complete',
          result: `第 ${segmentCount}/${MAX_TASK_SEGMENTS} 段已持久化。${nextStep ? `继续：${nextStep}` : '请继续输出当前回复的下一段'}`,
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
          content: `第 ${segmentCount}/${MAX_TASK_SEGMENTS} 段已发送。${nextStep ? `下一步：${nextStep}` : '请继续输出当前回复的下一段，输出到合适段落时再次调用 task_complete'}`,
          toolCallId: tc.id,
        });
        toolCallCount++;
        budgetRemaining--;
        ti++; continue;
      }

      // 压缩改造（spec §6.1）：compact 工具 harness 化——LLM 只声明动机（可选
      // note），摘要由主进程 CompactionService 结构化链路生成。执行 = 尾部选择
      // （verbatim 保留近几轮 + mandate 锚点保护）→ head 序列化 → IPC 摘要 →
      // messages 替换 + 双态续行。失败 tool result 报错可重试、messages 原样。
      if (tc.name === 'compact') {
        const before = messages.length;
        const note = typeof tc.arguments.note === 'string' ? tc.arguments.note : '';
        // coveredUntil 由 runCompaction 内部按 head 末条已知时刻计算（T5 Important-1）
        const result = await runCompaction();

        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          callId: tc.id,
          toolName: 'compact',
          args: tc.arguments,
        });

        // 双态/作用域三态回执文案（沿 turn-mandate spec §5.6 #3）
        const stateMsg = result.ok
          ? result.pendingUser
            ? `仍有 ${pendingUserItems().length} 项用户待办，请继续完成。`
            : result.mandateGated
              ? '无用户待办，请输出总结收尾。'
              : '请基于总结继续当前任务。'
          : '';

        if (result.ok) {
          sendStreamChunk({
            type: 'tool_result',
            streamSessionId,
            callId: tc.id,
            toolName: 'compact',
            result: `上下文已压缩：${before} → 1+尾部 ${result.tailCount} 条。${stateMsg}`,
            success: true,
          });
          // 回填 LLM：恰一条 tool result（旧实现的第二份前进指令消息已删，
          // spec §5.6 #4——指令合并进压缩条尾部指令 + 本条回执）
          messages.push({ role: 'assistant', content: '', toolCalls: [tc] });
          messages.push({
            role: 'tool',
            content: `上下文已压缩：${before} → 1+尾部 ${result.tailCount} 条消息。${stateMsg}`,
            toolCallId: tc.id,
          });
        } else {
          // 失败路径（spec §6.1 #5 / §9）：报错可重试，messages 原样不动
          sendStreamChunk({
            type: 'tool_result',
            streamSessionId,
            callId: tc.id,
            toolName: 'compact',
            result: `压缩失败：${result.error}，可重试`,
            success: false,
          });
          messages.push({ role: 'assistant', content: '', toolCalls: [tc] });
          messages.push({
            role: 'tool',
            content: `压缩失败：${result.error}，可重试。消息历史未改动${note ? `（备注：${note}）` : ''}。`,
            toolCallId: tc.id,
          });
        }
        toolCallCount++;
        budgetRemaining--;
        ti++; continue;
      }

      if (tc.name.startsWith('dispatch:')) {
        // === ③ dispatch 段：向后扫描极大连续 dispatch 段（spec §4.3 截断规则） ===
        // 段内逐位预检（原顺序）：重复检测截断 / 预算截断——被截断的成员不发 tool_call chip
        let segEnd = ti + 1;
        let exitAfterSegment: { finishReason: 'stop' | 'budget_exhausted'; fallbackText: string } | null = null;
        while (segEnd < toolCalls.length && toolCalls[segEnd]!.name.startsWith('dispatch:')) {
          const next = toolCalls[segEnd]!;
          const nextSig = `${next.name}:${JSON.stringify(next.arguments)}`;
          recentToolCallSignatures.push(nextSig);
          if (recentToolCallSignatures.length > MAX_DUPLICATE_TOOLS) {
            recentToolCallSignatures.shift();
          }
          const nextDup = recentToolCallSignatures.filter((s) => s === nextSig).length;
          if (nextDup >= MAX_DUPLICATE_TOOLS) {
            exitAfterSegment = {
              finishReason: 'stop',
              fallbackText: `(检测到连续 ${MAX_DUPLICATE_TOOLS} 次重复操作 ${next.name}，已强制终止防循环)`,
            };
            break;
          }
          // 纳入本成员后段长 = segEnd - ti + 1，须 ≤ 剩余预算；否则截断（§4.3）
          if (budgetRemaining !== Infinity && budgetRemaining < segEnd - ti + 1) {
            exitAfterSegment = { finishReason: 'budget_exhausted', fallbackText: '(工具预算耗尽)' };
            break;
          }
          segEnd++;
        }

        const seg = toolCalls.slice(ti, segEnd);
        const budgetBeforeSegment = budgetRemaining;
        // 段开始一次性预扣 K（spec §5.2）
        if (budgetRemaining !== Infinity) {
          budgetRemaining -= seg.length;
        }
        // D3 均分：并发无法预知各成员消耗，sub-budget 统一 = 段前预算 - 段长
        // （串行为先到先得；段长 1 时与串行公式 budgetRemaining - 1 逐位一致）
        const subBudget =
          budgetBeforeSegment === Infinity ? -1 : Math.max(0, budgetBeforeSegment - seg.length);
        const dispatchInfos = seg.map(() => ({ toolCallsUsed: 0 }));

        // 并发执行（§4.1）：execDispatchCall 同步段先发全部 K 个 tool_call chip，再各自等回执
        const settled = await Promise.allSettled(
          seg.map((member, idx) => execDispatchCall(member, subBudget, dispatchInfos[idx]!)),
        );

        // 中断（§6.1）：任一成员 AbortError / 信号已触发 → 统一中断退出，不回填 tool result
        // （与原串行 catch 分支语义一致，防「中断-重试」死循环）
        if (abortController.signal.aborted || settled.some((r) => r.status === 'rejected')) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || '(中断)';
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) {
            stats.toolCallsUsed = toolCallCount;
            stats.aborted = true;
          }
          return finalText;
        }

        // 消息回填（§4.2）：按原 toolCalls 顺序（协议要求与 assistant.toolCalls 的 id 一一对应，
        // 不按完成顺序）；预算按各成员回执追扣（§5.2）
        for (let idx = 0; idx < seg.length; idx++) {
          const r = settled[idx] as PromiseFulfilledResult<string>;
          messages.push({ role: 'tool', content: r.value, toolCallId: seg[idx]!.id });
          toolCallCount++;
          const info = dispatchInfos[idx]!;
          if (info.toolCallsUsed > 0 && budgetRemaining !== Infinity) {
            budgetRemaining -= info.toolCallsUsed;
          }
        }

        // 段内截断（§4.3）：已执行成员的回执已发，按截断原因退出
        if (exitAfterSegment) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || exitAfterSegment.fallbackText;
          sendEndChunk({ type: 'end', streamSessionId, finishReason: exitAfterSegment.finishReason });
          if (stats) stats.toolCallsUsed = toolCallCount;
          return finalText;
        }

        ti = segEnd;
        continue;
      }

      // === ② 非 dispatch 工具：原路径串行执行（v2 并行仅作用于连续 dispatch 段） ===
      // v2.8.0 dispatch_bg:：start chip 由 doExecuteTool 路由层发（isDispatch +
      // 预生成 subStreamSessionId，照 execDispatchCall 形态）——此处跳过普通 chip：
      // aggregator 按 callId 分段，两个 start（plain + isDispatch）会渲染出双段。
      if (!tc.name.startsWith('dispatch_bg:')) {
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          args: tc.arguments,
        });
      }

      let result: string;
      try {
        result = await executeTool(tc, ctx, config, undefined, undefined, undefined, streamSessionId, roomId);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: true,
        });
      } catch (err) {
        // v1.5.2: 工具因 abort 失败立即跳出整个 chat loop，不推 tool_result 给 LLM
        // （否则 LLM 看到失败结果后重试，形成「中断-重试-中断」死循环）
        if ((err as Error).name === 'AbortError' || abortController.signal.aborted) {
          process.off('message', abortListener);
          const finalText = accumulatedText.trim() || '(中断)';
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) {
            stats.toolCallsUsed = toolCallCount;
            stats.aborted = true;
          }
          return finalText;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        result = `工具执行失败: ${errMsg}`;
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: tc.name,
          result,
          success: false,
        });
      }

      toolCallCount++;
      budgetRemaining--;
      messages.push({ role: 'tool', content: result, toolCallId: tc.id });
      ti++;
    }
  }
}

/**
 * task-driven 模式入口——接收主进程通过 task-config IPC 注入的 TaskConfig，
 * 构造 chat loop 上下文，调用 runChatLoop 跑完整 LLM + 工具循环，结束后回执
 * （dispatch 任务）+ 通知主进程 + 退出 runtime 子进程。
 *
 * 要点：
 *   - 输入源：TaskConfig IPC（用户消息经 RouterService，dispatch 经 routeDispatch）
 *   - 出站：dispatch/task_reply 经内部事件桥；最终消息由 chunk 路径落 SQLite
 *   - streamSessionId：由 AgentRunner 预分配（cfg.streamSessionId），不再 randomUUID
 *   - 任务关联：cfg.taskId 注入 RuntimeConfig.currentTaskId → MemoryProvider.getTaskContext 拉 task 上下文
 *   - dispatch 嵌套：cfg.dispatchContext 设置时把 tool_stream_session_id 作为 parentStreamSessionId 传入
 *   - 生命周期：单 task 完成后立即 process.exit(0)（runtime 不再常驻）
 *
 * 主进程 → runtime IPC 契约：
 *   - 入：{ type: 'task-config', ... } / { type: 'task-reply', reply }（PM 等 dispatch 回执）
 *   - 出：{ type: 'task-end', streamSessionId, taskId }（task 完成或 abort 后发）
 *   - 出：dispatch / task_reply / abort_dispatch 内部事件（momo-internal-event 信封）
 *   - chunk 流：sendStreamChunk（start/thinking/text/tool_call/tool_result/todo_update/segment_boundary/message_roll/steer/end）
 *
 * 错误处理：try/catch 包裹 runChatLoop，失败时发 end(error) chunk + task-end IPC + exit(1)。
 * 不重试——上层 RouterService / AgentRunner 可在 task-end 后决定是否重新派发。
 */

/**
 * I3 修复：发送 task-end IPC 后等 IPC channel flush 再 exit，避免 exit 抢先丢弃消息。
 *
 * process.send 是异步 IPC 写——紧接 process.exit 可能导致 task-end 未 flush 就退出。
 * Node.js 的 process.send 支持回调（flushed 后触发），故：
 *   1. process.send(msg, callback) → callback 内 exit
 *   2. 2 秒兜底超时防 callback 永不触发（极端情况如 IPC channel 已断）
 *   3. process.send 不存在（非 fork 模式）时直接 exit
 */
function sendTaskEndAndExit(msg: Record<string, unknown>, exitCode: number): void {
  // 必须以 process.send(...) 方法调用形式发送：Node 内部实现读取 this.connected，
  // 解构后裸调用（const send = process.send; send(...)）在严格模式下 this=undefined，
  // 抛 "Cannot read properties of undefined (reading 'connected')" 令错误路径整体崩溃
  // （2.0.0 主机验收 P0：LLM 请求失败 → 错误处理崩溃 → agent 永不回复）。
  if (!process.send) {
    process.exit(exitCode);
    return;
  }
  const forceTimer = setTimeout(() => process.exit(exitCode), 2000);
  process.send(msg, () => {
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}

export async function runTaskChatLoop(
  cfg: TaskConfig,
  config: RuntimeConfig,
  ctx: RuntimeContext,
): Promise<void> {
  const { taskId, executionSessionId: roomId, body, streamSessionId, dispatchContext, resume, historyPrefix } = cfg;

  // 1. 构造 task-driven 专用的 RuntimeConfig：
  //    - currentTaskId：taskId 非空时设置（runChatLoop 据此向 MemoryProvider 拉 task 上下文注入 system prompt）
  //    - chainTaskId：dispatchContext 设置时织入链 ID（Task 5 链路打标——start chunk 据此
  //      把 dispatch 链 ID 落到该流全部消息行的 task_id；与 currentTaskId 语义分立，见
  //      runtime-config 字段注释）
  //    - maxToolCalls：dispatchContext.tool_budget 优先（PM 分配的子任务预算），
  //      其次 cfg.maxToolCalls（主进程按 executionSessionId 解析的会话/全局预算，
  //      v2.2 接线），均缺省时沿用 config（AGENT_CONFIG 默认）
  const taskConfig: RuntimeConfig = {
    ...config,
    ...(taskId ? { currentTaskId: taskId } : {}),
    ...(dispatchContext ? { chainTaskId: dispatchContext.task_id } : {}),
    ...(dispatchContext?.tool_budget !== undefined
      ? { maxToolCalls: dispatchContext.tool_budget }
      : cfg.maxToolCalls !== undefined
        ? { maxToolCalls: cfg.maxToolCalls }
        : {}),
  };

  // 2. parentStreamSessionId：dispatchContext 设置时为 PM 的 streamSessionId，
  //    用于 renderer 把子 agent 流嵌套渲染到 PM 气泡内对应 dispatch chip 下方；
  //    sub-agent 自身用 cfg.streamSessionId（两者解耦）。
  const parentStreamSessionId = dispatchContext?.tool_stream_session_id;

  // 3. per-run ctx 变体（v2.5 终审 C1）：boot ctx 的 streamSessionId/roomId 是
  //    WarmPool 预 spawn 期占位空串（真实值经 task-config IPC 后置注入）——不回写
  //    则 doExecuteTool 组装的 toolCtx 恒空串，账本 streamSessionId/session_id 记
  //    空值，chip 查询永不命中。只织入变体不改 boot ctx；runChatLoop 对
  //    ctx.abortSignal 的赋值落在本变体上，与工具链共享同对象，中断语义不变。
  const runCtx: RuntimeContext = { ...ctx, streamSessionId, roomId };

  // 4. 跑 chat loop——runChatLoop 内部完成 system prompt 构造 / MemoryProvider 拉 / 工具循环 / abort 处理。
  //    stats 用于在 task-end IPC 里上报工具调用次数。
  const stats: RunChatLoopStats = { toolCallsUsed: 0 };

  try {
    const finalText = await runChatLoop(
      roomId,
      body,
      taskConfig,
      runCtx,
      stats,
      parentStreamSessionId,
      undefined, // 暂无外部 abort_dispatch event 监听（PM 通过 IPC 直接 abort）
      streamSessionId, // AgentRunner 预分配的 streamSessionId，覆盖 randomUUID
      // v2.6.0 断点续跑（plan Task 4/Task 5 第 10 参接线）：resume 载荷
      // 经 cfg.resume 解构透传到 runChatLoop.resumeTurn；runChatLoop 据此接续
      // messages / 续扣预算 / 重放 steers。缺省 undefined 时既有行为零改动
      // （spec §5.4 「最小侵入，不动既有 11 个调用点」）。
      // 消费侧接线锁：tests/agent/runtime-task-driven.test.ts「v2.6.0 接线锁」
      // 用例——摘掉本解构/传参该锁必红（resume 静默丢失不报错）。
      resume,
      // v2.8.0 Orchestration 元语（Task 2）：followup 续聊前缀经 cfg.historyPrefix
      // 透传到 runChatLoop 第 11 参（与 resume 互斥由派发侧保证，runChatLoop 内
      // 防御兜底）。接线锁：tests/agent/runtime-history-prefix.test.ts「接线锁」
      // 用例——摘掉本解构/传参该锁必红（前缀静默丢失不报错）。
      historyPrefix,
    );
    // dispatch 任务完成 → 经内部事件桥回 task_reply（reply_to 精确路由回 PM，
    // RouterService → notifyTaskReply → PM 子进程 handleTaskReply resolve dispatch）
    if (dispatchContext) {
      // minor-6：若 runChatLoop 因 abort 提前返回，回执不能报 completed（否则
      // PM 的 dispatch promise 误判成功，子 agent 实际未完成工作）。显式 aborted
      // → failed；非 aborted 时按 finalText 是否为空兜底判 success
      const replyStatus: 'completed' | 'failed' = stats.aborted
        ? 'failed'
        : finalText
          ? 'completed'
          : 'failed';
      const reply = buildTaskReply({
        body: finalText,
        taskId: dispatchContext.task_id,
        status: replyStatus,
        toolCallsUsed: stats.toolCallsUsed,
        replyTo: dispatchContext.fromAssignmentId,
      });
      sendTaskReplyEvent(roomId, config.agentUserId, { ...reply.content });
    }
  } catch (err) {
    // runChatLoop 抛错：仅当本轮未发过 end 时补一条 end(error)（minor-7 防重），
    // 再 task-end + exit(1)。runChatLoop 的内部 try/catch 在大多数错误路径
    // 已 sendEndChunk(error) 后才 throw（endChunkSent=true）；某些早期抛错
    // （如 getConversationContext 失败）未经此处理则兜底发 end。
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`runTaskChatLoop 异常: ${msg}\n`);
    if (!stats.endChunkSent) {
      sendStreamChunk({
        type: 'end',
        streamSessionId,
        finishReason: 'error',
        error: msg,
      });
    }
    // dispatch 任务失败也要回执（status=failed）——否则 PM 的 dispatch promise
    // 挂到渐进式超时才 reject，主子调度不可用
    if (dispatchContext) {
      const reply = buildTaskReply({
        body: msg,
        taskId: dispatchContext.task_id,
        status: 'failed',
        toolCallsUsed: stats.toolCallsUsed,
        replyTo: dispatchContext.fromAssignmentId,
      });
      sendTaskReplyEvent(roomId, config.agentUserId, { ...reply.content });
    }
    sendTaskEndAndExit({ type: 'task-end', streamSessionId, taskId, error: msg }, 1);
    return;
  }

  sendTaskEndAndExit(
    { type: 'task-end', streamSessionId, taskId, toolCallsUsed: stats.toolCallsUsed },
    0,
  );
}

/**
 * v1.5.6 task_complete 最大分段次数。
 * 防止 LLM 误用（每次 task_complete 都触发 sendEvent + 重置上下文，无限分段会浪费 token + 持久化垃圾）。
 * 5 段足够覆盖典型长任务（每段 ~5KB → 总 25KB，仍在 PDU 内但已分批）。
 */
const MAX_TASK_SEGMENTS = 5;

/**
 * 统一工具执行路由（含审计插桩）：计时 + try/finally 包装 doExecuteTool，
 * 无论成功或失败都通过 IPC 发送审计日志。原路由逻辑见 doExecuteTool。
 */
async function executeTool(
  call: LLMToolCall,
  ctx: RuntimeContext,
  config: RuntimeConfig,
  toolBudget?: number,
  dispatchInfo?: { toolCallsUsed: number },
  /** dispatch 工具的子 agent 流 id（PM 预生成） */
  toolStreamSessionId?: string,
  /** PM 自身流 id（runChatLoop 作用域——子 agent 消息 parentStreamSessionId 的来源） */
  pmStreamSessionId?: string,
  /** 当前执行会话（dispatch 内部事件的路由目标，P0-8） */
  executionSessionId?: string,
): Promise<string> {
  const startTime = Date.now();
  let success = true;
  let output = '';
  trace(`→ 工具: ${call.name}`, { input: `${JSON.stringify(call.arguments).length}字` });
  try {
    output = await doExecuteTool(call, ctx, config, toolBudget, dispatchInfo, toolStreamSessionId, pmStreamSessionId, executionSessionId);
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
  config: RuntimeConfig,
  toolBudget?: number,
  dispatchInfo?: { toolCallsUsed: number },
  toolStreamSessionId?: string,
  pmStreamSessionId?: string,
  executionSessionId?: string,
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
      // v2.3 任务工具注入：creatorUserId 透传 ctx（同一 workspace 内所有工具调用共享）
      creatorUserId: ctx.creatorUserId,
      // v1.5.1：长任务工具（bash/webfetch）监听此 signal，停止按钮立即生效
      abortSignal: ctx.abortSignal,
      // v2.3 Read-before-Edit：进程级单例注入（终审 C1——缺此字段守门静默失效）
      readTracker,
      // v2.5 变更账本：task-driven 派发的任务 id（快速会话无任务 → undefined，
      // 记账层归一为 null）。删此注入 → journal-wiring 接线锁的 taskId 用例变红
      taskId: config.currentTaskId,
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
    const dispatchResult = await executeDispatch(subSlug, task, config, toolBudget, toolStreamSessionId, pmStreamSessionId, executionSessionId, ctx.abortSignal);
    if (dispatchInfo) dispatchInfo.toolCallsUsed = dispatchResult.toolCallsUsed;
    return dispatchResult.body;
  }
  // === v2.8.0 Orchestration（Task 7）：5 类编排工具路由（spec §5） ===
  // 实参形态照 executeDispatch 既有调用点：pmStreamSessionId = PM 当前流 id、
  // executionSessionId = 当前执行会话、ctx.abortSignal = 停止按钮级联。
  // isDispatch 批处理判定仅匹配 'dispatch:' 前缀，dispatch_bg: 天然不命中——
  // bg 走上方普通路径串行执行（spec §6：bg 不参与批处理，各自独立 tool call）。
  if (name === 'dispatch_followup') {
    const taskId = argToString(call.arguments.taskId, 'taskId');
    const question = argToString(call.arguments.question, 'question');
    const followupResult = await executeFollowup(
      taskId,
      question,
      config,
      executionSessionId,
      ctx.abortSignal,
      pmStreamSessionId,
    );
    return followupResult.body;
  }
  if (name.startsWith('dispatch_bg:')) {
    const subSlug = name.slice('dispatch_bg:'.length);
    const task = argToString(call.arguments.task, 'task');
    const bgBudget =
      typeof call.arguments.toolBudget === 'number' ? call.arguments.toolBudget : undefined;
    // T4 硬性：预生成 subStreamSessionId 透传（句柄存它——dispatch_cancel 级联
    // abort 的定位键）；chip 照 execDispatchCall 形态发（模块级 sender + isDispatch
    // + 子 agent 展示名，streamSessionId = PM 当前流 id），renderer DispatchChip
    // 据此关联子流。
    const subStreamSessionId = randomUUID();
    const subRef = config.subAgents.find((s) => s.slug === subSlug);
    sendStreamChunk({
      type: 'tool_call',
      streamSessionId: pmStreamSessionId ?? '',
      callId: call.id,
      toolName: name,
      args: call.arguments,
      isDispatch: true,
      subStreamSessionId,
      subAgentName: subRef?.description ?? subRef?.slug ?? name,
      subAgentAvatar: '🤖',
    });
    const bgResult = await executeDispatchBg(
      subSlug,
      task,
      config,
      bgBudget,
      subStreamSessionId,
      pmStreamSessionId,
      executionSessionId,
    );
    return JSON.stringify(bgResult);
  }
  if (name === 'dispatch_gather') {
    const handles = call.arguments.handles;
    if (!Array.isArray(handles) || !handles.every((h) => typeof h === 'string')) {
      throw new Error('参数 "handles" 缺失或不是字符串数组');
    }
    const mode = call.arguments.mode;
    if (mode !== 'all' && mode !== 'any') {
      throw new Error('参数 "mode" 必须是 "all" 或 "any"');
    }
    const rawTimeout = call.arguments.timeoutMs;
    if (rawTimeout !== undefined && typeof rawTimeout !== 'number') {
      throw new Error('参数 "timeoutMs" 不是数字');
    }
    // 终审 I1：传 abortSignal——PM abort 时 gather 立即 AbortError reject，
    // 不阻塞 chat loop 到 gather 超时（与 dispatch/followup 分支同纪律）
    return JSON.stringify(await executeGather(handles, mode, rawTimeout, ctx.abortSignal));
  }
  if (name === 'dispatch_status') {
    return JSON.stringify(executeStatus(argToString(call.arguments.handle, 'handle')));
  }
  if (name === 'dispatch_cancel') {
    return JSON.stringify(
      executeCancel(argToString(call.arguments.handle, 'handle'), config, executionSessionId),
    );
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

// 仅在被 runtime-spawner fork（注入 AGENT_CONFIG 环境变量）时启动主流程；
// 其它场景（如单测 import 本模块）不触发 main()，避免在缺少配置时
// parseConfig 抛错 → process.exit(1) 把测试进程一并杀掉。
if (process.env.AGENT_CONFIG !== undefined) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
