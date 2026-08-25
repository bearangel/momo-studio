// renderer/src/components/im/avatars.ts
//
// 消息卡片共用的用户标识工具：从用户 ID 生成稳定的 emoji 头像与短名。
// 用户 ID 有两类形态：
//   - 本地 Matrix 风格（如 @alice:localhost）
//   - P2P 远端消息 sender（remote:<节点ID>[:<原始sender>]，由主进程 sync 层强制
//     命名空间化——远端消息不可能伪装本地身份）

const AVATAR_EMOJIS = ['🦊', '🐱', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🦉', '🐧'];

/** 基于用户 ID 稳定哈希生成 emoji 头像（同一用户始终得到同一 emoji） */
export function avatarEmoji(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_EMOJIS[Math.abs(hash) % AVATAR_EMOJIS.length]!;
}

/** P2P 远端 sender 前缀（与 electron/src/main/p2p/sync.ts 的命名空间化格式对齐） */
const REMOTE_PREFIX = /^remote:([^:]+)(?::(.*))?$/;

/**
 * 从用户 ID 提取短名。
 * - Matrix userId（如 @alice:localhost）→ alice
 * - remote:<nodeId>:<原始sender> → 剥离前缀后递归取原始 sender 短名（嵌套转发逐层剥离）
 * - remote:<nodeId>（对端本机用户消息）→ 节点 ID 去 node_ 前缀（无更友好名称可解析时兜底）
 * - 无前缀时原样返回
 */
export function shortName(userId: string): string {
  const remote = REMOTE_PREFIX.exec(userId);
  if (remote) {
    const rest = remote[2];
    if (rest !== undefined && rest !== '') return shortName(rest);
    return remote[1]!.replace(/^node_/, '');
  }
  const match = /^@([^:]+):/.exec(userId);
  return match?.[1] ?? userId;
}
