// renderer/src/lib/useToolCatalog.test.ts
// hook 契约：成功路径派生分组/最小集/全集；失败路径置 error 且 data 为 null；
// 模块级缓存（第二次挂载不再发 IPC）。
//
// 模块状态隔离说明：hook 带模块级缓存（成功后 cache 常驻进程），用例间必须拿到
// 全新模块实例才能分别验证成功/失败路径。vi.resetModules() 不重求值测试文件的
// 顶层静态 import（vitest 已知限制），故每用例内动态 import 取 hook；
// vi.hoisted 保证 mock fn 跨 vi.mock 工厂（会随模块代际重新执行）引用稳定。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ToolCatalogEntry } from '../ipc/types';

const { mockGetCatalog } = vi.hoisted(() => ({
  mockGetCatalog: vi.fn(),
}));

vi.mock('../ipc/client', () => ({
  ipc: {
    tools: {
      getCatalog: mockGetCatalog,
    },
  },
}));

function entry(
  name: string,
  displayName: string,
  category: string,
  defaultOn: boolean,
): ToolCatalogEntry {
  return { name, displayName, description: `${name} 描述`, category, categoryEmoji: '📁', defaultOn };
}

const fakeCatalog: ToolCatalogEntry[] = [
  entry('read_file', '读取文件', '文件', true),
  entry('write_file', '写入文件', '文件', true),
  entry('rm', '删除文件', '文件', false),
  entry('bash', '终端命令', 'Shell', false),
];

describe('useToolCatalog', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('成功：派生 categories / safeMinimum / allTools / displayName 映射', async () => {
    mockGetCatalog.mockResolvedValue(fakeCatalog);
    const { useToolCatalog } = await import('./useToolCatalog');
    const { result } = renderHook(() => useToolCatalog());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.data?.allTools).toHaveLength(4);
    expect(result.current.data?.safeMinimum.sort()).toEqual(['read_file', 'write_file']);
    expect(result.current.data?.categories.map((c) => c.label)).toEqual(['文件', 'Shell']);
    // 2026-10-12 工具名中文化：英文名 → 中文显示名；目录未含的名字回退英文原名
    expect(result.current.data?.displayName('bash')).toBe('终端命令');
    expect(result.current.data?.displayName('not_in_catalog')).toBe('not_in_catalog');
  });

  it('失败：error 置位、data 为 null（不抛出——表单其余部分不受阻塞）', async () => {
    mockGetCatalog.mockRejectedValue(new Error('IPC down'));
    const { useToolCatalog } = await import('./useToolCatalog');
    const { result } = renderHook(() => useToolCatalog());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
    expect(result.current.error).toContain('IPC down');
  });

  it('模块级缓存：成功后第二次挂载不再发 IPC（单飞去重共享一次请求）', async () => {
    mockGetCatalog.mockResolvedValue(fakeCatalog);
    const { useToolCatalog } = await import('./useToolCatalog');
    const first = renderHook(() => useToolCatalog());
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();
    // 第二次挂载：命中模块级缓存，getCatalog 调用数不增长
    const second = renderHook(() => useToolCatalog());
    expect(second.result.current.data).not.toBeNull();
    expect(second.result.current.error).toBeNull();
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
  });
});
