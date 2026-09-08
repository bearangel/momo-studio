// electron/tests/agent/copy-neutral.test.ts
//
// 文案回归锁（spec §5.6 / §11-3）：锁死中性化关键串，防止回退到「继续工作」类前进祈使句。
// 实现侧：prompt-hints.ts / builtin-tools.ts / memory-tools.ts / runtime-entry.ts。
// 任务 2 范围：仅 8 处文案中的 5 处（#1/#5/#6/#7/#8），#2/#3/#4 属任务 4。

import { describe, it, expect } from 'vitest';
import { buildCompactSuggestHint, formatDispatchHint } from '../../src/main/agent/prompt-hints';
import { getBuiltinLoopToolDefs } from '../../src/main/agent/builtin-tools';
import { MemoryTools } from '../../src/main/agent/tools/memory-tools';
import type { RuntimeConfig } from '../../src/main/agent/runtime-config';

describe('文案中性化回归锁（spec §5.6 任务 2）', () => {
  it('>30 条压缩建议不含「继续工作」，含授权状态判定引导', () => {
    const hint = buildCompactSuggestHint(36);
    expect(hint).toContain('36');
    expect(hint).not.toContain('继续工作');
    expect(hint).toContain('决定继续或收尾');
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
    };
    const hint = formatDispatchHint(config);
    expect(hint).toContain('当前任务');
    expect(hint).not.toContain('不要全部自己做');
    expect(hint).not.toContain('继续工作');
  });

  it('compact 描述含两节模板且不含无条件继续指令', () => {
    const compact = getBuiltinLoopToolDefs().find((t) => t.name === 'compact')!;
    expect(compact.description).toContain('用户指令');
    expect(compact.description).toContain('agent 备忘');
    expect(compact.description).not.toContain('后续工作基于总结继续');
    expect(compact.description).not.toContain('继续工作');
    expect(JSON.stringify(compact.inputSchema)).toContain('用户指令');
    expect(JSON.stringify(compact.inputSchema)).toContain('agent 备忘');
    expect(JSON.stringify(compact.inputSchema)).not.toContain('继续工作');
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
