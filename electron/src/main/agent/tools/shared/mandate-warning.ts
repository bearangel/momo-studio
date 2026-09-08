// electron/src/main/agent/tools/shared/mandate-warning.ts
//
// 持久副作用软门禁文案（spec §5.3）——task-tools 与 memory-tools 共享，避免双份漂移。
//
// 用途：create_task / memory_save 这类会留下持久副作用的操作，当本轮没有
// `source=user` 的未完成 todo 挂靠时，附加本 warning 提醒 agent「此操作未
// 挂靠到本轮用户请求」——不阻断操作，仅提示 agent 自觉核对授权边界。
export const SIDEEFFECT_UNLINKED_WARNING =
  '⚠ 本操作未挂靠到本轮用户请求（当前无 source=user 待办项）。若确属用户本轮请求范围，' +
  '请先用 todowrite 建立对应 user 待办；若属你自行发起的工作，请先向用户说明并获同意。' +
  '本警告不阻断操作。';