// renderer/src/stores/resource.store.test.ts
//
// 资源库 store 行为契约测试（终审 v2.0.0-p4）：
//   - installResource 成功：error 清空 + installNotice 设值；后续 load 完成后 installNotice 仍在
//     （load 不应清掉成功提示——用户需要看到反馈）
//   - installResource 失败：error 写入「导入失败：...」前缀，installNotice 清空；
//     store 不 rethrow（避免 p2p 离线/未找到/超时 unhandled rejection）
//   - installNotice 在 filter 切换 / setQuery 时清掉（防止陈旧成功提示残留）
//
// 注：view 层的端到端测试见 ResourceLibraryView.test.tsx；本文件锁 store 层契约。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useResourceStore } from './resource.store';
import type { ResourceItem } from '../ipc/types';

const resourceList = vi.fn();
const resourceInstall = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
    install: resourceInstall,
  },
};

beforeEach(() => {
  resourceList.mockReset();
  resourceInstall.mockReset();
  resourceList.mockResolvedValue([] as ResourceItem[]);
  resourceInstall.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };

  useResourceStore.setState({
    items: [],
    loading: false,
    error: null,
    installNotice: null,
    typeFilter: 'all',
    sourceFilter: 'all',
    query: '',
  });
});

describe('resource.store — install 反馈闭环', () => {
  it('installResource 成功 → error 清空 + installNotice 设置；后续 setQuery 清掉', async () => {
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');

    const state = useResourceStore.getState();
    expect(state.installNotice).toBe('已导入至「我的上传」');
    expect(state.error).toBeNull();

    // setQuery 清掉陈旧成功提示（前端搜索→主网格刷新，应一并隐藏横幅）
    useResourceStore.getState().setQuery('foo');
    expect(useResourceStore.getState().installNotice).toBeNull();
  });

  it('installResource 失败 → error 写入「导入失败：...」+ installNotice 清空；不 rethrow', async () => {
    resourceInstall.mockRejectedValueOnce(new Error('对端节点可能已离线'));

    // 不应 unhandled rejection——catch 在 store 内消化错误
    await expect(
      useResourceStore.getState().installResource('p2p-agent-x1y2-gone'),
    ).resolves.toBeUndefined();

    const state = useResourceStore.getState();
    expect(state.error).toMatch(/^导入失败：/);
    expect(state.error).toMatch(/对端节点可能已离线/);
    expect(state.installNotice).toBeNull();
  });

  it('installResource 失败后再成功 → 旧 error 被清掉，新 installNotice 出现', async () => {
    // 第一次失败
    resourceInstall.mockRejectedValueOnce(new Error('timeout'));
    await useResourceStore.getState().installResource('p2p-agent-x1y2-gone');
    expect(useResourceStore.getState().error).toMatch(/timeout/);

    // 第二次成功
    resourceInstall.mockResolvedValueOnce(undefined);
    await useResourceStore.getState().installResource('p2p-agent-x1y2-fresh');

    const state = useResourceStore.getState();
    expect(state.error).toBeNull();
    expect(state.installNotice).toBe('已导入至「我的上传」');
  });

  it('setTypeFilter / setSourceFilter 清掉 installNotice', async () => {
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    expect(useResourceStore.getState().installNotice).not.toBeNull();

    useResourceStore.getState().setTypeFilter('agent');
    expect(useResourceStore.getState().installNotice).toBeNull();

    // 重置一次，再测 sourceFilter
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    useResourceStore.getState().setSourceFilter('custom');
    expect(useResourceStore.getState().installNotice).toBeNull();
  });
});