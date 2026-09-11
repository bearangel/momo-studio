// renderer/src/components/im/ChangesChip.test.tsx
//
// ChangesChip（v2.5 Task 8）消息流「变更」chip 测试：
//   - 挂载懒查 ipc.journal.list({workspaceId, streamSessionId})；空数组/查询失败不渲染
//   - message.streamSessionId 为 null → 不查询不渲染
//   - chip 显示「N 处变更」；点开逐文件列表（折叠默认），逐文件展开行级 diff
//     （del 行 text-status-error / add 行 text-status-success 语义 token）
//   - 同 path 链式条目 → 单文件组，净 diff = 首条 before → 末条 after
//   - create 条目（beforeText null）→ 全 add 无 del
//   - 每文件撤回 / 全部撤回 → ipc.journal.revert(workspaceId, ids)；完成后幂等二次 list
//   - 撤回五态结果列表呈现：skipped-diverged 黄标 + detail + [强制撤回]（force:true）；
//     failed 红标；revert 抛错不静默
// mock 形态照抄 SandboxNotice.test（window.api 桩 + ipc Proxy 透传），
// JournalEntryView / ImMessage 均按 types.d.ts 完整形状构造。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ImMessage, JournalEntryView, RevertOutcome } from '../../ipc/types';
import { ChangesChip } from './ChangesChip';

const listMock = vi.fn();
const revertMock = vi.fn();

// 桩 window.api（journal 命名空间全形状；组件经 ipc Proxy 透传消费）
const mockApi = {
  journal: {
    list: listMock,
    revert: revertMock,
    scan: vi.fn(),
    rollbackFileBefore: vi.fn(),
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造完整 ImMessage（默认：done 终态 + ws-1 / ss-1 身份齐备） */
function makeMessage(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'msg-1',
    sessionId: 'ses-1',
    sender: '@coder:local',
    body: '完成了',
    eventType: 'agent_reply',
    streamSessionId: 'ss-1',
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: 'ws-1',
    taskId: null,
    createdAt: 1757000000000,
    updatedAt: 1757000000000,
    ...overrides,
  };
}

/** 构造完整 JournalEntryView（真实形状——types.d.ts 契约，不用简化占位） */
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
    beforeText: 'stable-keep\nold-remove\nstable-tail',
    afterText: 'stable-keep\nnew-insert\nstable-tail',
    ...overrides,
  };
}

/** 双文件夹具：src/app.ts（modify 1del+1add）+ docs/guide.md（create 2add） */
function makeTwoFileEntries(): JournalEntryView[] {
  return [
    makeEntry({ id: 'je-1' }),
    makeEntry({
      id: 'je-2',
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

describe('ChangesChip — 挂载懒查与空态', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('挂载懒查 list({workspaceId, streamSessionId})（恰一次）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<ChangesChip message={makeMessage()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', streamSessionId: 'ss-1' });
  });

  it('list 返回空数组 → 不渲染 chip', async () => {
    const { container } = render(<ChangesChip message={makeMessage()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('message.streamSessionId 为 null → 不查询不渲染', async () => {
    const { container } = render(<ChangesChip message={makeMessage({ streamSessionId: null })} />);
    // 无异步查询挂起，直接断言未发起 list 且不渲染
    expect(listMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('list 查询失败（reject）→ 降级不渲染，不抛错（错误路径）', async () => {
    listMock.mockRejectedValue(new Error('store 未注入'));
    const { container } = render(<ChangesChip message={makeMessage()} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });
});

describe('ChangesChip — chip 展示与逐文件 diff', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('2 条目 → chip 显示「2 处变更」', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<ChangesChip message={makeMessage()} />);
    expect(await screen.findByRole('button', { name: /2 处变更/ })).toBeInTheDocument();
  });

  it('点开 chip：逐文件行可见（path + 计数），diff 默认折叠', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /docs\/guide\.md/ })).toBeInTheDocument();
    expect(screen.queryByTestId('changes-diff')).not.toBeInTheDocument();
  });

  it('逐文件展开：del 行 text-status-error、add 行 text-status-success、ctx 行中性（modify 1del+1add）', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }));
    const diff = await screen.findByTestId('changes-diff');
    const delRows = diff.querySelectorAll('div.text-status-error');
    const addRows = diff.querySelectorAll('div.text-status-success');
    expect(delRows).toHaveLength(1);
    expect(delRows[0]).toHaveTextContent('old-remove');
    expect(addRows).toHaveLength(1);
    expect(addRows[0]).toHaveTextContent('new-insert');
    expect(within(diff).getByText('stable-keep')).toBeInTheDocument();
  });

  it('create 条目（beforeText null）→ 全 add 无 del', async () => {
    listMock.mockResolvedValue(makeTwoFileEntries());
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: /docs\/guide\.md/ }));
    const diff = await screen.findByTestId('changes-diff');
    expect(diff.querySelectorAll('div.text-status-success')).toHaveLength(2);
    expect(diff.querySelectorAll('div.text-status-error')).toHaveLength(0);
  });

  it('同 path 链式条目 → 单文件组「2 条」，净 diff = 首条 before → 末条 after', async () => {
    // e1: a,b → a,b,c；e2: a,b,c → a,x,c。净效果 a,b → a,x,c = ctx a + del b + add x + add c
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
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    const fileRow = screen.getByRole('button', { name: /src\/app\.ts/ });
    expect(fileRow).toHaveTextContent(/2 条/);
    fireEvent.click(fileRow);
    const diff = await screen.findByTestId('changes-diff');
    expect(diff.querySelectorAll('div.text-status-error')).toHaveLength(1);
    expect(diff.querySelectorAll('div.text-status-success')).toHaveLength(2);
    // 中间态 'b\nc' 不作为整体出现（净 diff 语义）
    expect(within(diff).getByText('x')).toBeInTheDocument();
  });

  it('beforeText 与 afterText 双缺失 → 显示快照缺失提示（不崩）', async () => {
    listMock.mockResolvedValue([
      makeEntry({ beforeText: null, afterText: null }),
    ]);
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /1 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }));
    expect(await screen.findByText('内容快照缺失，无法展示差异')).toBeInTheDocument();
  });
});

describe('ChangesChip — 撤回交互', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(makeTwoFileEntries());
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('每文件撤回 → revert(workspaceId, 该文件全部 ids) + 完成后幂等二次 list', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
    ]);
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    const fileRevertBtn = screen.getAllByRole('button', { name: '撤回' })[0];
    if (fileRevertBtn === undefined) throw new Error('撤回按钮未渲染');
    fireEvent.click(fileRevertBtn);
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1'], undefined),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('全部撤回 → revert(workspaceId, 全部条目 ids)', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'je-2', path: 'docs/guide.md', result: 'reverted' },
    ]);
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1', 'je-2'], undefined),
    );
  });

  it('撤回进行中（busy）重复点击不重复发起', async () => {
    let resolveRevert: (v: RevertOutcome[]) => void = () => {};
    revertMock.mockReturnValue(
      new Promise<RevertOutcome[]>((res) => {
        resolveRevert = res;
      }),
    );
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    const btn = screen.getByRole('button', { name: '全部撤回' });
    fireEvent.click(btn);
    fireEvent.click(btn); // busy 中二次点击应被吞
    await waitFor(() => expect(revertMock).toHaveBeenCalledTimes(1));
    resolveRevert([]);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe('ChangesChip — 撤回结果呈现（五态不静默）', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue(makeTwoFileEntries());
    revertMock.mockReset().mockResolvedValue([]);
  });

  it('reverted / restored-missing / no-op / failed 各自呈现（failed 红标）', async () => {
    revertMock.mockResolvedValue([
      { id: 'je-1', path: 'src/app.ts', result: 'reverted' },
      { id: 'x-1', path: 'a.ts', result: 'restored-missing' },
      { id: 'x-2', path: 'b.ts', result: 'no-op', detail: '条目不存在（可能已被配额清理）' },
      { id: 'x-3', path: 'c.ts', result: 'failed', detail: '路径越界' },
    ]);
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    const list = await screen.findByTestId('changes-outcomes');
    expect(within(list).getByText('已撤回')).toHaveClass('text-status-success');
    expect(within(list).getByText('文件缺失已还原')).toHaveClass('text-status-success');
    expect(within(list).getByText('无需撤回')).toBeInTheDocument();
    expect(within(list).getByText(/条目不存在/)).toBeInTheDocument();
    const failedLabel = within(list).getByText('撤回失败');
    expect(failedLabel).toHaveClass('text-status-error');
    expect(within(list).getByText('路径越界')).toBeInTheDocument();
  });

  it('skipped-diverged → 黄标 + detail + [强制撤回] → revert(…, { force: true })', async () => {
    revertMock.mockResolvedValueOnce([
      {
        id: 'je-1',
        path: 'src/app.ts',
        result: 'skipped-diverged',
        detail: 'hash 漂移：文件在记账后被其他变更修改（force=true 可强制写回）',
      },
    ]);
    revertMock.mockResolvedValueOnce([{ id: 'je-1', path: 'src/app.ts', result: 'reverted', detail: '强制写回：覆盖漂移后的内容' }]);
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    const list = await screen.findByTestId('changes-outcomes');
    const warnLabel = within(list).getByText(/已跳过/);
    expect(warnLabel).toHaveClass('text-status-warning');
    expect(within(list).getByText(/hash 漂移/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: '强制撤回' }));
    await waitFor(() =>
      expect(revertMock).toHaveBeenLastCalledWith('ws-1', ['je-1'], { force: true }),
    );
    // 强制撤回结果同样呈现（detail 可见）
    await waitFor(() =>
      expect(within(screen.getByTestId('changes-outcomes')).getByText(/强制写回/)).toBeInTheDocument(),
    );
  });

  it('revert 抛错 → 错误行可见（不静默吞掉）', async () => {
    revertMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<ChangesChip message={makeMessage()} />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部撤回' }));
    expect(await screen.findByText('撤回失败：journal store 未注入')).toBeInTheDocument();
  });
});
