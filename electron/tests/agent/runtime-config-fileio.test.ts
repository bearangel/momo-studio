// electron/tests/agent/runtime-config-fileio.test.ts
//
// parseConfig 的 fileIoMode 字段回归锁（Task 7）：缺省 direct（旧 AGENT_CONFIG
// 兼容）+ 'proxy' 透传 + 非法值回退 direct（fail-safe）。
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/main/agent/runtime-config';

/** 最小合法 AGENT_CONFIG 载荷（仅必填字段） */
function baseRaw(): Record<string, unknown> {
  return {
    agentAssignmentId: 'assign-1',
    agentUserId: 'agent-t-ab12cd',
    systemPrompt: 'sp',
    modelName: 'gpt-4o',
    llmApiKey: 'sk-x',
    workspaceDir: '/tmp/ws',
    workspaceId: 'ws-1',
  };
}

describe('parseConfig fileIoMode（Task 7 回归锁）', () => {
  it('缺省 → direct（旧版本 spawn 载荷兼容）', () => {
    expect(parseConfig(baseRaw()).fileIoMode).toBe('direct');
  });

  it("fileIoMode='proxy' → 透传", () => {
    expect(parseConfig({ ...baseRaw(), fileIoMode: 'proxy' }).fileIoMode).toBe('proxy');
  });

  it("fileIoMode='direct' → 透传", () => {
    expect(parseConfig({ ...baseRaw(), fileIoMode: 'direct' }).fileIoMode).toBe('direct');
  });

  it('非法值（auto / 字符串噪声 / 非字符串）→ 回退 direct（fail-safe）', () => {
    expect(parseConfig({ ...baseRaw(), fileIoMode: 'auto' }).fileIoMode).toBe('direct');
    expect(parseConfig({ ...baseRaw(), fileIoMode: 42 }).fileIoMode).toBe('direct');
  });
});
