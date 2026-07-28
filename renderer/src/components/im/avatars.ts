// renderer/src/components/im/avatars.ts
//
// 消息卡片共用的用户标识工具：从 Matrix userId 生成稳定的 emoji 头像与短名。

const AVATAR_EMOJIS = ['🦊', '🐱', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🦉', '🐧'];

/** 基于用户 ID 稳定哈希生成 emoji 头像（同一用户始终得到同一 emoji） */
export function avatarEmoji(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_EMOJIS[Math.abs(hash) % AVATAR_EMOJIS.length]!;
}

/** 从 Matrix userId（如 @alice:localhost）提取短名（alice）；无前缀时原样返回 */
export function shortName(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match?.[1] ?? userId;
}
