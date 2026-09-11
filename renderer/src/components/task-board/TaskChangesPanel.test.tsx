// renderer/src/components/task-board/TaskChangesPanel.test.tsx
//
// TaskChangesPanel（v2.5 Task 9）任务卡「变更审查」面板测试：
//   - 挂载并行懒查 list({workspaceId, taskId}) + scan(workspaceId, taskId)
//   - 空账面 + 空扫描 → 空态「无变更记录」；list 失败降级不崩（错误路径）
//   - 按 streamSessionId 分组渲染（两组各自组头 + 组内文件行）；组内同 path
//     链式条目净 diff = 首条 before → 末条 after（与 chip 两级视图一致语义）；
//     同 path 跨组不合并（每消息组独立聚合）
//   - 未入账区列 unjournaled 路径 + 「shell 或手动」归因说明；degraded 文案
//     兼顾两成因（无法交叉核对（本机无 git 或仓库异常）——T5 移交）
//   - [撤回全部入账变更] → revert(workspaceId, 全部 id, undefined)（force 不默认）
//     + 完成后幂等二次 list/scan；revert 抛错不静默（错误路径）
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

// 桩 window.api（journal 命名空间全形状；组件经 ipc Proxy 透传消费）
const mockApi = {
  journal: {
    list: listMock,
    revert: revertMock,
    scan: scanMock,
    rollbackFileBefore: rollbackMock,
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

/** 构造完整 JournalScanResult（真实形状；默认无未入账、未降级） */
function makeScan(overrides: Partial<JournalScanResult> = {}): JournalScanResult {
  return {
    journaled: ['src/app.ts'],
    unjournaled: [],
    repos: [],
    degraded: false,
    ...overrides,
  };
}

/** 跨两消息组夹具：ss-1 改 src/app.ts + ss-2 改 docs/guide.md（create） */
function makeTwoGroupEntries(): JournalEntryView[] {
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
  });

  it('挂载并行懒查 list({workspaceId, taskId}) + scan(workspaceId, taskId)', async () => {
    listMock.mockResolvedValue(makeTwoGroupEntries());
    scanMock.mockResolvedValue(makeScan());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-9' });
    expect(scanMock).toHaveBeenCalledWith('ws-1', 'task-9');
  });

  it('空账面 + 空扫描 → 空态「无变更记录」，无撤回按钮', async () => {
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText('无变更记录')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /撤回全部入账变更/ })).not.toBeInTheDocument();
  });

  it('list 失败（reject）→ 降级为空账面：空态可见不崩（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockRejectedValue(new Error('store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText('无变更记录')).toBeInTheDocument();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('scan 失败（reject）→ 未入账区不渲染，入账区仍可见（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockResolvedValue(makeTwoGroupEntries());
    scanMock.mockRejectedValue(new Error('git 探测异常'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /撤回全部入账变更/ })).toBeInTheDocument();
    expect(screen.queryByText(/未入账变更/)).not.toBeInTheDocument();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe('TaskChangesPanel — 按 streamSessionId 分组聚合', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan());
    rollbackMock.mockReset().mockResolvedValue([]);
  });

  it('两组 streamSessionId → 两个分组（组头「消息 ss-N」），组内文件行可见', async () => {
    listMock.mockResolvedValue(makeTwoGroupEntries());
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-panel')).toBeInTheDocument();
    const groups = screen.getAllByTestId('changes-group');
    expect(groups).toHaveLength(2);
    expect(screen.getByText(/消息 ss-1/)).toBeInTheDocument();
    expect(screen.getByText(/消息 ss-2/)).toBeInTheDocument();
    expect(within(groups[0] as HTMLElement).getByRole('button', { name: /src\/app\.ts/ })).toBeInTheDocument();
    expect(
      within(groups[1] as HTMLElement).getByRole('button', { name: /docs\/guide\.md/ }),
    ).toBeInTheDocument();
  });

  it('组内同 path 链式条目 → 单文件组「2 条」，净 diff = 首条 before → 末条 after', async () => {
    // e1: a,b → a,b,c；e2: a,b,c → a,x,c。净效果 a,b → a,x,c = del b + add x + add c
    listMock.mockResolvedValue([
      makeEntry({
        id: 'je-1',
        beforeText: 'a\nb',
        afterText: 'a\nb\nc',
      }),
      makeEntry({
        id: 'je-2',
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

  it('同 path 跨消息组不合并——两组各渲染独立文件行（净 diff 按组内聚合）', async () => {
    listMock.mockResolvedValue([
      makeEntry({
        id: 'je-1',
        streamSessionId: 'ss-1',
        beforeText: 'v0',
        afterText: 'v1',
      }),
      makeEntry({
        id: 'je-2',
        streamSessionId: 'ss-2',
        beforeText: 'v1',
        afterText: 'v2',
        createdAt: 1757000002000,
      }),
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByTestId('task-changes-panel')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /src\/app\.ts/ });
    expect(rows).toHaveLength(2);
    // 展开两组：ss-1 组净 diff = v0→v1（1del+1add）；ss-2 组 = v1→v2（1del+1add）
    for (const row of rows) {
      fireEvent.click(row);
    }
    const diffs = await screen.findAllByTestId('changes-diff');
    expect(diffs).toHaveLength(2);
    for (const d of diffs) {
      expect(d.querySelectorAll('div.text-status-error')).toHaveLength(1);
      expect(d.querySelectorAll('div.text-status-success')).toHaveLength(1);
    }
  });
});

describe('TaskChangesPanel — 未入账区（scan 交叉核对）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan({ journaled: [] }));
    rollbackMock.mockReset().mockResolvedValue([]);
  });

  it('unjournaled 路径列表 + 「shell 或手动」归因说明', async () => {
    listMock.mockResolvedValue(makeTwoGroupEntries());
    scanMock.mockResolvedValue(
      makeScan({ unjournaled: ['out/a.txt', 'inner/b.log'], repos: ['/ws', '/ws/inner'] }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText('out/a.txt')).toBeInTheDocument();
    expect(screen.getByText('inner/b.log')).toBeInTheDocument();
    expect(screen.getByText(/经 shell 命令或用户手动修改/)).toBeInTheDocument();
  });

  it('degraded=true → 文案兼顾两成因（本机无 git 或仓库异常），不列路径', async () => {
    listMock.mockResolvedValue(makeTwoGroupEntries());
    scanMock.mockResolvedValue(
      makeScan({ journaled: [], unjournaled: [], repos: [], degraded: true }),
    );
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    expect(await screen.findByText(/无法交叉核对/)).toBeInTheDocument();
    expect(screen.getByText(/本机无 git 或仓库异常/)).toBeInTheDocument();
    expect(screen.queryByText('out/a.txt')).not.toBeInTheDocument();
  });
});

describe('TaskChangesPanel — 撤回全部入账变更', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(makeTwoGroupEntries());
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan());
    rollbackMock.mockReset().mockResolvedValue([]);
  });

  it('点击 → revert(workspaceId, 全部 id, undefined)（force 不默认）+ 幂等二次查询', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'reverted' },
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByRole('button', { name: /撤回全部入账变更/ }));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2'], undefined),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(scanMock).toHaveBeenCalledTimes(2));
  });

  it('revert 抛错 → 错误行可见（不静默吞掉）', async () => {
    revertMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByRole('button', { name: /撤回全部入账变更/ }));
    expect(await screen.findByText('撤回失败：journal store 未注入')).toBeInTheDocument();
  });
});

describe('TaskChangesPanel — 黄标组合回滚（rollbackFileBefore）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(makeTwoGroupEntries());
    revertMock.mockReset().mockResolvedValue([]);
    scanMock.mockReset().mockResolvedValue(makeScan());
    rollbackMock.mockReset().mockResolvedValue([]);
  });

  it('skipped-diverged 黄标行 → [回滚到此文件此条之前] → 调通道并渲染逐文件结果', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      {
        id: 'je-2',
        path: 'docs/guide.md',
        result: 'skipped-diverged',
        detail: 'hash 漂移：文件在记账后被其他变更修改',
      },
    ]);
    rollbackMock.mockResolvedValue([
      { id: 'je-2', path: 'docs/guide.md', result: 'reverted', detail: '逆序组合第 1 步' },
      {
        id: 'je-x9',
        path: 'docs/guide.md',
        result: 'reverted',
        detail: '逆序组合第 2 步（锚点自身）',
      },
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByRole('button', { name: /撤回全部入账变更/ }));
    const outcomes = await screen.findByTestId('task-changes-outcomes');
    // 黄标可见 + 回滚按钮只在黄标行出现
    expect(within(outcomes).getByText(/已跳过/)).toHaveClass('text-status-warning');
    const rollbackBtn = within(outcomes).getByRole('button', {
      name: '回滚到此文件此条之前',
    });
    fireEvent.click(rollbackBtn);
    await waitFor(() =>
      expect(rollbackMock).toHaveBeenCalledWith('ws-1', 'docs/guide.md', 'je-2'),
    );
    // 组合回滚逐文件结果渲染（不静默）
    const rollbackOutcomes = await screen.findByTestId('task-rollback-outcomes');
    expect(within(rollbackOutcomes).getAllByText('已撤回')).toHaveLength(2);
    expect(within(rollbackOutcomes).getByText(/逆序组合第 2 步/)).toBeInTheDocument();
  });

  it('非黄标结果行无回滚按钮（边界：组合操作仅漂移拦截场景提供）', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'failed', detail: '路径越界' },
    ]);
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByRole('button', { name: /撤回全部入账变更/ }));
    const outcomes = await screen.findByTestId('task-changes-outcomes');
    expect(
      within(outcomes).queryByRole('button', { name: '回滚到此文件此条之前' }),
    ).not.toBeInTheDocument();
    expect(within(outcomes).getByText('撤回失败')).toHaveClass('text-status-error');
  });

  it('rollbackFileBefore 抛错 → 错误行可见（错误路径）', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-2', path: 'docs/guide.md', result: 'skipped-diverged' },
    ]);
    rollbackMock.mockRejectedValue(new Error('锚点条目已被配额清理'));
    render(<TaskChangesPanel workspaceId="ws-1" taskId="task-9" />);
    fireEvent.click(await screen.findByRole('button', { name: /撤回全部入账变更/ }));
    const outcomes = await screen.findByTestId('task-changes-outcomes');
    fireEvent.click(
      within(outcomes).getByRole('button', { name: '回滚到此文件此条之前' }),
    );
    expect(await screen.findByText('回滚失败：锚点条目已被配额清理')).toBeInTheDocument();
  });
});
