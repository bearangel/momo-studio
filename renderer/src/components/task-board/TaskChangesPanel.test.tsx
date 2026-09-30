// renderer/src/components/task-board/TaskChangesPanel.test.tsx
//
// TaskChangesPanel 任务卡「变更与回滚」面板测试（2026-09-28 回滚重构 spec
// 2026-09-28-journal-rollback-redesign.md §5.5；2026-09-29 会话任务联动 G1
// 摘要常显重构）：
//   - journal.list 挂载即查（摘要常显）；journal.scan 展开后才查（懒执行保持）
//   - 分区头（自 TaskDetailPanel 移入，testid=task-changes-toggle）右侧
//     「N 处变更 · M 个文件」计数（task-changes-summary）；空账面折叠头
//     显示「无变更记录」，展开后见会话入口指引
//   - 折叠态即常显文件路径行（JournalFileChangesList，可就地展开 diff）；
//     同 path 跨消息合并单文件行（D6：净 diff = 首条 before → 末条 after）；
//     界面不出现「消息 ss-」裸 streamSessionId 文案
//   - 展开态挂载 JournalRollbackSection 回滚流（主按钮 → preview → 确认 →
//     revert(workspaceId, 全部 id, undefined) + 幂等二次 list/scan）与
//     未入账区（scan 交叉核对）
//   - list/scan 失败降级 warn 留痕不崩（错误路径）
// mock 形态照抄 ChangesChip.test（window.api 桩 + ipc Proxy 透传），
// JournalEntryView / JournalScanResult / RevertOutcome 均按 types.d.ts 完整形状构造。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { JournalEntryView, JournalScanResult } from '../../ipc/types';
import { TaskChangesPanel } from './TaskChangesPanel';

const listMock = vi.fn();
const revertMock = vi.fn();
const scanMock = vi.fn();
const rollbackMock = vi.fn();
const previewMock = vi.fn();

// 桩 window.api（journal 命名空间全形状；组件经 ipc Proxy 透传消费）
const mockApi = {
  journal: {
    list: listMock,
    revert: revertMock,
    scan: scanMock,
    rollbackFileBefore: rollbackMock,
    preview: previewMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造完整 JournalEntryView（真实形状——types.d.ts 契约，不用简化占位） */
function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'je-1',
    workspaceId: 'ws-1',
    taskId: 'task-9',
    sessionId: 'ses-1',
    streamSessionId: 'ss-1',
    toolName: 'write_file',
    path: 'src/app.ts',
    op: 'modify',
    beforeHash: 'hash-before',
    afterHash: 'hash-after',
    oldPath: null,
    createdAt: 1757000001000,
    beforeText: 'stable-keep\nold-remove\nstable-tail',
    afterText: 'stable-keep\nnew-insert\nstable-tail',
    ...overrides,
  };
}

/** 构造完整 JournalScanResult（真实形状；默认无未入账、未降级、基线可用） */
function makeScan(overrides: Partial<JournalScanResult> = {}): JournalScanResult {
  return {
    journaled: ['src/app.ts'],
    unjournaled: [],
    repos: [],
    degraded: false,
    baselineAvailable: true,
    ...overrides,
  };
}

/** 跨两消息流夹具：ss-1 改 src/app.ts + ss-2 改 docs/guide.md（create） */
function makeTwoFileEntries(): JournalEntryView[] {
  return [
    makeEntry({ id: 'je-1', streamSessionId: 'ss-1', createdAt: 1757000001000 }),
    makeEntry({
      id: 'je-2',
      streamSessionId: 'ss-2',
      path: 'docs/guide.md',
      op: 'create',
      beforeHash: null,
      beforeText: null,
      afterHash: 'hash-guide',
      afterText: 'fresh\nfile',
      createdAt: 1757000002000,
    }),
  ];
}

describe('TaskChangesPanel — 挂载即查与空态（摘要常显）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan({ journaled: [] }));
    rollbackMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([]);
  });

  it('挂载即查 list（摘要常显）；scan 展开后才执行（懒执行保持）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(makeScan());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-9' }));
    expect(scanMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('task-changes-toggle'));
    await waitFor(() => expect(scanMock).toHaveBeenCalledWith('ws-1', 'task-9'));
  });

  it('空账面 + 空扫描 → 折叠头 summary「无变更记录」；展开后见会话入口指引，无回滚按钮', async () => {
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-summary')).toHaveTextContent('无变更记录');
    // 折叠态：指引文案与回滚按钮均不可见（展开才挂载）
    expect(screen.queryByText(/会话内直接对话产生的变更不计入任务/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-changes-rollback-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('task-changes-toggle'));
    expect(
      await screen.findByText(/会话内直接对话产生的变更不计入任务/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('task-changes-rollback-btn')).not.toBeInTheDocument();
  });

  it('list 失败（reject）→ 降级为空账面：折叠头 summary「无变更记录」可见不崩（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockRejectedValue(new Error('store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-summary')).toHaveTextContent('无变更记录');
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('scan 失败（reject）→ 展开后未入账区不渲染，回滚区仍可见（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockRejectedValue(new Error('git 探测异常'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByTestId('task-changes-rollback')).toBeInTheDocument();
    expect(screen.queryByText(/未入账变更/)).not.toBeInTheDocument();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe('TaskChangesPanel — 变更明细（按文件分组，D6）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan());
    rollbackMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([]);
  });

  it('折叠态即常显文件路径行（摘要常显——无需展开分区）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByRole('button', { name: /src\/app\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /docs\/guide\.md/ })).toBeInTheDocument();
    // D6 回归锁：不再出现按消息分组的裸 streamSessionId 组头
    expect(screen.queryByText(/消息 ss-/)).not.toBeInTheDocument();
    // 回滚区默认不可见（展开才挂载）
    expect(screen.queryByTestId('task-changes-rollback-btn')).not.toBeInTheDocument();
  });

  it('分区头右侧显示「N 处变更 · M 个文件」计数', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-summary')).toHaveTextContent('2 处变更 · 2 个文件');
  });

  it('同 path 跨消息流条目 → 合并单文件行「2 条」，净 diff = 首条 before → 末条 after', async () => {
    listMock.mockResolvedValue([
      makeEntry({
        id: 'je-1',
        streamSessionId: 'ss-1',
        beforeText: 'a\nb',
        afterText: 'a\nb\nc',
      }),
      makeEntry({
        id: 'je-2',
        streamSessionId: 'ss-2',
        beforeText: 'a\nb\nc',
        afterText: 'a\nx\nc',
        createdAt: 1757000002000,
      }),
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    const fileRow = await screen.findByRole('button', { name: /src\/app\.ts/ });
    expect(fileRow).toHaveTextContent(/2 条/);
    fireEvent.click(fileRow);
    const diff = await screen.findByTestId('changes-diff');
    expect(diff.querySelectorAll('div.text-status-error')).toHaveLength(1);
    expect(diff.querySelectorAll('div.text-status-success')).toHaveLength(2);
    expect(within(diff).getByText('x')).toBeInTheDocument();
  });
});

describe('TaskChangesPanel — 未入账区（scan 交叉核对）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan({ journaled: [] }));
    rollbackMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([]);
  });

  it('unjournaled 路径列表 + 「shell 或手动」归因说明', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ unjournaled: ['out/a.txt', 'inner/b.log'], repos: ['/ws', '/ws/inner'] }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByText('out/a.txt')).toBeInTheDocument();
    expect(screen.getByText('inner/b.log')).toBeInTheDocument();
    expect(screen.getByText(/经 shell 命令或用户手动修改/)).toBeInTheDocument();
  });

  it('degraded=true → 文案兼顾两成因（本机无 git 或仓库异常），不列路径', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: [], repos: [], degraded: true }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByText(/无法交叉核对/)).toBeInTheDocument();
    expect(screen.getByText(/本机无 git 或仓库异常/)).toBeInTheDocument();
    expect(screen.queryByText('out/a.txt')).not.toBeInTheDocument();
  });

  it('baselineAvailable=false + 有未入账 → 头部提示「无任务起点基线…非本任务专属」', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: ['shell-made.txt'], baselineAvailable: false }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByText('shell-made.txt')).toBeInTheDocument();
    expect(
      screen.getByText('无任务起点基线（旧任务或捕获失败），以上为工作区累计账外状态，非本任务专属'),
    ).toBeInTheDocument();
  });

  it('baselineAvailable=true（基线归因可用）→ 无基线缺失提示行', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: ['shell-made.txt'], baselineAvailable: true }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByText('shell-made.txt')).toBeInTheDocument();
    expect(screen.queryByText(/无任务起点基线/)).not.toBeInTheDocument();
  });

  it('baselineAvailable=false 但无未入账 → 不显示基线缺失提示（无清单可误读）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: [], baselineAvailable: false }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    expect(await screen.findByTestId('task-changes-rollback')).toBeInTheDocument();
    expect(screen.queryByText(/无任务起点基线/)).not.toBeInTheDocument();
  });
});

describe('TaskChangesPanel — 回滚流（主按钮 → 预检 → 确认 → 执行）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(makeTwoFileEntries());
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan());
    rollbackMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'reverted' },
    ]);
  });

  it('主按钮 → preview(全部 id) → 确认 → revert(…, undefined) + 幂等二次查询', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'reverted' },
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    // 回滚区展开才挂载——先展开分区
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-btn'));
    await waitFor(() => expect(previewMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2']));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-confirm-btn'));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2'], undefined),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(scanMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('task-changes-rollback-outcomes')).toBeInTheDocument();
  });

  it('scan 有未入账 → 确认面板含「不随本次回滚」声明', async () => {
    scanMock.mockResolvedValue(makeScan({ unjournaled: ['shell-made.txt'] }));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-btn'));
    const confirm = await screen.findByTestId('task-changes-rollback-confirm');
    expect(
      within(confirm).getByText(/未入账文件（1 个，经 shell 或手动修改）不随本次回滚/),
    ).toBeInTheDocument();
  });

  it('revert 抛错 → 错误行可见（不静默吞掉）', async () => {
    revertMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-toggle'));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-btn'));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-confirm-btn'));
    expect(await screen.findByText('回滚失败：journal store 未注入')).toBeInTheDocument();
  });
});
