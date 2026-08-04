// electron/src/main/agent/tools/todo-types.ts
// v1.5 TodoTools 共享类型。被 stream-chunk.ts / todo-tools.ts 与 renderer 共同引用，
// 因此独立成文件避免循环依赖（stream-chunk 不能从 todo-tools 导入，否则 types.ts →
// stream-chunk → todo-tools → types.ts 形成环）。

/** 单条任务项。id 由 todo-tools 内部 randomUUID() 生成。 */
export interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
}
