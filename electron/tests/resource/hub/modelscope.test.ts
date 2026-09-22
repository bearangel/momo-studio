// electron/tests/resource/hub/modelscope.test.ts
//
// 魔搭 provider 骨架行为锁（P2 Task 5 附带小项，Task 4 审查 Minor 折入）。
// Task 0 降级裁定：OpenAPI 端点探测 404×3、无公开文档化 MCP 列表接口——
// 骨架恒 degraded、零网络。本文件三用例锁死骨架行为，防止 P3 复核前被误改
// （详见 .superpowers/sdd/task-0-api-verify.md「魔搭 ModelScope——降级裁定」）。

import { describe, it, expect } from 'vitest';
import {
  modelscopeProvider,
  isModelScopeDegraded,
} from '../../../src/main/resource/hub/modelscope';

describe('魔搭 provider 骨架（Task 0 降级裁定锁）', () => {
  it('list 恒 degraded + 空 entries（零网络）', async () => {
    const result = await modelscopeProvider.list('mcp');
    expect(result).toEqual({ entries: [], degraded: true });
    // 带 query 也一样——骨架不消费检索词
    expect(await modelscopeProvider.list('mcp', '天气')).toEqual({
      entries: [],
      degraded: true,
    });
  });

  it('非 mcp 类型抛「暂只支持 MCP」', async () => {
    await expect(modelscopeProvider.list('agent')).rejects.toThrow(/暂只支持 MCP/);
  });

  it('isModelScopeDegraded 恒 true（P3 复核后恢复）', () => {
    expect(isModelScopeDegraded()).toBe(true);
  });
});
