// electron/src/main/agent/runtime-entry.ts
//
// Agent runtime 子进程入口。由 runtime-manager.ts 通过 fork()/spawn() 启动，
// 配置通过环境变量 AGENT_CONFIG（JSON）传入。
//
// 启动流程：登录 Matrix → 等待首次 sync(PREPARED) → 在 team room 发"已上线" →
// 监听 @ 提及并执行完整 chat loop（LLM 思考 + 工具执行循环）。
//
// chat loop 流程（handleEvent）：
//   1. 收到 @ 本 bot 的 m.room.message
//   2. 组装上下文（system prompt + 最近 10 条历史 + 当前消息）
//   3. 循环调用 LLM：若返回工具调用则执行并把结果回传，否则发送最终文本回复
//   4. 工具循环上限 MAX_TOOL_ROUNDS=10，防止 LLM 无限调用工具
//
// 注意：此入口运行在独立子进程中，不要 import 主进程的 logger（electron-log
// 依赖主进程的路径解析），统一用 process.stdout/stderr 输出，由父进程
// runtime-manager 转发到主日志。

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
import { createLLMProvider, type LLMMessage } from './llm-provider';
import { getBuiltinToolDefs, executeBuiltinTool } from './builtin-tools';

/** runtime-manager 通过 AGENT_CONFIG 传入的完整配置 */
interface RuntimeConfig {
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  teamRoomId: string;
  // chat loop 所需字段
  systemPrompt: string;
  modelProvider: 'openai' | 'anthropic';
  modelName: string;
  llmApiKey: string;
  workspaceDir: string;
}

/** 工具调用循环上限，防止 LLM 无限调用工具导致子进程卡死 */
const MAX_TOOL_ROUNDS = 10;

/** 加载到上下文中的最近历史消息条数 */
const HISTORY_LIMIT = 10;

/**
 * 从 AGENT_CONFIG 的 JSON 解析结果中抽取并校验配置字段。
 * 参考 ipc/authFlows.ts 的 pickAuthFields：JSON.parse 返回是弱类型，必须显式
 * 窄化以保证后续使用安全（strict 模式下不会因 undefined 字段导致运行时错误）。
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
    typeof workspaceDir !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（botUserId/botAccessToken/homeserverUrl/teamRoomId/' +
        'systemPrompt/modelProvider/modelName/llmApiKey/workspaceDir）',
    );
  }
  // modelProvider 收窄到联合类型，不匹配时给明确错误
  if (modelProvider !== 'openai' && modelProvider !== 'anthropic') {
    throw new Error(`不支持的 modelProvider: ${modelProvider}`);
  }
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
  };
}

async function main(): Promise<void> {
  const config = parseConfig(JSON.parse(process.env.AGENT_CONFIG ?? '{}'));

  const client: MatrixClient = createClient({
    baseUrl: config.homeserverUrl,
    userId: config.botUserId,
    accessToken: config.botAccessToken,
  });

  // 注册自动接受邀请：bot 被 owner 邀请进 team room 后需主动 join 才能收发消息。
  // 必须在 startClient 之前注册，否则初始同步回放的 invite 事件会错过。
  // joinRoom 对已是成员的 room 是幂等的（服务端返回成功），故可安全调用。
  client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
    if (membership === 'invite') {
      void client.joinRoom(room.roomId).catch((err: unknown) => {
        process.stderr.write(`加入 room 失败 ${room.roomId}: ${(err as Error).message}\n`);
      });
    }
  });

  // 启动 /sync 长轮询
  await client.startClient({ initialSyncLimit: 20 });

  // 等待首次 PREPARED（初始 sync 完成、room 可读）后再发消息
  await waitForPrepared(client);

  // 显式 join team room（兜底：即使 invite 事件因时序未触发 MyMembership，
  // 这里也能保证 bot 进入 team room）。已加入时服务端幂等返回成功。
  try {
    await client.joinRoom(config.teamRoomId);
  } catch (err) {
    process.stderr.write(`joinRoom team room 失败: ${(err as Error).message}\n`);
  }

  await client.sendEvent(
    config.teamRoomId,
    'm.room.message',
    { msgtype: 'm.text', body: '✅ 已上线，等待任务' },
    '',
  );

  // 监听 room 消息事件；被 @ 提及时执行完整 chat loop
  client.on(ClientEvent.Event, (event: MatrixEvent) => {
    void handleEvent(client, event, config);
  });

  process.stdout.write('Agent runtime 已启动\n');
}

/**
 * 等待客户端进入 PREPARED 同步状态（初始 sync 完成）。
 * PREPARED 之后 SDK 会立即转为 SYNCING 并持续增量同步，这里只在 PREPARED 时 resolve。
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
 * 处理单条事件：仅响应 @ 提及本 bot 的 m.room.message，执行完整 chat loop。
 *
 * @ 提及判断依据 Matrix v11 的 m.mentions 字段（matrix-js-sdk v31 的 IMentions
 * 格式为 { user_ids?: string[]; room?: boolean }，user_ids 是字符串数组）。
 */
async function handleEvent(
  client: MatrixClient,
  event: MatrixEvent,
  config: RuntimeConfig,
): Promise<void> {
  if (event.getType() !== 'm.room.message') return;
  if (event.getSender() === config.botUserId) return; // 忽略自己的消息

  const roomId = event.getRoomId();
  if (!roomId) return;

  const content = event.getContent();
  const body = typeof content.body === 'string' ? content.body : '';

  // Matrix v11 的 m.mentions 字段：{ user_ids: ['@bot:server', ...] }
  const mentions = content['m.mentions'] as { user_ids?: string[] } | undefined;
  const mentioned = mentions?.user_ids?.includes(config.botUserId) ?? false;
  if (!mentioned) return;

  try {
    await runChatLoop(client, roomId, body, config);
  } catch (err) {
    // chat loop 整体异常（如 LLM API 不可达）时通知用户，不让子进程静默卡死
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
 * 完整 chat loop：组装上下文 → 循环调用 LLM（含工具执行）→ 发送最终回复。
 */
async function runChatLoop(
  client: MatrixClient,
  roomId: string,
  currentBody: string,
  config: RuntimeConfig,
): Promise<void> {
  const llm = createLLMProvider(
    { provider: config.modelProvider, model: config.modelName },
    config.llmApiKey,
  );
  const wsFs = new WorkspaceFS(config.workspaceDir);

  // 组装消息上下文：system + 历史（按时间正序）+ 当前消息
  const messages: LLMMessage[] = [
    { role: 'system', content: config.systemPrompt },
    ...loadRecentHistory(client, roomId, config),
    { role: 'user', content: currentBody },
  ];

  const tools = getBuiltinToolDefs();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await llm.chat(messages, tools);

    // 有工具调用 → 执行后把 assistant 消息 + 各 tool result 追加到上下文，继续循环
    if (response.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });
      for (const tc of response.toolCalls) {
        try {
          const result = await executeBuiltinTool(tc.name, tc.arguments, wsFs);
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

    // 无工具调用 → 最终文本回复
    const reply = response.content.trim() || '(空回复)';
    await client.sendEvent(
      roomId,
      'm.room.message',
      { msgtype: 'm.text', body: reply },
      '',
    );
    return;
  }

  // 达到循环上限仍未给出最终回复：告知用户，避免对话无声中断
  process.stderr.write(`chat loop 达到 ${MAX_TOOL_ROUNDS} 轮上限仍未结束\n`);
  await client.sendEvent(
    roomId,
    'm.room.message',
    {
      msgtype: 'm.text',
      body: `⚠️ 工具调用达到 ${MAX_TOOL_ROUNDS} 轮上限，已停止`,
    },
    '',
  );
}

/**
 * 从 room 的 live timeline 抽取最近 HISTORY_LIMIT 条 m.room.message 历史，
 * 映射为 LLM 消息（bot 自己发的 → assistant，其他人发的 → user），按时间正序返回。
 * 不包含当前刚收到的事件（调用方已作为当前 user 消息追加）。
 */
function loadRecentHistory(
  client: MatrixClient,
  roomId: string,
  config: RuntimeConfig,
): LLMMessage[] {
  const room: Room | null = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline().getEvents();
  // 排除最后一条（即当前正在处理的事件），取其前 HISTORY_LIMIT 条消息事件
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
