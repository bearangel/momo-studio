// renderer/src/components/common/JournalRollback.test.tsx
//
// JournalRollbackSection（变更回滚重构 spec 2026-09-28 §5.4）测试：
//   - 空条目不渲染；汇总行 N 处 · M 文件（去重 path）
//   - 主按钮 → journal:preview(workspaceId, 全部 ids) → 确认面板：将回滚清单 /
//     拦截黄标 / no-op 计数 / 未入账声明（传入时）
//   - 强制勾选仅在存在拦截时出现；勾选 → revert(…, {force:true})，未勾 → undefined
//   - 确认执行 → revert + onAfterRevert 幂等回调 + 五态结果列表
//   - 取消 → 回 idle；preview / revert 抛错不静默
// mock 形态照抄 ChangesChip.test（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { JournalEntryView, RevertOutcome } from '../../ipc/types';
import { JournalRollbackSection } from './JournalRollback';

const previewMock = vi.fn();
const revertMock = vi.fn();

const mockApi = {
  journal: {
    list: vi.fn(),
    revert: revertMock,
    scan: vi.fn(),
    rollbackFileBefore: vi.fn(),
    preview: previewMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'je-1',
    workspaceId: 'ws-1',
    taskId: null,
    sessionId: 'ses-1',
    streamSessionId: 'ss-1',
    toolName: 'write_file',
    path: 'src/app.ts',
    op: 'modify',
    beforeHash: 'hash-before',
    afterHash: 'hash-after',
    oldPath: null,
    createdAt: 1757000001000,
    beforeText: 'old',
    afterText: 'new',
    ...overrides,
  };
}

function twoFileEntries(): JournalEntryView[] {
  return [
    makeEntry({ id: 'je-1' }),
    makeEntry({ id: 'je-2', path: 'docs/guide.md', op: 'create', beforeText: null }),
  ];
}

describe('JournalRollbackSection — 汇总与空态', () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('空条目 → 不渲染', () => {
    const { container } = render(
      <JournalRollbackSection workspaceId="ws-1" entries={[]} testId="task-changes" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('2 条目 2 文件 → 汇总行「2 处入账变更 · 2 个文件」+ 主按钮', () => {
    render(<JournalRollbackSection workspaceId="ws-1" entries={twoFileEntries()} testId="task-changes" />);
    expect(screen.getByText('2 处入账变更 · 2 个文件')).toBeInTheDocument();
    expect(screen.getByTestId('task-changes-rollback-btn')).toBeInTheDocument();
  });

  it('同 path 链式条目 → 文件数去重（2 条 · 1 文件）', () => {
    render(
      <JournalRollbackSection
        workspaceId="ws-1"
        entries={[makeEntry({ id: 'je-1' }), makeEntry({ id: 'je-2' })]}
        testId="task-changes"
      />,
    );
    expect(screen.getByText('2 处入账变更 · 1 个文件')).toBeInTheDocument();
  });
});

describe('JournalRollbackSection — 预检确认流', () => {
  beforeEach(() => {
    previewMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('主按钮 → preview(workspaceId, 全部 ids) → 确认面板呈现分组', async () => {
    previewMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'restored-missing' },
      { id: 'je-3', path: 'x.ts', result: 'skipped-diverged' },
      { id: 'je-4', path: '', result: 'no-op', detail: '条目不存在（可能已被配额清理）' },
    ]);
    render(
      <JournalRollbackSection
        workspaceId="ws-1"
        entries={twoFileEntries()}
        testId="task-changes"
        unjournaledPaths={['shell-made.txt']}
      />,
    );
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2']),
    );

    const confirm = await screen.findByTestId('task-changes-rollback-confirm');
    expect(within(confirm).getByText('将回滚 2 处：')).toBeInTheDocument();
    expect(within(confirm).getByText('src/app.ts')).toBeInTheDocument();
    expect(within(confirm).getByText(/文件已缺失，将重建/)).toBeInTheDocument();
    expect(within(confirm).getByText('将拦截 1 处（文件在记账后被修改）：')).toBeInTheDocument();
    expect(within(confirm).getByText('另有 1 处无需回滚（已还原或未生效）')).toBeInTheDocument();
    expect(within(confirm).getByText(/未入账文件（1 个，经 shell 或手动修改）不随本次回滚/)).toBeInTheDocument();
    expect(within(confirm).getByText('预检为预测结果，以执行时守卫为准')).toBeInTheDocument();
  });

  it('无拦截 → 强制勾选不出现；确认 → revert(…, undefined) + onAfterRevert + 结果列表', async () => {
    previewMock.mockResolvedValue([{ id: 'je-1', path: 'src/app.ts', result: 'reverted' }]);
    revertMock.mockResolvedValue([{ id: 'je-1', path: 'src/app.ts', result: 'reverted' }]);
    const onAfterRevert = vi.fn();
    render(
      <JournalRollbackSection
        workspaceId="ws-1"
        entries={twoFileEntries()}
        testId="task-changes"
        onAfterRevert={onAfterRevert}
      />,
    );
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    await screen.findByTestId('task-changes-rollback-confirm');
    expect(screen.queryByTestId('task-changes-force-override')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('task-changes-rollback-confirm-btn'));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2'], undefined),
    );
    await waitFor(() => expect(onAfterRevert).toHaveBeenCalledTimes(1));
    const outcomes = await screen.findByTestId('task-changes-rollback-outcomes');
    expect(within(outcomes).getByText('已撤回')).toBeInTheDocument();
  });

  it('有拦截 → 强制勾选出现；勾选后确认 → revert(…, { force: true })', async () => {
    previewMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'skipped-diverged' },
    ]);
    render(<JournalRollbackSection workspaceId="ws-1" entries={twoFileEntries()} testId="task-changes" />);
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    await screen.findByTestId('task-changes-rollback-confirm');

    fireEvent.click(screen.getByTestId('task-changes-force-override'));
    fireEvent.click(screen.getByTestId('task-changes-rollback-confirm-btn'));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2'], { force: true }),
    );
  });

  it('取消 → 回 idle，确认面板与预检结果清空', async () => {
    previewMock.mockResolvedValue([{ id: 'je-1', path: 'src/app.ts', result: 'reverted' }]);
    render(<JournalRollbackSection workspaceId="ws-1" entries={twoFileEntries()} testId="task-changes" />);
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    await screen.findByTestId('task-changes-rollback-confirm');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByTestId('task-changes-rollback-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-changes-rollback-btn')).toBeInTheDocument();
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it('preview 抛错 → 错误行可见不静默', async () => {
    previewMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<JournalRollbackSection workspaceId="ws-1" entries={twoFileEntries()} testId="task-changes" />);
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    expect(await screen.findByText('预检失败：journal store 未注入')).toBeInTheDocument();
    expect(screen.queryByTestId('task-changes-rollback-confirm')).not.toBeInTheDocument();
  });

  it('revert 抛错 → 错误行可见不静默', async () => {
    previewMock.mockResolvedValue([{ id: 'je-1', path: 'src/app.ts', result: 'reverted' }]);
    revertMock.mockRejectedValue(new Error('工作空间不存在: ws-1'));
    render(<JournalRollbackSection workspaceId="ws-1" entries={twoFileEntries()} testId="task-changes" />);
    fireEvent.click(screen.getByTestId('task-changes-rollback-btn'));
    await screen.findByTestId('task-changes-rollback-confirm');
    fireEvent.click(screen.getByTestId('task-changes-rollback-confirm-btn'));
    expect(await screen.findByText('回滚失败：工作空间不存在: ws-1')).toBeInTheDocument();
  });
});
