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
import { formatBudgetHint, formatDispatchHint, formatTaskHint } from './prompt-hints';
import { logToolCall } from './tools/shared/audit';
import { assertToolAllowed } from './tools/shared/permission';
import {
  getVirtualToolDefs,
  getDispatchToolDefs,
  getBuiltinLoopToolDefs,
} from './builtin-tools';
import { buildToolRegistry, executeTool as executeToolModule, getAllToolDefs } from './tools';
import type { ToolModule, ToolContext } from './tools/types';
import { SkillRegistry } from '../skill/registry';
import { sendStreamChunk, type StreamChunk } from './stream-chunk';
import { discoverMcpTools, requestMcpCall } from './mcp-bridge';
import { buildTaskReply } from './dispatch';
// v2（P1 Task 5）：内部事件桥——dispatch/task_reply/abort_dispatch 经 child IPC
// 直达主进程 RouterService，取代 Matrix 自定义 event 传输
import { sendTaskReplyEvent } from './internal-event';
import { executeDispatch, handleTaskReplyIpc, setDispatchTraceEnabled } from './dispatch-wait';
import { getMemoryProvider, type ConversationContext, type TaskContext } from '../memory';

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
  setDispatchTraceEnabled(config.devMode);

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
  });

  const tools: LLMToolDef[] = [
    ...getAllToolDefs(toolModules),
    ...getVirtualToolDefs(skillRegistry),
    ...(await discoverMcpTools(config)),
    ...(config.role === 'main' ? getDispatchToolDefs(config.subAgents) : []),
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
): Promise<string> {
  const llm = createLLMProvider(
    // P3 Task 1：modelPlatform 显式透传（来自 buildSpawnOpts provider.platform）。
    // undefined 时 createLLMProvider 退回到 baseUrl 启发式（v1.3 兼容路径）。
    { model: config.modelName, baseUrl: config.modelBaseUrl, ...(config.modelPlatform ? { provider: config.modelPlatform } : {}) },
    config.llmApiKey,
  );

  const budgetHint = formatBudgetHint(config.maxToolCalls);
  // v1.5.6 C3：PM 自动 dispatch 教学——主 agent 角色 + 有 subAgents 时注入任务拆分指南
  const dispatchHint = formatDispatchHint(config);

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
  const finalSystemContent = ctx.systemPrompt + budgetHint + dispatchHint + taskHint;

  const convMessages: LLMMessage[] = convCtx.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages: LLMMessage[] = [
    { role: 'system', content: finalSystemContent },
    ...convMessages,
    { role: 'user', content: currentBody },
  ];

  // 子 agent（dispatch 模式）复用 PM 分配的 subStreamSessionId 作为自身 session ID，
  // 使 renderer 的 DispatchChip 能通过 streams.get(subStreamSessionId) 找到子 agent 的 StreamState。
  // 顶层 agent（普通消息）生成新 UUID。
  // v2 task-driven：AgentRunner 通过 streamSessionIdOverride 传入预分配的 session ID（替代 randomUUID）。
  const streamSessionId = streamSessionIdOverride ?? parentStreamSessionId ?? randomUUID();
  const maxToolCalls = config.maxToolCalls;
  let budgetRemaining = maxToolCalls === -1 ? Infinity : maxToolCalls;
  let toolCallCount = 0;
  // v1.5.6 task_complete 分段计数：每调一次 +1，超 MAX_TASK_SEGMENTS 强制结束
  let segmentCount = 0;
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

  // minor-7：end chunk 统一经此发送并标记 stats.endChunkSent——
  // runTaskChatLoop 的错误兜底据此防重（否则 LLM 错误路径连发两个 end）
  const sendEndChunk = (chunk: Extract<StreamChunk, { type: 'end' }>): void => {
    sendStreamChunk(chunk);
    if (stats) stats.endChunkSent = true;
  };

  sendStreamChunk({
    type: 'start',
    streamSessionId,
    // Task 6 字段迁移：roomId→sessionId、botUserId→senderAgentId。
    // v2（Task 10）：值 = agent 本地身份 agentUserId（messages.sender 落库 +
    // renderer botNameMap 据此解析展示名）
    sessionId: roomId,
    senderAgentId: config.agentUserId,
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

  for (let round = 0; ; round++) {
    // v1.5.6: 上下文过长时注入 compact 提示（不强制，只提醒 LLM 主动调）
    if (messages.length > 30 && round > 0) {
      messages.push({
        role: 'system',
        content: '[系统提示] 对话历史已较长（' + messages.length + ' 条消息）。如果感到困惑或重复，请调用 compact 工具压缩上下文（写一份 ≥200 字符的总结），然后继续工作。',
      });
    }

    const tools = budgetRemaining <= 0 ? undefined : ctx.tools;
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
        sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
        if (stats) {
          stats.toolCallsUsed = toolCallCount;
          stats.aborted = true;
        }
        return accumulatedText;
      }
      sendEndChunk({
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

    for (const tc of toolCalls) {
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

      // v1.5.6 compact：LLM 主动压缩上下文。调此工具时把整个对话历史替换为
      // [system, {role: user, content: 历史总结}]，chat loop 继续。
      // 解决长任务多轮对话累积导致 LLM 上下文爆炸 / 失忆问题。
      if (tc.name === 'compact') {
        const summary = typeof tc.arguments.summary === 'string' ? tc.arguments.summary : '';
        if (!summary || summary.length < 50) {
          // summary 过短拒绝（防 LLM 滥用清空上下文）：要求至少 50 字符覆盖关键信息
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [tc],
          });
          messages.push({
            role: 'tool',
            content: 'compact 失败：summary 过短（< 50 字符）。请写一份完整的对话总结，覆盖已完成的任务、关键决策、未完成的步骤、重要文件/变量名。最小 200 字符。',
            toolCallId: tc.id,
          });
          toolCallCount++;
          budgetRemaining--;
          continue;
        }

        const oldMsgCount = messages.length;
        // 重置对话历史：保留 system prompt（messages[0]），其余替换为压缩后的总结
        const systemMsg = messages[0]!;
        messages.length = 0;
        messages.push(systemMsg);
        messages.push({
          role: 'user',
          content: `[历史对话总结]\n${summary}\n\n[请基于此总结继续工作]`,
        });

        // 推 stream chunk 让 renderer 知道发生了 compact（可选 UI 提示）
        sendStreamChunk({
          type: 'tool_call',
          streamSessionId,
          callId: tc.id,
          toolName: 'compact',
          args: tc.arguments,
        });
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
          toolName: 'compact',
          result: `上下文已压缩：${oldMsgCount} 条消息 → 1 条总结（${summary.length} 字符）。继续工作`,
          success: true,
        });

        // tool_result 推回 LLM（基于新 messages 数组）
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [tc],
        });
        messages.push({
          role: 'tool',
          content: `上下文已压缩（${oldMsgCount} → 2 条消息）。请继续基于总结工作。`,
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
          callId: tc.id,
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
          callId: tc.id,
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
      try {
        result = await executeTool(tc, ctx, config, dispatchToolBudget, dispatchInfo, subStreamSessionId, streamSessionId, roomId);
        sendStreamChunk({
          type: 'tool_result',
          streamSessionId,
          callId: tc.id,
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
          sendEndChunk({ type: 'end', streamSessionId, finishReason: 'interrupted' });
          if (stats) {
            stats.toolCallsUsed = toolCallCount;
            stats.aborted = true;
          }
          return finalText;
        }

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
          callId: tc.id,
          toolName: tc.name,
          result,
          success: false,
          ...(subStatus ? { subStatus } : {}),
        });
      }

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
 *   - chunk 流：sendStreamChunk（start/thinking/text/tool_call/tool_result/end）
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
  const { taskId, executionSessionId: roomId, body, streamSessionId, dispatchContext } = cfg;

  // 1. 构造 task-driven 专用的 RuntimeConfig：
  //    - currentTaskId：taskId 非空时设置（runChatLoop 据此向 MemoryProvider 拉 task 上下文注入 system prompt）
  //    - maxToolCalls：dispatchContext.tool_budget 优先（PM 分配的子任务预算），否则沿用 config（房间级 / 全局默认）
  const taskConfig: RuntimeConfig = {
    ...config,
    ...(taskId ? { currentTaskId: taskId } : {}),
    ...(dispatchContext?.tool_budget !== undefined
      ? { maxToolCalls: dispatchContext.tool_budget }
      : {}),
  };

  // 2. parentStreamSessionId：dispatchContext 设置时为 PM 的 streamSessionId，
  //    用于 renderer 把子 agent 流嵌套渲染到 PM 气泡内对应 dispatch chip 下方；
  //    sub-agent 自身用 cfg.streamSessionId（两者解耦）。
  const parentStreamSessionId = dispatchContext?.tool_stream_session_id;

  // 3. 跑 chat loop——runChatLoop 内部完成 system prompt 构造 / MemoryProvider 拉 / 工具循环 / abort 处理。
  //    stats 用于在 task-end IPC 里上报工具调用次数。
  const stats: RunChatLoopStats = { toolCallsUsed: 0 };

  try {
    const finalText = await runChatLoop(
      roomId,
      body,
      taskConfig,
      ctx,
      stats,
      parentStreamSessionId,
      undefined, // 暂无外部 abort_dispatch event 监听（PM 通过 IPC 直接 abort）
      streamSessionId, // AgentRunner 预分配的 streamSessionId，覆盖 randomUUID
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
    const dispatchResult = await executeDispatch(subSlug, task, config, toolBudget, toolStreamSessionId, pmStreamSessionId, executionSessionId, ctx.abortSignal);
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

// 仅在被 runtime-spawner fork（注入 AGENT_CONFIG 环境变量）时启动主流程；
// 其它场景（如单测 import 本模块）不触发 main()，避免在缺少配置时
// parseConfig 抛错 → process.exit(1) 把测试进程一并杀掉。
if (process.env.AGENT_CONFIG !== undefined) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
