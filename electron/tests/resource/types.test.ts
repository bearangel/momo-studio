// electron/tests/resource/types.test.ts
//
// v1.7 资源库类型 + ID 工具的单元测试。覆盖：
//   1. buildResourceId 拼接命名约定
//   2. parseResourceId 反解三元组（含 UUID slug）
//   3. parseResourceId 非法 id 返回 null（空 slug / 未知 source / 未知 type）
//   4. buildResourceId ↔ parseResourceId 互逆
//   5. sourceLabel 中文文案
//   6. hub 契约锁（smithery 源；modelscope 已于 P2.1 移除）

import { describe, it, expect } from 'vitest';
import {
  buildResourceId, parseResourceId, sourceLabel,
  type ResourceItem, type ResourceFilter,
} from '../../src/main/resource/types';

describe('resource/types', () => {
  it('buildResourceId 拼 ${source}-${type}-${slug}', () => {
    expect(buildResourceId('builtin', 'agent', 'pm-agent')).toBe('builtin-agent-pm-agent');
    expect(buildResourceId('custom', 'mcp', 'github')).toBe('custom-mcp-github');
    expect(buildResourceId('custom', 'agent', 'uuid-abc-123')).toBe('custom-agent-uuid-abc-123');
  });

  it('parseResourceId 反解三元组', () => {
    expect(parseResourceId('builtin-skill-code-review')).toEqual({
      source: 'builtin', type: 'skill', slug: 'code-review',
    });
    expect(parseResourceId('custom-agent-abc-123-def')).toEqual({
      source: 'custom', type: 'agent', slug: 'abc-123-def',
    });
  });

  it('parseResourceId 非法 id 返回 null', () => {
    expect(parseResourceId('invalid')).toBeNull();
    expect(parseResourceId('builtin-agent-')).toBeNull();  // 空 slug
    expect(parseResourceId('unknown-agent-foo')).toBeNull();  // 未知 source
    expect(parseResourceId('builtin-unknown-foo')).toBeNull();  // 未知 type
  });

  it('buildResourceId ↔ parseResourceId 互逆', () => {
    const cases = [
      ['builtin', 'agent', 'pm-agent'],
      ['custom', 'mcp', 'github'],
      ['marketplace', 'skill', 'xlsx-remote'],
    ] as const;
    for (const [s, t, slug] of cases) {
      const id = buildResourceId(s, t, slug);
      expect(parseResourceId(id)).toEqual({ source: s, type: t, slug });
    }
  });

  it('sourceLabel 中文文案', () => {
    expect(sourceLabel('builtin')).toBe('系统预置');
    expect(sourceLabel('custom')).toBe('我的上传');
    expect(sourceLabel('marketplace')).toBe('网络资源');
    expect(sourceLabel('p2p')).toBe('P2P 共享');
  });
});

// hub 契约锁：smithery 源加入枚举。后续 7 个 task（adapter / IPC / store / UI）
// 都依赖此契约，形状在此锁死。modelscope 轨已于 P2.1 整体移除（registry 100%
// hosted 后放弃），P3 若公开 API 落地再评估。
describe('ResourceSource 扩展（P2 双轨 hub）', () => {
  it('parseResourceId 解析 smithery 前缀', () => {
    expect(parseResourceId('smithery-mcp-@owner/server')).toEqual({
      source: 'smithery', type: 'mcp', slug: '@owner/server',
    });
  });
  it('buildResourceId 往返一致', () => {
    expect(buildResourceId('smithery', 'mcp', 'a-b')).toBe('smithery-mcp-a-b');
  });
  it('sourceLabel 新增源有中文标签', () => {
    expect(sourceLabel('smithery')).toBe('Smithery');
  });
  it('未知前缀仍拒绝', () => {
    expect(parseResourceId('evil-mcp-x')).toBeNull();
    // P2.1 移除 modelscope 后其前缀回落为未知 source——反解必须拒绝
    expect(parseResourceId('modelscope-mcp-x')).toBeNull();
  });
});

// P2.2 Task 6 契约锁：ResourceItem.custom 加可选 transport（双镜像——此处锁
// electron 侧 resource/types.ts；renderer types.d.ts 镜像由双 workspace
// typecheck 编译期保证）。ResourceDetail「配置」按钮显示条件
// （custom.transport === 'streamable_http'）消费该字段（spec §6.1）。
describe('ResourceItem.custom.transport（P2.2 Task 6）', () => {
  /** 最小合法 ResourceItem 构造（custom 段由各用例覆写） */
  function baseItem(custom: ResourceItem['custom']): ResourceItem {
    return {
      id: 'custom-mcp-github',
      type: 'mcp',
      source: 'custom',
      slug: 'github',
      name: 'github',
      description: 'd',
      installed: true,
      installable: false,
      removable: true,
      custom,
    };
  }

  it('MCP custom 项可携带 transport（stdio / streamable_http 双形态）', () => {
    expect(baseItem({ installedAt: '2026-09-23T00:00:00Z', transport: 'stdio' }).custom?.transport)
      .toBe('stdio');
    expect(
      baseItem({ installedAt: '2026-09-23T00:00:00Z', transport: 'streamable_http' }).custom?.transport,
    ).toBe('streamable_http');
  });

  it('transport 可选：存量 custom 项（skill / agent / 旧 mcp 行）不带该字段仍合法', () => {
    const item = baseItem({ installedAt: '2026-09-23T00:00:00Z' });
    expect(item.custom?.transport).toBeUndefined();
  });
});
