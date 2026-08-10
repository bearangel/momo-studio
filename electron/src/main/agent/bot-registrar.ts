// electron/src/main/agent/bot-registrar.ts
//
// 在 Conduwuit 上注册一个 agent bot 账号，并把 access token 存入 keychain。
// bot 用户名遵循 <slug>.<workspaceSlug>.<ownerLocalpart> 规则，保证在同一
// homeserver 上唯一且可读。注册使用 m.login.dummy（Conduit 的免认证流程），
// 与 ipc/authFlows.ts 的用户注册行为一致。
//
// 注册成功后 access token 以 `bot.<botUserId>.matrix_token` 为 key 存入
// keychain，命名与用户 token（`user.<userId>.matrix_token`）平行，便于按前缀
// 区分人/机器人凭据。

import { randomBytes } from 'node:crypto';
import { createMatrixClient } from '../matrix/client';
import { setSecret } from '../storage/keychain';
import { logger } from '../logger';

/** registerAgentBot 的入参 */
export interface RegisterAgentBotOpts {
  /** agent slug，如 'requirement-analyst' */
  slug: string;
  /** workspace 名（用于生成 bot 用户名中的 workspace 段） */
  workspaceName: string;
  /** owner 的 Matrix user ID，如 '@alice:localhost' */
  ownerUserId: string;
  /** homeserver base URL，如 'http://127.0.0.1:8008' */
  homeserverUrl: string;
}

/** registerAgentBot 的返回值 */
export interface RegisteredBot {
  botUserId: string;
  botAccessToken: string;
  botDeviceId: string;
}

/** matrix-js-sdk register 返回值中我们关心的字段子集（弱类型，需手动校验） */
interface BotRegisterResponse {
  user_id?: string;
  access_token?: string;
  device_id?: string;
}

/** 从 '@alice:localhost' 中提取 localpart 'alice'；非标准格式原样返回 */
function extractLocalpart(ownerUserId: string): string {
  const match = /^@([^:]+):/.exec(ownerUserId);
  return match?.[1] ?? ownerUserId;
}

/** 规范化为合法 Matrix localpart 段：小写、连续非字母数字折叠为单短横线，去除首尾短横线 */
function slugifySegment(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 生成 32 字符随机密码（base64url 字母表），仅用于 bot 账号注册 */
function generateBotPassword(): string {
  return randomBytes(24).toString('base64url').slice(0, 32);
}

/** 生成 6 字符随机后缀，避免同名 bot 重建时与 Matrix 服务器上残留账号冲突 */
function randomSuffix(): string {
  return randomBytes(4).toString('base64url').slice(0, 6);
}

/**
 * 注册一个 agent bot 账号到 Conduwuit，并把 access token 存入 keychain。
 *
 * bot 用户名规则：<slug>.<workspaceSlug>.<ownerLocalpart>.<shortId>
 * 例如 slug=requirement-analyst, workspace=proj-x, owner=@alice:localhost
 *   → username = requirement-analyst.proj-x.alice.aB3xY9
 *
 * 末尾的 6 字符随机后缀保证：即使删除 agent 后 Matrix 服务器上的账号仍存在，
 * 重新创建同名 agent 也不会触发 M_USER_IN_USE 冲突。
 */
export async function registerAgentBot(opts: RegisterAgentBotOpts): Promise<RegisteredBot> {
  const slug = slugifySegment(opts.slug);
  const workspaceSlug = slugifySegment(opts.workspaceName);
  const ownerLocalpart = slugifySegment(extractLocalpart(opts.ownerUserId));

  if (!slug || !workspaceSlug || !ownerLocalpart) {
    throw new Error('无法从入参生成合法的 bot 用户名（slug/workspaceName/ownerUserId 任一为空）');
  }
  const username = `${slug}.${workspaceSlug}.${ownerLocalpart}.${randomSuffix()}`;

  // createMatrixClient 仅做 baseUrl 配置；register 不需要已有 session。
  const client = createMatrixClient({ baseUrl: opts.homeserverUrl });
  // v1.5.8：保留 password 用于 Conduwuit 重启后自动 re-login（access token 在
  // Conduwuit 是内存态，进程重启即丢，仅靠 token 无法恢复 bot 会话）
  const password = generateBotPassword();
  const raw: unknown = await client.register(username, password, null, {
    type: 'm.login.dummy',
  });

  // matrix-js-sdk 的 register 返回是弱类型，统一在此窄化为受控字段并校验。
  const response = raw as BotRegisterResponse;
  if (
    typeof response.user_id !== 'string' ||
    typeof response.access_token !== 'string' ||
    typeof response.device_id !== 'string'
  ) {
    throw new Error('Bot 注册返回缺少必要字段（user_id / access_token / device_id）');
  }

  await setSecret(`bot.${response.user_id}.matrix_token`, response.access_token);
  await setSecret(`bot.${response.user_id}.matrix_password`, password);
  logger.info('Agent bot 已注册', { botUserId: response.user_id, username });

  return {
    botUserId: response.user_id,
    botAccessToken: response.access_token,
    botDeviceId: response.device_id,
  };
}
