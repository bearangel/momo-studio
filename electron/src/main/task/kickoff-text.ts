// electron/src/main/task/kickoff-text.ts
//
// 任务闭合义务段文案（语义单源）：本地任务 kickoff（executor.buildKickoffBody）
// 与委派执行方回合体（hub/run-policy.composeTurnBody）共用——两处都必须让
// agent 知道「结束须关闭任务」，否则 agent 当普通聊天答完即终。
// 纯常量模块（零依赖零副作用）：run-policy 是纯函数模块，不得经此引入
// executor 的单例/DB 依赖链。
export const KICKOFF_CLOSURE_MANDATE =
  '本回合由任务简报触发；结束时必须调用 submit_task（交付）或 fail_task（失败）关闭任务；需要人帮助请用 request_human。';
