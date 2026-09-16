// electron/src/main/storage/migrations/036_v2_11_message_context.ts
//
// v36：v2.11 输入框上下文系统——messages 表新增 context_json 列（nullable TEXT）。
// 存放 MessageContext 序列化（metadata 级——skill slug + 展示名 / 文件相对路径）；
// skill 正文与文件内容绝不落库（主进程派发时渐进展开，spec 2026-09-16 §5.3）。
//
// 契约：wire 是 MessageRow 直通（camelCase contextJson），主进程不在推送侧做
// context 解析变换（避免每个推送点遗漏）。renderer 消费时用 parseMessageContext
// 解析；落库 / 读出全字段直通。
//
// nullable：旧消息行 / 无上下文消息 context_json = NULL，无需回填即可保持旧行为。
import type { Migration } from '.';

export const migration036: Migration = {
  version: 36,
  sql: `ALTER TABLE messages ADD COLUMN context_json TEXT NULL;`,
};
