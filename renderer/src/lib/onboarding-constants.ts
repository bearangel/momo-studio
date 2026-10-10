// renderer/src/lib/onboarding-constants.ts
//
// 需求文本上限（renderer 展示计数用）。权威截断在主进程
// electron/src/main/onboarding/plan-generator.ts 的 MAX_REQUIREMENT_CHARS——
// 双端常量同值维护（跨 workspace 不能共享 import，rootDir 边界）。
export const MAX_REQUIREMENT_CHARS = 4000;
