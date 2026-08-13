// electron/src/main/memory/index.ts
//
// MemoryProvider 单例 + 类型导出。
//
// 调用方统一通过 getMemoryProvider() 取实例，便于将来替换为 FullMemoryProvider
// （LLM 总结 + 向量检索 + agent 经验学习）时只改这一处。
//
// 测试用 setter：
//   - __setMemoryProviderForTest(p)：注入 mock 或替代实现
//   - __resetMemoryProviderForTest()：重置回默认 SQLiteMemoryProvider
//
// 设计参考 runtime-manager.ts 的 singleton 模式。
import { SQLiteMemoryProvider } from './sqlite-provider';
import type { MemoryProvider } from './types';

let provider: MemoryProvider | null = null;

/**
 * 取 MemoryProvider 单例。
 *
 * 首次调用时惰性初始化为 SQLiteMemoryProvider（v1 默认实现）。
 * 替代实现通过 __setMemoryProviderForTest 注入。
 */
export function getMemoryProvider(): MemoryProvider {
  if (!provider) {
    provider = new SQLiteMemoryProvider();
  }
  return provider;
}

/**
 * 测试用：替换 provider（如注入 mock / FullMemoryProvider preview）。
 */
export function __setMemoryProviderForTest(p: MemoryProvider): void {
  provider = p;
}

/**
 * 测试用：重置为默认 SQLiteMemoryProvider（下次 getMemoryProvider 时惰性重建）。
 */
export function __resetMemoryProviderForTest(): void {
  provider = null;
}

// 重新导出 types 给调用方统一从 '@/main/memory' 取
export type {
  MemoryProvider,
  TaskContext,
  ConversationContext,
  AgentContext,
  UserContext,
  WorkspaceContext,
  TaskEventSummary,
  FileChange,
  ContextMessage,
} from './types';