// electron/tests/resource/hub/smithery.test.ts
//
// Smithery provider 契约测试。mock globalThis.fetch（手法同 tests/marketplace/client.test.ts）。
// 字段形状以 Task 0 实测核实文档为准（.superpowers/sdd/task-0-api-verify.md）：
//   qualifiedName（安装标识，非 id）/ displayName / description / verified / useCount /
//   isDeployed（P2.1 直连翻转：false=未部署 → installable:false；remote 不再是安装开关）/
//   inactive / unlisted（后两者过滤）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  smitheryProvider,
  isSmitheryDegraded,
  __resetHubBackoffForTest,
} from '../../../src/main/resource/hub/smithery';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
  __resetHubBackoffForTest();
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetHubBackoffForTest();
});

// Task 0 实测形状：qualifiedName 形如 '@owner/weather' 或 'brave'（含 / 与可能的 @）
const LIST_BODY = {
  servers: [
    {
      qualifiedName: '@owner/weather',
      displayName: 'Weather',
      description: '天气查询',
      verified: true,
      useCount: 1234,
      remote: false,
      isDeployed: true,
      inactive: false,
      unlisted: false,
    },
  ],
  pagination: { currentPage: 0, pageSize: 30, totalPages: 530, totalCount: 15861 },
};

describe('smitheryProvider', () => {
  it('list 映射为 HubEntry（slug=qualifiedName / name=displayName / verified→verificationStatus / useCount→installCount / installable=isDeployed）', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, json: async () => LIST_BODY,
    } as Response);
    const { entries, degraded } = await smitheryProvider.list('mcp');
    expect(degraded).toBe(false);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.id).toBe('smithery-mcp-@owner/weather');
    expect(e.type).toBe('mcp');
    expect(e.name).toBe('Weather');
    expect(e.item.source).toBe('smithery');
    expect(e.item.slug).toBe('@owner/weather');
    expect(e.item.installable).toBe(true);
    expect(e.item.marketplace?.author).toBe('owner');
    expect(e.item.marketplace?.verificationStatus).toBe('verified');
    expect(e.item.marketplace?.installCount).toBe(1234);
    expect(e.category).toBe('smithery');
  });

  it('仅 type=mcp 支持（agent/skill 抛不支持）', async () => {
    await expect(smitheryProvider.list('agent')).rejects.toThrow(/暂只支持 MCP/);
    await expect(smitheryProvider.list('skill')).rejects.toThrow(/暂只支持 MCP/);
  });

  it('fetch 失败 → degraded=true + 退避（二次调用零网络）', async () => {
    fetchSpy.mockRejectedValue(new Error('fetch failed'));
    const first = await smitheryProvider.list('mcp');
    expect(first.degraded).toBe(true);
    expect(first.entries).toHaveLength(0);
    expect(isSmitheryDegraded()).toBe(true);
    const second = await smitheryProvider.list('mcp');
    expect(second.degraded).toBe(true);
    // 退避窗口内第二次调用不发网络请求
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('畸形条目（缺 qualifiedName / namespace 段过不了 S1 slug 校验）单条跳过不拖垮列表', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [
          LIST_BODY.servers[0],
          { displayName: '无标识', description: '缺 qualifiedName' },
          { qualifiedName: 'Bad|Slug!', displayName: 'Bad', description: 'x' },
        ],
      }),
    } as Response);
    const { entries, degraded } = await smitheryProvider.list('mcp');
    expect(degraded).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.item.slug).toBe('@owner/weather');
  });

  it('Task 0 过滤规则：inactive || unlisted 的条目跳过', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [
          LIST_BODY.servers[0],
          { ...LIST_BODY.servers[0]!, qualifiedName: '@owner/gone', inactive: true },
          { ...LIST_BODY.servers[0]!, qualifiedName: '@owner/hidden', unlisted: true },
        ],
      }),
    } as Response);
    const { entries } = await smitheryProvider.list('mcp');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.item.slug).toBe('@owner/weather');
  });

  it('P2.1 直连翻转：remote=true（hosted）不再挡安装——installable 仍由 isDeployed 驱动', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [
          { ...LIST_BODY.servers[0]!, qualifiedName: 'hosted-svc', remote: true, verified: false },
        ],
      }),
    } as Response);
    const { entries } = await smitheryProvider.list('mcp');
    expect(entries).toHaveLength(1);
    // isDeployed 继承 LIST_BODY 的 true——hosted（remote）条目现在可直连安装
    expect(entries[0]!.item.installable).toBe(true);
    expect(entries[0]!.item.marketplace?.verificationStatus).toBe('unverified');
  });

  it('isDeployed:false（未部署）→ 展示但 installable=false', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [
          { ...LIST_BODY.servers[0]!, qualifiedName: 'undeployed-svc', isDeployed: false },
        ],
      }),
    } as Response);
    const { entries } = await smitheryProvider.list('mcp');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.item.installable).toBe(false);
  });

  it('query 非空时作为 q 参数下发（Task 0 实测 q 搜索可用）', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, json: async () => LIST_BODY,
    } as Response);
    await smitheryProvider.list('mcp', 'file system');
    const url = (fetchSpy.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain('q=file%20system');
  });

  it('裸 qualifiedName（无 @ 前缀）namespace 段同样过 S1 校验', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [{ ...LIST_BODY.servers[0]!, qualifiedName: 'onesignal/onesignal' }],
      }),
    } as Response);
    const { entries } = await smitheryProvider.list('mcp');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('smithery-mcp-onesignal/onesignal');
    expect(entries[0]!.item.marketplace?.author).toBe('onesignal');
  });
});
