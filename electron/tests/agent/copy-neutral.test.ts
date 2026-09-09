// electron/tests/agent/copy-neutral.test.ts
//
// 文案回归锁（spec §5.6 / §11-3 + 压缩改造 spec §6.3）：锁死中性化关键串，防止
// 回退到「继续工作」类前进祈使句。
// 实现侧：prompt-hints.ts / builtin-tools.ts / memory-tools.ts / runtime-entry.ts。
// 压缩改造 Task 5：>30 压缩建议提示已退役（buildCompactSuggestHint 删除，auto
// 阈值取代自觉提示）——本锁改为锁定 compact 新工具描述「无需你撰写总结」类
// 关键串（意图不弱化：LLM 无总结书写义务 + 无前进指令）。

import { describe, it, expect } from 'vitest';
import { formatDispatchHint } from '../../src/main/agent/prompt-hints';
import { getBuiltinLoopToolDefs } from '../../src/main/agent/builtin-tools';
import { MemoryTools } from '../../src/main/agent/tools/memory-tools';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

describe('文案中性化回归锁（spec §5.6 任务 2 + 压缩改造 §6.3）', () => {
  it('compact 新描述锁「无需你撰写总结」，schema 无 summary 义务参数', () => {
    const compact = getBuiltinLoopToolDefs().find((t) => t.name === 'compact')!;
    // 摘要由专用链路生成——LLM 无总结书写义务（意图不弱化的新锁点）
    expect(compact.description).toContain('无需你撰写总结');
    expect(compact.description).toContain('保留最近若干轮原文');
    expect(compact.description).not.toContain('继续工作');
    // schema：summary 参数已删，仅剩可选 note（压缩动机备注）
    const schema = JSON.stringify(compact.inputSchema);
    expect(compact.inputSchema.properties).toHaveProperty('note');
    expect(schema).not.toContain('summary');
    expect(compact.inputSchema.required).toBeUndefined();
  });

  it('dispatch 教学限定当前任务语境，不含无条件「不要全部自己做」', () => {
    const config: RuntimeConfig = {
      agentAssignmentId: 'inst-bot',
      agentUserId: '@bot:localhost',
      systemPrompt: 'You are a test bot.',
      modelName: 'test-model',
      llmApiKey: 'test-key',
      workspaceDir: '/tmp/test',
      workspaceId: 'ws-1',
      role: 'main',
      subAgents: [{ slug: 'coder', assignmentId: 'a1', description: '编码' }],
      skills: [],
      mcpNames: [],
      allowedTools: [],
      deniedTools: [],
      isLeader: true,
      devMode: false,
      maxToolCalls: 10,
      contextWindow: 0,
      outputTokens: 0,
    };
    const hint = formatDispatchHint(config);
    expect(hint).toContain('当前任务');
    expect(hint).not.toContain('不要全部自己做');
    expect(hint).not.toContain('继续工作');
  });

  it('task_complete 的 nextStep 声明非新任务授权', () => {
    const tc = getBuiltinLoopToolDefs().find((t) => t.name === 'task_complete')!;
    expect(JSON.stringify(tc.inputSchema)).toContain('不是新任务授权');
    expect(JSON.stringify(tc.inputSchema)).not.toContain('继续工作');
  });

  it('memory_save 描述含证据核实约束', () => {
    const save = new MemoryTools().getDefs().find((t) => t.name === 'memory_save')!;
    expect(save.description).toContain('核实原始证据');
  });
});
