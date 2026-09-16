// electron/src/main/im/commands.ts
//
// 会话斜杠命令注册表（v2.11，spec 2026-09-16 §6.1）——单一真相源：
//   - / 菜单命令组数据（session:listCommands → renderer）
//   - handleSessionCommand 查表分发
// 新增命令 = 在此追加一条 + handler 挂到 session-service 的分发映射。
export interface SessionCommandDef {
  name: string;
  description: string;
}

export const SESSION_COMMANDS: readonly SessionCommandDef[] = [
  { name: 'compact', description: '压缩会话历史，释放上下文窗口' },
];

export function isKnownSessionCommand(name: string): boolean {
  return SESSION_COMMANDS.some((c) => c.name === name);
}