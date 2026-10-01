// electron/tests/agent/runtime-config-lsp.test.ts
// AGENT_CONFIG.lspLanguages 契约锁（boundary-rules 铁律 4——协议字段两端同步改）：
// 生产端 spawn-helpers buildSpawnOpts 注入检测快照，消费端 parseConfig 归一 +
// LspTools.create 以非空门控。本文件锁 parseConfig 一跳的归一语义（纯函数，
// 不触 DB / fs）。
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/main/agent/runtime-config';

/** 最小合法 AGENT_CONFIG（lspLanguages 可选覆盖） */
function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentAssignmentId: 'inst-1',
    agentUserId: 'agent-x',
    systemPrompt: '',
    modelName: 'm',
    llmApiKey: 'k',
    workspaceDir: '/tmp/ws',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

describe('parseConfig.lspLanguages 归一', () => {
  it('字符串数组原样通过；非字符串项过滤', () => {
    const c = parseConfig(rawConfig({ lspLanguages: ['typescript', 'go', 42, null] }));
    expect(c.lspLanguages).toEqual(['typescript', 'go']);
  });

  it('缺省 / 非数组 → []（旧 AGENT_CONFIG 兼容 = 不注册 LSP 工具）', () => {
    expect(parseConfig(rawConfig()).lspLanguages).toEqual([]);
    expect(parseConfig(rawConfig({ lspLanguages: 'typescript' })).lspLanguages).toEqual([]);
    expect(parseConfig(rawConfig({ lspLanguages: null })).lspLanguages).toEqual([]);
  });
});
