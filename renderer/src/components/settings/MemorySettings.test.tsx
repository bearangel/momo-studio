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
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemorySettings } from './MemorySettings';
import type { MemoryEntry } from '../../ipc/types';

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

const wsEntry: MemoryEntry = {
  id: 'w1', scope: 'workspace', workspaceId: 'ws1', sessionId: null,
  kind: 'rule', pinned: true, content: 'pnpm 研发规范', tags: [], source: 'user',
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
    fireEvent.click(screen.getByRole('tab', { name: '全局' }));
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
    fireEvent.click(screen.getByRole('tab', { name: '全局' }));
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

// v2.2 P3 Task 3：命中统计渲染 + 建议清理黄标（auto 条目 >90 天未用）+ 长度上限 UI
describe('MemorySettings 命中统计与建议清理', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const fmtDate = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  /** 构造 auto 条目 fixture（黄标判定对象） */
  const autoEntry = (over: Partial<typeof wsEntry> = {}) => ({
    ...wsEntry, id: 'a1', source: 'auto' as const, useCount: 0, lastUsedAt: null, ...over,
  });

  it('命中统计：useCount/lastUsedAt 渲染「命中 N 次 · 最近 YYYY-MM-DD」', async () => {
    const lastUsedAt = Date.now() - 30 * DAY_MS;
    listMock.mockResolvedValue([
      { ...wsEntry, id: 'm1', content: '命中统计条目甲', useCount: 3, lastUsedAt },
      { ...wsEntry, id: 'm2', content: '命中统计条目乙', useCount: 0, lastUsedAt: null },
    ]);
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('命中统计条目甲')).toBeInTheDocument());
    expect(screen.getByText(new RegExp(`命中 3 次 · 最近 ${fmtDate(lastUsedAt)}`))).toBeInTheDocument();
    // lastUsedAt 为 null（从未被检索）→ 不渲染日期，显示未使用
    expect(screen.getByText(/命中 0 次 · 未使用/)).toBeInTheDocument();
  });

  it('建议清理黄标：auto + lastUsedAt 91 天前显示；89 天前 / user 来源不显示', async () => {
    listMock.mockResolvedValue([
      autoEntry({ id: 'stale', content: '陈旧 auto 条目', lastUsedAt: Date.now() - 91 * DAY_MS }),
      autoEntry({ id: 'fresh', content: '新鲜 auto 条目', lastUsedAt: Date.now() - 89 * DAY_MS }),
      { ...wsEntry, id: 'user-old', content: '陈旧 user 条目', lastUsedAt: Date.now() - 91 * DAY_MS },
    ]);
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('陈旧 auto 条目')).toBeInTheDocument());
    // 恰好一个「建议清理」（stale auto），fresh auto 与 user 来源条目不带
    expect(screen.getAllByText('建议清理')).toHaveLength(1);
  });

  it('建议清理黄标：lastUsedAt 为 null 的 auto 条目以 createdAt 兜底判定', async () => {
    listMock.mockResolvedValue([
      autoEntry({ id: 'old-created', content: '老创建 auto 条目', lastUsedAt: null, createdAt: Date.now() - 91 * DAY_MS }),
      autoEntry({ id: 'new-created', content: '新创建 auto 条目', lastUsedAt: null, createdAt: Date.now() - 89 * DAY_MS }),
    ]);
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('老创建 auto 条目')).toBeInTheDocument());
    expect(screen.getAllByText('建议清理')).toHaveLength(1);
  });
});

// v2.2 P3 Task 3：编辑/新增 textarea maxLength 按 kind 动态 + 剩余字数提示
describe('MemorySettings 长度上限 UI', () => {
  it('编辑 rule 条目：textarea maxLength=4000 + 剩余字数提示', async () => {
    listMock.mockResolvedValue([{ ...wsEntry, kind: 'rule' }]);
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = (await screen.findByLabelText('记忆内容')) as HTMLTextAreaElement;
    expect(ta.getAttribute('maxlength')).toBe('4000');
    expect(screen.getByText(/还可输入 \d+ 字/)).toBeInTheDocument();
  });

  it('编辑非 rule 条目：maxLength=2000', async () => {
    listMock.mockResolvedValue([{ ...wsEntry, kind: 'knowledge' }]);
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const ta = (await screen.findByLabelText('记忆内容')) as HTMLTextAreaElement;
    expect(ta.getAttribute('maxlength')).toBe('2000');
  });

  it('新增对话框：默认 rule=4000，切 knowledge 后动态降为 2000', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    const ta = (await screen.findByLabelText('新记忆内容')) as HTMLTextAreaElement;
    expect(ta.getAttribute('maxlength')).toBe('4000');
    expect(screen.getByText(/还可输入 \d+ 字/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('记忆类型'), { target: { value: 'knowledge' } });
    expect(ta.getAttribute('maxlength')).toBe('2000');
  });
});

// v2.2 P3 Task 4：UI 健壮性与 a11y——IPC 失败行内错误条 / tab 切换请求序号守卫 /
// toggle 失败回滚本地态 / aria-pressed + role=tablist
describe('MemorySettings 健壮性与 a11y（P3 打磨）', () => {
  it('a11y：scope tabs 带 tablist/tab 语义，aria-selected 随切换更新', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const wsTab = screen.getByRole('tab', { name: '工作空间' });
    const globalTab = screen.getByRole('tab', { name: '全局' });
    expect(wsTab).toHaveAttribute('aria-selected', 'true');
    expect(globalTab).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(globalTab);
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ kind: 'global' }));
    expect(globalTab).toHaveAttribute('aria-selected', 'true');
    expect(wsTab).toHaveAttribute('aria-selected', 'false');
  });

  it('a11y：总开关/自动提取/pin 按钮带 aria-pressed 反映状态', async () => {
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '记忆总开关' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '自动提取开关' })).toHaveAttribute('aria-pressed', 'true');
    // wsEntry.pinned=true → 「取消置顶」按钮处于 pressed
    expect(screen.getByRole('button', { name: '取消置顶' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('列表加载失败：行内错误条呈现错误信息', async () => {
    listMock.mockRejectedValueOnce(new Error('数据库暂时不可用'));
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('数据库暂时不可用'));
  });

  it('总开关切换失败：回滚本地态 + 错误条', async () => {
    updateGlobalMock.mockRejectedValueOnce(new Error('写设置失败'));
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    const btn = screen.getByRole('button', { name: '记忆总开关' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('写设置失败'));
    // 回滚：按钮文本与 aria-pressed 均回到启用态
    expect(btn).toHaveTextContent('已启用');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('自动提取切换失败：回滚本地态 + 错误条', async () => {
    updateGlobalMock.mockRejectedValueOnce(new Error('写提取设置失败'));
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    const btn = screen.getByRole('button', { name: '自动提取开关' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('写提取设置失败'));
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('置顶失败：错误条呈现（本地列表不变形）', async () => {
    updateMock.mockRejectedValueOnce(new Error('置顶写失败'));
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('置顶写失败'));
  });

  it('导出失败：错误条呈现，不触发下载', async () => {
    exportMarkdownMock.mockRejectedValueOnce(new Error('导出生成失败'));
    render(<MemorySettings workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText('pnpm 研发规范')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '导出记忆' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('导出生成失败'));
  });

  it('tab 切换请求序号守卫：旧 scope 晚归响应不得覆盖当前层列表', async () => {
    let resolveWorkspaceList!: (v: MemoryEntry[]) => void;
    listMock.mockImplementationOnce(() => new Promise((res) => { resolveWorkspaceList = res; }));
    listMock.mockResolvedValueOnce([{ ...wsEntry, id: 'g1', content: '全局层唯一条目' }]);
    render(<MemorySettings workspaceId="ws1" />);
    fireEvent.click(screen.getByRole('tab', { name: '全局' }));
    await waitFor(() => expect(screen.getByText('全局层唯一条目')).toBeInTheDocument());
    // 旧 workspace 请求此刻才返回——守卫应丢弃，当前全局列表不被覆盖
    await act(async () => {
      resolveWorkspaceList([{ ...wsEntry, id: 'late-w1', content: '晚归的工作空间条目' }]);
    });
    expect(screen.queryByText('晚归的工作空间条目')).not.toBeInTheDocument();
    expect(screen.getByText('全局层唯一条目')).toBeInTheDocument();
  });
});
