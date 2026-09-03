// renderer/src/components/settings/MemorySettings.test.tsx
//
// 记忆管理页行为测试（v2.2 P1）：
//   - 列表渲染 + memory.list 入参（scope 随 tab 切换）
//   - 置顶切换调用 memory.update（pinned 取反）
//   - 编辑弹窗保存调用 memory.update（content 更新）
//   - 删除有二次确认，确认后调用 memory.delete
//   - 总开关关闭调用 settings.updateGlobal({ memoryEnabled: false })
//
// Mock 策略（momo-test-rules）：只桩 window.api IPC 边界（memory + settings 命名空间），
// 组件经 ipc client 代理消费；断言生产真实入参（filter 位省略即单参调用）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemorySettings } from './MemorySettings';

const listMock = vi.fn();
const saveMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const exportMarkdownMock = vi.fn();
const importMarkdownMock = vi.fn();
const getGlobalMock = vi.fn();
const updateGlobalMock = vi.fn();

// 桩 window.api（memory + settings 命名空间；组件经 ipc client 运行时读取）
const mockApi = {
  memory: {
    list: listMock,
    save: saveMock,
    update: updateMock,
    delete: deleteMock,
    search: vi.fn(),
    exportMarkdown: exportMarkdownMock,
    importMarkdown: importMarkdownMock,
  },
  settings: {
    getGlobal: getGlobalMock,
    updateGlobal: updateGlobalMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const wsEntry = {
  id: 'w1', scope: 'workspace' as const, workspaceId: 'ws1', sessionId: null,
  kind: 'rule' as const, pinned: true, content: 'pnpm 研发规范', tags: [], source: 'user' as const,
  sourceDetail: null, confidence: 1, useCount: 0, lastUsedAt: null, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  getGlobalMock.mockResolvedValue({ memoryEnabled: true });
  listMock.mockResolvedValue([wsEntry]);
});

describe('MemorySettings', () => {
  it('默认 workspace 层：列表渲染 + list 参数正确', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(listMock).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'ws1' });
  });

  it('切到全局层：list 参数切换', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '全局' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ kind: 'global' }));
  });

  it('置顶切换调用 update（pinned 取反）', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('w1', { pinned: false }));
  });

  it('编辑弹窗保存调用 update（content 更新）', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const input = await screen.findByLabelText('记忆内容');
    fireEvent.change(input, { target: { value: 'pnpm 研发规范 v2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('w1', { content: 'pnpm 研发规范 v2' }));
  });

  it('删除有确认，确认后调用 delete', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText(/确定删除这条记忆/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('w1'));
  });

  it('总开关关闭调用 updateGlobal memoryEnabled=false', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '记忆总开关' }));
    await waitFor(() => expect(updateGlobalMock).toHaveBeenCalledWith({ memoryEnabled: false }));
  });

  // v2.2 P2 Task 5：自动提取开关（子开关）——独立于总开关
  it('自动提取开关：切换调用 updateGlobal memoryExtractionEnabled', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    const btn = screen.getByRole('button', { name: '自动提取开关' });
    // 初始 enabled（缺省 true）→ 点击切到 false
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(updateGlobalMock).toHaveBeenCalledWith({ memoryExtractionEnabled: false }),
    );
  });

  it('总开关停用时：自动提取开关禁用 + 显示「记忆总开关已停用」提示', async () => {
    getGlobalMock.mockResolvedValue({
      memoryEnabled: false,
      memoryExtractionEnabled: true,
    });
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '自动提取开关' })).toBeDisabled();
    expect(screen.getByText('记忆总开关已停用')).toBeInTheDocument();
  });

  it('静态说明「提取需要会话 agent 已配置模型供应商」始终渲染', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(screen.getByText(/提取需要会话 agent 已配置模型供应商/)).toBeInTheDocument();
  });

  // 终审修复（F3）：新增默认 kind=rule——常驻注入生效（pinned 由 repo 按 kind 推导，不显式传）
  it('新增记忆：默认 kind=rule 保存', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    const input = await screen.findByLabelText('新记忆内容');
    fireEvent.change(input, { target: { value: '默认类型为规范的记忆' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        scope: 'workspace', workspaceId: 'ws1', kind: 'rule', content: '默认类型为规范的记忆', source: 'user',
      }),
    );
  });

  it('新增记忆：经类型选择器选择知识后保存传所选 kind', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    const input = await screen.findByLabelText('新记忆内容');
    fireEvent.change(input, { target: { value: '选了知识类型的记忆' } });
    fireEvent.change(screen.getByLabelText('记忆类型'), { target: { value: 'knowledge' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        scope: 'workspace', workspaceId: 'ws1', kind: 'knowledge', content: '选了知识类型的记忆', source: 'user',
      }),
    );
  });
});

// v2.2 P3 Task 2：导出/导入 Markdown 按钮——mock 策略同 ExportChatButton
// （URL.createObjectURL + a.click 为 jsdom 未实现的下载边界）
describe('MemorySettings 导出/导入', () => {
  const clickMock = vi.fn();
  const urlMock = 'blob:mock://xxx';

  beforeEach(() => {
    // mock URL.createObjectURL + a.click（jsdom 不实现下载）
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => urlMock),
      revokeObjectURL: vi.fn(),
    });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'a') {
        vi.spyOn(el, 'click').mockImplementation(clickMock);
      }
      return el;
    });
    clickMock.mockReset();
  });

  it('导出：默认 workspace tab——调 exportMarkdown(scope) 并触发 Blob 下载', async () => {
    exportMarkdownMock.mockResolvedValueOnce({
      filename: 'momo-memory-workspace-20260903-2212.md',
      content: '# 记忆导出（工作空间）',
    });
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '导出记忆' }));
    await waitFor(() => {
      expect(exportMarkdownMock).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'ws1' });
    });
    await waitFor(() => expect(clickMock).toHaveBeenCalled());
  });

  it('导出：全局 tab——scope 随 tab 切换', async () => {
    exportMarkdownMock.mockResolvedValueOnce({ filename: 'momo-memory-global-1.md', content: '# 记忆导出（全局）' });
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '全局' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ kind: 'global' }));
    fireEvent.click(screen.getByRole('button', { name: '导出记忆' }));
    await waitFor(() => {
      expect(exportMarkdownMock).toHaveBeenCalledWith({ kind: 'global' });
    });
  });

  it('导入：选文件读文本后调 importMarkdown(scope, content)，展示结果并刷新列表', async () => {
    importMarkdownMock.mockResolvedValueOnce({ imported: 2, skipped: 1 });
    const { container } = render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    const listCallsBefore = listMock.mock.calls.length;

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const file = new File(['## [rule|user|pinned] 使用 pnpm 管理依赖'], 'memory.md', { type: 'text/markdown' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(importMarkdownMock).toHaveBeenCalledWith(
        { kind: 'workspace', workspaceId: 'ws1' },
        '## [rule|user|pinned] 使用 pnpm 管理依赖',
      );
    });
    expect(screen.getByText('已导入 2 条，跳过 1 条')).toBeInTheDocument();
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(listCallsBefore));
  });

  it('导入：失败显示错误信息，不显示结果行', async () => {
    importMarkdownMock.mockRejectedValueOnce(new Error('会话层不支持导入记忆'));
    const { container } = render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['# 空'], 'memory.md', { type: 'text/markdown' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText(/会话层不支持导入记忆/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/已导入/)).not.toBeInTheDocument();
  });
});
