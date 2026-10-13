// 056_system_sender_flip.ts
//
// 存量 dispatch 回执行 / followup 追问行 sender 翻新（spec 2026-10-13 §5.7，
// dispatch 回执 P0-A）。
//
// 背景：写入侧（deliverChainResult / chain-writer）已改为 sender='system'，
// 生产新行不再落 'owner'；本迁移只管存量行与旧库升级路径——历史回执/
// 追问行以 'owner' 落库，重启后渲染层把它们当真实用户消息展示（头像 /
// 未读语义错乱），统一翻 'system'。
//
// 翻新语义（双特征防误伤）：sender='owner' 且 task_id 非空，且满足任一：
//   - body 以「【dispatch 回执自动送达】」前缀开头（dispatch 回执行）
//   - parent_stream_session_id 非空（followup 追问行）
// 真实用户行不带 task_id；带 task_id 但无上述回执特征的普通用户行不命中。

export interface Migration056 {
  version: number;
  up: string;
}

export const migration056: Migration056 = {
  version: 56,
  up: `
-- v56：存量 dispatch 回执行 / followup 追问行 sender='owner' → 'system'
UPDATE messages
SET sender = 'system'
WHERE sender = 'owner'
  AND task_id IS NOT NULL
  AND (
    body LIKE '【dispatch 回执自动送达】%'
    OR parent_stream_session_id IS NOT NULL
  );
`,
};
