// renderer/src/components/resource-library/FetchDialog.test.tsx
// FetchDialog 三源 × 四态 × 特殊态矩阵（library-store-split spec §4 / 预览 §C §D）。
// Mock 方式遵循 TypePageShell.test.tsx 形态：真实 jsdom window 上装 window.api
// （ipc.client 是真实 Proxy——mock 收窄到 IPC 边界）；store 用真实实现 +
// setState 注入已装行（弹窗四态的本地真源）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { FetchDialog } from './FetchDialog';
import { useResourceStore } from '../../stores/resource.store';
import { useUiStore } from '../../stores/ui.store';
import type { RegistryListEntry, ResourceItem, ResourceType } from '../../ipc/types';

const registryListMock = vi.fn();
const installMock = vi.fn();
const installSmitheryRemoteMock = vi.fn();
/** hub:installProgress 载荷的最小消费面形状（dialog 只读 stage/type/slug/字节拍） */
type HubProgressEventLike = {
  stage: string;
  type: ResourceType;
  slug: string;
  receivedBytes?: number;
  totalBytes?: number | null;
};
const onInstallProgress = vi.fn((_cb: (e: HubProgressEventLike) => void) => () => undefined);
const resourceListMock = vi.fn();

const mockApi = {
  resource: {
    list: resourceListMock,
    registryList: registryListMock,
    install: installMock,
    installSmitheryRemote: installSmitheryRemoteMock,
    getCatalogStatus: vi.fn(async () => ({ degraded: false })),
  },
  hub: {
    onInstallProgress,
  },
};

/** hub 目录条目工厂（versionCount 携带 + item 段 source='hub'） */
function hubEntry(over: Partial<RegistryListEntry> & { slug: string; name: string; version: string }): RegistryListEntry {
  return {
    id: `hub-agent-${over.slug}`,
    type: 'agent',
    description: `${over.name} 的描述`,
    tags: [],
    versionCount: 3,
    ...over,
    item: {
      id: `hub-agent-${over.slug}`, type: 'agent', source: 'hub', slug: over.slug,
      name: over.name, description: 'd', version: over.version, installed: false,
      installable: true, removable: false,
      marketplace: { author: 'studio-a', readme: '', downloadUrl: '', checksum: '', verificationStatus: 'unverified', tags: [], category: 'dev' },
      ...(over.item ?? {}),
    } as ResourceItem,
  };
}

function installedHubItem(slug: string, version: string): ResourceItem {
  return {
    id: `hub-agent-${slug}`, type: 'agent', source: 'hub', slug,
    name: slug, description: 'd', version, installedVersion: version,
    installed: true, installable: false, removable: true,
  };
}

function mockRegistryResult(over: Partial<{
  entries: RegistryListEntry[]; degraded: boolean; notEnrolled: boolean;
  nodeName: string; total: number; revision: number; hasMore: boolean;
}>): void {
  registryListMock.mockResolvedValue({
    entries: [], degraded: false, hasMore: false, ...over,
  });
}

beforeEach(() => {
  registryListMock.mockReset();
  installMock.mockReset().mockResolvedValue(undefined);
  installSmitheryRemoteMock.mockReset().mockResolvedValue(undefined);
  onInstallProgress.mockClear();
  resourceListMock.mockReset().mockResolvedValue([]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'agent', sourceFilter: 'all', query: '', activeType: 'agent',
    hubDegraded: false, hubNotEnrolled: false, hubStatusKnown: true,
  });
  useUiStore.setState({ activeView: 'marketplace' });
});

describe('FetchDialog — hub 正常态（预览 §C）', () => {
  it('标题 / 搜索框 / 脚注连接态文案 / 行元信息（作者 · N 个版本 · 本地 vX）', async () => {
    useResourceStore.setState({
      items: [installedHubItem('pdf-sum', '1.2.0')],
    });
    mockRegistryResult({
      entries: [
        hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' }),
        hubEntry({ slug: 'pdf-sum', name: 'PDF 摘要', version: '1.4.0' }),
      ],
      nodeName: 'bear-hub',
      total: 5,
      revision: 23,
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);

    expect(await screen.findByText('任务看板同步')).toBeTruthy();
    // 标题「从 momo-hub 获取 · 智能体」
    expect(screen.getByText('从 momo-hub 获取')).toBeTruthy();
    expect(screen.getByText('· 智能体')).toBeTruthy();
    expect(screen.getByPlaceholderText('搜索名称 / 描述 / slug…')).toBeTruthy();
    // 脚注（预览 C15 定值文案）
    expect(screen.getByText('已连接 bear-hub · 目录 5 项 · 修订 23')).toBeTruthy();
    // 行元信息：作者 + 版本数 + 本地版本（已装行）
    const row = screen.getByTestId('fetch-row-hub-agent-pdf-sum');
    expect(within(row).getByText('studio-a')).toBeTruthy();
    expect(within(row).getByText('3 个版本')).toBeTruthy();
    expect(within(row).getByText('本地 v1.2.0')).toBeTruthy();
  });

  it('行内四态：未装=安装主按钮；远端更新=✓已装vN+更新描边钮；已装最新=灰显无按钮', async () => {
    useResourceStore.setState({
      items: [
        installedHubItem('pdf-sum', '1.2.0'),   // 远端 1.4.0 > 本地 → 更新
        installedHubItem('daily', '1.0.0'),      // 远端 1.0.0 = 本地 → 最新
      ],
    });
    mockRegistryResult({
      entries: [
        hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' }),
        hubEntry({ slug: 'pdf-sum', name: 'PDF 摘要', version: '1.4.0' }),
        hubEntry({ slug: 'daily', name: '日程协调', version: '1.0.0' }),
      ],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    await screen.findByText('任务看板同步');

    const fresh = screen.getByTestId('fetch-row-hub-agent-kanban');
    expect(within(fresh).getByRole('button', { name: '安装' })).toBeTruthy();

    const updatable = screen.getByTestId('fetch-row-hub-agent-pdf-sum');
    expect(within(updatable).getByText('✓ 已装 v1.2.0')).toBeTruthy();
    expect(within(updatable).getByRole('button', { name: '更新' })).toBeTruthy();

    const latest = screen.getByTestId('fetch-row-hub-agent-daily');
    expect(within(latest).getByText('✓ 已装 v1.0.0 · 最新')).toBeTruthy();
    expect(within(latest).queryByRole('button')).toBeNull();
  });

  it('安装点击 → store.installResource（ipc install）→ 行刷新为已装最新', async () => {
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));

    await waitFor(() => expect(installMock).toHaveBeenCalledWith('hub-agent-kanban'));
  });

  it('客户端过滤：搜索词在名称/描述/slug 内模糊命中（目录快照不重发 IPC）', async () => {
    mockRegistryResult({
      entries: [
        hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' }),
        hubEntry({ slug: 'invoice', name: '发票整理流水线', version: '0.9.2' }),
      ],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    await screen.findByText('任务看板同步');

    fireEvent.change(screen.getByPlaceholderText('搜索名称 / 描述 / slug…'), {
      target: { value: '发票' },
    });
    expect(screen.getByText('发票整理流水线')).toBeTruthy();
    expect(screen.queryByText('任务看板同步')).toBeNull();
    // 目录快照客户端过滤——registryList 不因搜索重发
    expect(registryListMock).toHaveBeenCalledTimes(1);
  });

  it('hub 安装进度事件 → 脚注「正在安装…」+ 百分比', async () => {
    let emit: ((e: HubProgressEventLike) => void) | null = null;
    onInstallProgress.mockImplementation((cb: (e: HubProgressEventLike) => void) => {
      emit = cb;
      return () => undefined;
    });
    installMock.mockImplementation(() =>
      new Promise((resolve) => {
        emit?.({ stage: 'downloading', type: 'agent', slug: 'kanban', receivedBytes: 62, totalBytes: 100 });
        setTimeout(resolve, 50);
      }),
    );
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));

    const bar = await screen.findByTestId('fetch-installing');
    expect(bar.textContent).toContain('正在安装「任务看板同步」…');
    expect(bar.textContent).toContain('62%');
  });
});

describe('FetchDialog — 特殊态（预览 §D）', () => {
  it('hub 未接入 → 空态卡（CloudOff + 去设置接入 → 切 settings 并关闭）', async () => {
    mockRegistryResult({ notEnrolled: true });
    const onClose = vi.fn();
    render(<FetchDialog source="hub" type="agent" onClose={onClose} />);
    await waitFor(() => expect(registryListMock).toHaveBeenCalled());

    expect(screen.getByText('未接入 momo-hub')).toBeTruthy();
    expect(screen.getByText('接入后可安装 hub 组内共享资源')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去设置接入' }));
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(onClose).toHaveBeenCalled();
  });

  it('hub 降级 → warning 卡（hub 暂不可达 + 最近快照文案）；重试 → fresh 再拉', async () => {
    mockRegistryResult({ degraded: true });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    await screen.findByText('hub 暂不可达');

    expect(screen.getByText('离线或网络受限，展示最近一次目录快照')).toBeTruthy();
    registryListMock.mockClear();
    mockRegistryResult({ entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('任务看板同步');
    expect(registryListMock).toHaveBeenCalledWith('hub', 'agent', undefined, 1, { fresh: true });
  });

  it('刷新入口（脚注 RotateCw）→ fresh 重拉', async () => {
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    await screen.findByText('任务看板同步');
    registryListMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
    await waitFor(() =>
      expect(registryListMock).toHaveBeenCalledWith('hub', 'agent', undefined, 1, { fresh: true }),
    );
  });
});

describe('FetchDialog — marketplace 变体', () => {
  function mpEntry(slug: string, name: string, version: string, installed: boolean): RegistryListEntry {
    return {
      id: `marketplace-skill-${slug}`, type: 'skill', name, description: `${name}描述`,
      version, tags: [], item: {
        id: `marketplace-skill-${slug}`, type: 'skill', source: 'marketplace', slug,
        name, description: 'd', version, installed, installable: !installed, removable: installed,
      } as ResourceItem,
    };
  }

  it('脚注「官方内置目录 · N 项」；已装行按 store 本地版本判最新；无刷新入口', async () => {
    useResourceStore.setState({
      typeFilter: 'skill', activeType: 'skill',
      items: [{
        id: 'marketplace-skill-brainstorm', type: 'skill', source: 'marketplace',
        slug: 'brainstorm', name: '头脑风暴引导', description: 'd',
        version: '2.1.0', installedVersion: '2.1.0', installed: true, installable: false, removable: true,
      }],
    });
    mockRegistryResult({
      entries: [
        mpEntry('brainstorm', '头脑风暴引导', '2.1.0', true),
        mpEntry('tech-writing', '技术写作润色', '1.0.3', false),
      ],
      total: 12,
    });
    render(<FetchDialog source="marketplace" type="skill" onClose={vi.fn()} />);

    expect(await screen.findByText('官方内置目录 · 12 项')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刷新目录' })).toBeNull();
    const installed = screen.getByTestId('fetch-row-marketplace-skill-brainstorm');
    expect(within(installed).getByText('✓ 已装 v2.1.0 · 最新')).toBeTruthy();
    const fresh = screen.getByTestId('fetch-row-marketplace-skill-tech-writing');
    expect(within(fresh).getByRole('button', { name: '安装' })).toBeTruthy();
    // marketplace 无元信息段（预览 §D 变体——无版本数数据）
    expect(within(installed).queryByText(/个版本/)).toBeNull();
  });

  it('providerKey=builtin（catalog 快照分支）', async () => {
    mockRegistryResult({ entries: [], total: 0 });
    render(<FetchDialog source="marketplace" type="skill" onClose={vi.fn()} />);
    await waitFor(() => expect(registryListMock).toHaveBeenCalledWith('builtin', 'skill', undefined, 1, undefined));
  });
});

describe('FetchDialog — smithery 变体（仅 MCP）', () => {
  function smEntry(slug: string, name: string, installable: boolean, author = 'upstash'): RegistryListEntry {
    return {
      id: `smithery-mcp-${slug}`, type: 'mcp', name, description: `${name}服务器`,
      tags: [], item: {
        id: `smithery-mcp-${slug}`, type: 'mcp', source: 'smithery', slug,
        name, description: 'd', installed: false, installable, removable: false,
        marketplace: { author, readme: '', downloadUrl: '', checksum: '', verificationStatus: 'verified', tags: [], category: 'smithery' },
      } as ResourceItem,
    };
  }

  it('版本槽显示 @namespace；hosted 未部署行灰显「不可装」；脚注 smithery.ai 文案', async () => {
    mockRegistryResult({
      entries: [
        smEntry('context7', 'context7', true),
        smEntry('seq', 'sequential-thinking', false, 'smithery'),
      ],
    });
    render(<FetchDialog source="smithery" type="mcp" onClose={vi.fn()} />);

    expect(await screen.findByText('context7')).toBeTruthy();
    expect(screen.getByText('@upstash')).toBeTruthy();
    const blocked = screen.getByTestId('fetch-row-smithery-mcp-seq');
    expect(within(blocked).getByText('hosted 未部署 · 不可装')).toBeTruthy();
    expect(within(blocked).queryByRole('button')).toBeNull();
    expect(screen.getByText('smithery.ai · 社区目录 · 远程直连注册')).toBeTruthy();
  });

  it('needsConfig 两态：install 返回 schema → 行内配置表单 → 提交走 installSmitheryRemote', async () => {
    mockRegistryResult({ entries: [smEntry('context7', 'context7', true)] });
    installMock.mockResolvedValueOnce({
      needsConfig: true,
      schema: { required: ['token'], properties: { token: { title: 'API Token' } } },
    });
    render(<FetchDialog source="smithery" type="mcp" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));

    const formTitle = await screen.findByText('配置「context7」');
    expect(formTitle).toBeTruthy();
    const form = formTitle.parentElement as HTMLElement;
    // 必填校验：空值提交被拦（表单内安装钮与行内安装钮同名——scope 到表单容器）
    fireEvent.click(within(form).getByRole('button', { name: '安装' }));
    expect(await within(form).findByText('请填写必填字段：token')).toBeTruthy();
    expect(installSmitheryRemoteMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('API Token'), { target: { value: 'sk-x' } });
    fireEvent.click(within(form).getByRole('button', { name: '安装' }));
    await waitFor(() =>
      expect(installSmitheryRemoteMock).toHaveBeenCalledWith('smithery-mcp-context7', { token: 'sk-x' }),
    );
    // 成功横幅（installNotice 机制——装完落库页）
    await waitFor(() =>
      expect(useResourceStore.getState().installNotice).toBe('已从 Smithery 安装「context7」'),
    );
  });

  it('服务端搜索：搜索词经 300ms 防抖以 query 重查首页', async () => {
    vi.useFakeTimers();
    try {
      mockRegistryResult({ entries: [] });
      const { rerender } = render(<FetchDialog source="smithery" type="mcp" onClose={vi.fn()} />);
      await vi.waitFor(() => expect(registryListMock).toHaveBeenCalledTimes(1));

      fireEvent.change(screen.getByPlaceholderText('搜索服务器…'), { target: { value: 'weather' } });
      // 防抖窗内不重查
      expect(registryListMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(350);
      await vi.waitFor(() =>
        expect(registryListMock).toHaveBeenLastCalledWith('smithery', 'mcp', 'weather', 1, undefined),
      );
      rerender(<FetchDialog source="smithery" type="mcp" onClose={vi.fn()} />);
    } finally {
      vi.useRealTimers();
    }
  });

  it('smithery 降级 → warning 卡 + 重试', async () => {
    mockRegistryResult({ degraded: true });
    render(<FetchDialog source="smithery" type="mcp" onClose={vi.fn()} />);
    expect(await screen.findByText('Smithery 暂不可达')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('FetchDialog — 失败路径', () => {
  it('registryList 抛错 → 弹窗内红字 + 重试按钮（不白屏）', async () => {
    registryListMock.mockRejectedValueOnce(new Error('boom'));
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('安装失败（store 落 error）→ 弹窗内透出错误文本', async () => {
    installMock.mockRejectedValueOnce(new Error('下载失败，请稍后重试'));
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    expect(await screen.findByText(/下载失败，请稍后重试/)).toBeTruthy();
  });

  it('空目录（已接入未降级）→「目录为空」；搜索无匹配 →「没有匹配的资源」', async () => {
    mockRegistryResult({ entries: [] });
    render(<FetchDialog source="hub" type="agent" onClose={vi.fn()} />);
    expect(await screen.findByText('目录为空')).toBeTruthy();
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
    await screen.findByText('任务看板同步');
    fireEvent.change(screen.getByPlaceholderText('搜索名称 / 描述 / slug…'), {
      target: { value: 'zzz不存在' },
    });
    expect(screen.getByText('没有匹配的资源')).toBeTruthy();
  });

  it('Esc 关闭弹窗', async () => {
    mockRegistryResult({
      entries: [hubEntry({ slug: 'kanban', name: '任务看板同步', version: '1.3.0' })],
    });
    const onClose = vi.fn();
    render(<FetchDialog source="hub" type="agent" onClose={onClose} />);
    await screen.findByText('任务看板同步');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
