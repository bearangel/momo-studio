// electron/src/main/task/dependency-gate.ts
//
// M4.3 派发闸拒绝文案单源（spec 2026-10-29 §2.3.1）。
// 三处外派委派发送点共用（dispatch-submit.submitRoutedTask 提交前 /
// hub:taskDelegate 直通道 / delegation-sync.retryDispatch 重派路径）——抽取自
// retryDispatch M3.3 既有闸（delegation-sync.test.ts E-1 锁逐字一致），禁止
// 各入口复制漂移；「未完成」判定单源仍在 dependencies-repo.deriveBlockedBy
// （unsatisfiedDeps——仅 completed 解锁）。
/** blocked 外派行的统一人话拒绝（blockedBy = 未完成直接依赖 id 列表，blocked=true 时非空） */
export function blockedDispatchError(blockedBy: ReadonlyArray<string>): Error {
  return new Error(`任务存在未完成依赖（${blockedBy.join('、')}），依赖完成前不可派发`);
}

