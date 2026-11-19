// electron/src/main/agent/tools/shared/plugin-ref.ts
//
// 插件工具全名匹配（精确名 / plugin:<id>/* 组模式）——单一真相源。
// 主进程装配侧（assembly）与子进程 loader（plugin-tools）共消费：两侧匹配
// 语义必须一致（2026-11-19 口径分裂教训：装配侧用文件名、授权侧用工具名，
// 单文件多工具插件的精确授权永远落空）。本模块保持 child 安全：不得 import
// electron / storage（子进程经 tsc 产物直接 require）。

/** 工具全名匹配：精确名或 plugin:<id>/* 组模式（与 deniedTools 同款语义） */
export function toolRefMatches(fullName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === fullName) return true;
    if (p.endsWith('/*') && fullName.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}
