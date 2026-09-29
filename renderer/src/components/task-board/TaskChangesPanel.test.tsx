// renderer/src/components/task-board/TaskChangesPanel.test.tsx
//
// TaskChangesPanel 任务卡「变更与回滚」面板测试（2026-09-28 回滚重构 spec
// 2026-09-28-journal-rollback-redesign.md §5.5 信息架构倒转）：
//   - 挂载并行懒查 list({workspaceId, taskId}) + scan(workspaceId, taskId)
//   - 空账面 + 空扫描 → 空态「无变更记录」；list 失败降级不崩（错误路径）
//   - 顶部 JournalRollbackSection：主按钮「回滚全部变更」→ preview → 确认面板 →
//     revert(workspaceId, 全部 id, undefined) + 幂等二次 list/scan
//   - 变更明细默认折叠；点开按文件分组（D6：同 path 跨消息合并单文件行，净 diff
//     = 首条 before → 末条 after）；界面不出现「消息 ss-」裸 streamSessionId 文案
//   - 未入账区列 unjournaled 路径 + 「shell 或手动」归因说明；degraded 文案
//     兼顾两成因（无法交叉核对（本机无 git 或仓库异常）——T5 移交）
//   - 黄标（skipped-diverged）行提供 [回滚到此文件此条之前] → rollbackFileBefore
//     (workspaceId, path, beforeEntryId) 并渲染逐文件组合回滚结果
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

describe('TaskChangesPanel — 挂载懒查与空态', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan({ journaled: [] }));
    rollbackMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([]);
  });

  it('挂载并行懒查 list({workspaceId, taskId}) + scan(workspaceId, taskId)', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(makeScan());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-9' });
    expect(scanMock).toHaveBeenCalledWith('ws-1', 'task-9');
  });

  it('空账面 + 空扫描 → 空态「无变更记录」+ 会话入口指引，无回滚按钮', async () => {
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText('无变更记录')).toBeInTheDocument();
    expect(
      screen.getByText(/会话内直接对话产生的变更不计入任务/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('task-changes-rollback-btn')).not.toBeInTheDocument();
  });

  it('list 失败（reject）→ 降级为空账面：空态可见不崩（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockRejectedValue(new Error('store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText('无变更记录')).toBeInTheDocument();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('scan 失败（reject）→ 未入账区不渲染，回滚区仍可见（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockRejectedValue(new Error('git 探测异常'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
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

  it('明细默认折叠；点开 → 按文件分组行可见；界面无「消息 ss-」裸流 id 文案', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-rollback')).toBeInTheDocument();
    const toggle = screen.getByTestId('task-changes-detail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /src\/app\.ts/ })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /docs\/guide\.md/ })).toBeInTheDocument();
    // D6 回归锁：不再出现按消息分组的裸 streamSessionId 组头
    expect(screen.queryByText(/消息 ss-/)).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByTestId('task-changes-detail-toggle'));
    const fileRow = screen.getByRole('button', { name: /src\/app\.ts/ });
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
    expect(await screen.findByText('shell-made.txt')).toBeInTheDocument();
    expect(screen.queryByText(/无任务起点基线/)).not.toBeInTheDocument();
  });

  it('baselineAvailable=false 但无未入账 → 不显示基线缺失提示（无清单可误读）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: [], baselineAvailable: false }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
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
    fireEvent.click(await screen.findByTestId('task-changes-rollback-btn'));
    const confirm = await screen.findByTestId('task-changes-rollback-confirm');
    expect(
      within(confirm).getByText(/未入账文件（1 个，经 shell 或手动修改）不随本次回滚/),
    ).toBeInTheDocument();
  });

  it('revert 抛错 → 错误行可见（不静默吞掉）', async () => {
    revertMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByTestId('task-changes-rollback-btn'));
    fireEvent.click(await screen.findByTestId('task-changes-rollback-confirm-btn'));
    expect(await screen.findByText('回滚失败：journal store 未注入')).toBeInTheDocument();
  });
});
