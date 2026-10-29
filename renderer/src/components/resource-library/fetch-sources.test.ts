// renderer/src/components/resource-library/fetch-sources.test.ts
// AddMenu 远端组顺序锁（library-store-split 预览 §B 定值）：hub 永远置顶 →
// 网络市场 → Smithery（仅 mcp）；四页副文案逐页锁死；首项带 separatorBefore。
import { describe, it, expect, vi } from 'vitest';
import { ArrowRightLeft, Globe, Hammer } from 'lucide-react';
import { buildRemoteFetchItems, sourceSupportsType, FETCH_PROVIDER_KEY } from './fetch-sources';

describe('buildRemoteFetchItems — 远端组顺序锁（预览定值）', () => {
  it('agent 页：hub → 网络市场（两项）；hub 带分隔线标记', () => {
    const items = buildRemoteFetchItems('agent', vi.fn());
    expect(items.map((i) => i.key)).toEqual(['fetch-hub', 'fetch-marketplace']);
    expect(items[0]).toMatchObject({
      title: '从 momo-hub 获取…',
      hint: '您接入的 hub 节点目录，组内共享资源',
      icon: ArrowRightLeft,
      separatorBefore: true,
    });
    expect(items[1]).toMatchObject({
      title: '从网络市场获取…',
      hint: '官方内置精选目录，下载 zip 校验安装',
      icon: Globe,
    });
    expect(items[1]!.separatorBefore).toBeUndefined();
  });

  it('mcp 页：hub → 网络市场 → Smithery（唯一三源页）', () => {
    const items = buildRemoteFetchItems('mcp', vi.fn());
    expect(items.map((i) => i.key)).toEqual(['fetch-hub', 'fetch-marketplace', 'fetch-smithery']);
    expect(items[0]!.hint).toBe('您接入的 hub 节点目录');
    expect(items[1]!.hint).toBe('官方内置精选目录');
    expect(items[2]).toMatchObject({
      title: '从 Smithery 获取…',
      hint: '社区 MCP 服务器目录（smithery.ai），远程直连',
      icon: Hammer,
    });
  });

  it('skill 页同 agent 页形态（两项 + 组内共享文案）', () => {
    const items = buildRemoteFetchItems('skill', vi.fn());
    expect(items.map((i) => i.key)).toEqual(['fetch-hub', 'fetch-marketplace']);
    expect(items[0]!.hint).toBe('您接入的 hub 节点目录，组内共享资源');
  });

  it('plugin 页仅 hub 一项', () => {
    const items = buildRemoteFetchItems('plugin', vi.fn());
    expect(items.map((i) => i.key)).toEqual(['fetch-hub']);
  });

  it('hub 恒置顶（四页首项均为 fetch-hub）', () => {
    for (const t of ['agent', 'mcp', 'skill', 'plugin'] as const) {
      expect(buildRemoteFetchItems(t, vi.fn())[0]!.key).toBe('fetch-hub');
    }
  });

  it('open 回调透传源', () => {
    const open = vi.fn();
    buildRemoteFetchItems('mcp', open).forEach((i) => i.onSelect());
    expect(open.mock.calls).toEqual([['hub'], ['marketplace'], ['smithery']]);
  });
});

describe('sourceSupportsType / FETCH_PROVIDER_KEY', () => {
  it('类型面：hub 四类；marketplace 无 plugin；smithery 仅 mcp', () => {
    expect(sourceSupportsType('hub', 'plugin')).toBe(true);
    expect(sourceSupportsType('marketplace', 'agent')).toBe(true);
    expect(sourceSupportsType('marketplace', 'plugin')).toBe(false);
    expect(sourceSupportsType('smithery', 'mcp')).toBe(true);
    expect(sourceSupportsType('smithery', 'agent')).toBe(false);
  });

  it('registryList providerKey 映射（marketplace 走 builtin=catalog 快照分支）', () => {
    expect(FETCH_PROVIDER_KEY).toEqual({ hub: 'hub', marketplace: 'builtin', smithery: 'smithery' });
  });
});
