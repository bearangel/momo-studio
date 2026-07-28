// electron/src/main/agent/runtime-entry.ts
//
// Agent runtime 子进程入口。由 runtime-manager.ts 通过 fork()/spawn() 启动，
// 配置通过环境变量 AGENT_CONFIG（JSON）传入。
//
// 本文件是简化版骨架：登录 Matrix → 等待首次 sync(PREPARED) → 在 team room
// 发"已上线"消息 → 监听 @ 提及并回执。完整的 chat loop（LLM 调用 + 工具执行）
// 在后续任务（T14+T15）实现。
//
// 注意：此入口运行在独立子进程中，不要 import 主进程的 logger（electron-log
// 依赖主进程的路径解析），统一用 process.stdout/stderr 输出，由父进程
// runtime-manager 转发到主日志。

import { createClient, ClientEvent, SyncState, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';

/** runtime-manager 通过 AGENT_CONFIG 传入的配置（仅需本骨架用到的字段） */
interface RuntimeConfig {
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  teamRoomId: string;
  // 其余字段（instanceId/systemPrompt/modelProvider/modelName/llmApiKey/
  // workspaceDir 等）预留给 T14+T15 的完整 chat loop，本骨架不消费。
}

/**
 * 从 AGENT_CONFIG 的 JSON 解析结果中抽取并校验本骨架所需字段。
 * 参考 ipc/authFlows.ts 的 pickAuthFields：JSON.parse 返回是弱类型，必须显式
 * 窄化以保证后续使用安全（strict 模式下不会因 undefined 字段导致运行时错误）。
 */
function parseConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AGENT_CONFIG 不是合法 JSON 对象');
  }
  const r = raw as Record<string, unknown>;
  const { botUserId, botAccessToken, homeserverUrl, teamRoomId } = r;
  if (
    typeof botUserId !== 'string' ||
    typeof botAccessToken !== 'string' ||
    typeof homeserverUrl !== 'string' ||
    typeof teamRoomId !== 'string'
  ) {
    throw new Error(
      'AGENT_CONFIG 缺少必要字段（botUserId/botAccessToken/homeserverUrl/teamRoomId）',
    );
  }
  return { botUserId, botAccessToken, homeserverUrl, teamRoomId };
}

async function main(): Promise<void> {
  const config = parseConfig(JSON.parse(process.env.AGENT_CONFIG ?? '{}'));

  const client: MatrixClient = createClient({
    baseUrl: config.homeserverUrl,
    userId: config.botUserId,
    accessToken: config.botAccessToken,
  });

  // 启动 /sync 长轮询
  await client.startClient({ initialSyncLimit: 20 });

  // 等待首次 PREPARED（初始 sync 完成、room 可读）后再发消息
  await waitForPrepared(client);

  await client.sendEvent(
    config.teamRoomId,
    'm.room.message',
    { msgtype: 'm.text', body: '✅ 已上线，等待任务' },
    '',
  );

  // 监听 room 消息事件；被 @ 提及时回执（完整 chat loop 在 T14+T15）
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

/** 处理单条事件：仅响应 @ 提及本 bot 的 m.room.message */
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

  await client.sendEvent(
    roomId,
    'm.room.message',
    {
      msgtype: 'm.text',
      body: `[${config.botUserId}] 收到消息: "${body.slice(0, 50)}..." — chat loop 尚未实现`,
    },
    '',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
