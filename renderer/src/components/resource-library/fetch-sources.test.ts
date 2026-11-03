// renderer/src/components/resource-library/fetch-sources.test.ts
// AddMenu 远端组顺序锁（library-store-split 预览 §B 定值）：2026-11-02 网络获取
// 下线后远端仅 momo-hub 一项（网络市场 / Smithery 已退役）；四页副文案逐页锁死；
// 首项带 separatorBefore。
import { describe, it, expect, vi } from 'vitest';
import { ArrowRightLeft } from 'lucide-react';
import { buildRemoteFetchItems, FETCH_PROVIDER_KEY } from './fetch-sources';

describe('buildRemoteFetchItems — 远端组顺序锁（hub 单源）', () => {
  it('agent 页：仅 hub 一项；带分隔线标记与组内共享文案', () => {
    const items = buildRemoteFetchItems('agent', vi.fn());
    expect(items.map((i) => i.key)).toEqual(['fetch-hub']);
    expect(items[0]).toMatchObject({
      title: '从 momo-hub 获取…',
      hint: '您接入的 hub 节点目录，组内共享资源',
      icon: ArrowRightLeft,
      separatorBefore: true,
    });
  });

  it('mcp / skill / plugin 页同形态（极简化回归锁——marketplace/smithery 项不回潮）', () => {
    expect(buildRemoteFetchItems('mcp', vi.fn()).map((i) => i.key)).toEqual(['fetch-hub']);
    expect(buildRemoteFetchItems('mcp', vi.fn())[0]!.hint).toBe('您接入的 hub 节点目录');
    expect(buildRemoteFetchItems('skill', vi.fn()).map((i) => i.key)).toEqual(['fetch-hub']);
    expect(buildRemoteFetchItems('skill', vi.fn())[0]!.hint).toBe('您接入的 hub 节点目录，组内共享资源');
    expect(buildRemoteFetchItems('plugin', vi.fn()).map((i) => i.key)).toEqual(['fetch-hub']);
  });

  it('open 回调透传源', () => {
    const open = vi.fn();
    buildRemoteFetchItems('mcp', open).forEach((i) => i.onSelect());
    expect(open.mock.calls).toEqual([['hub']]);
  });
});

describe('FETCH_PROVIDER_KEY', () => {
  it('registryList providerKey 映射（hub 单源）', () => {
    expect(FETCH_PROVIDER_KEY).toEqual({ hub: 'hub' });
  });
});
