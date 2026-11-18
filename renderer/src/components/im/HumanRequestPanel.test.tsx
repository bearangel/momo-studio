// renderer/src/components/im/HumanRequestPanel.test.tsx
//
// 会话请求面板行为锁（Task 22，预览合同 .omo/previews/2026-11-13-task-lifecycle-session.html §1）：
//   1. 空态不渲染（无 pending → 面板整体不出现）
//   2. 四种 kind 卡渲染 + 答复流（tool_gate 三钮 / question 选项+补充 / manual_action
//      步骤+已完成|做不到 / acceptance 验收通过|打回返工）
//   3. acceptance 走 task.accept / task.reject，不走 human.answer（T16 契约）；
//      打回理由必填（空禁用）
//   4. 超时预警态（deadline < 5min）：「剩余 N 分钟」pill
//   5. 多卡堆叠：折叠头「等待中 N 项」+ 首卡展开 + 折叠行点击换卡
//   6. onChanged / runChanged 推送 → store 重拉 → 面板随真值更新
//
// mock 收窄在 IPC 边界（InFlightPanel 同款：换 window.api，经真实 ipc Proxy）；
// store 用真实 human.store（订阅/重拉链路保真）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { HumanRequestRow } from '../../ipc/types';
import { HumanRequestPanel } from './HumanRequestPanel';
import { useHumanStore } from '../../stores/human.store';

const listMock = vi.fn();
const answerMock = vi.fn();
const attentionMock = vi.fn();
const humanOnChangedMock = vi.fn().mockReturnValue(() => {});
const acceptMock = vi.fn();
const rejectMock = vi.fn();
const continueMock = vi.fn();
const runChangedMock = vi.fn().mockReturnValue(() => {});

const mockApi = {
  human: {
    list: listMock,
    answer: answerMock,
    attention: attentionMock,
    onChanged: humanOnChangedMock,
  },
  task: {
    accept: acceptMock,
    reject: rejectMock,
    continue: continueMock,
    onTaskRunChanged: runChangedMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

/** 构造真实形状 HumanRequestRow（默认 2 分钟前创建、无 deadline） */
function makeRow(overrides: Partial<HumanRequestRow> = {}): HumanRequestRow {
  const now = Date.now();
  return {
    id: 'req-1',
    taskId: null,
    runId: null,
    sessionId: 'sess-1',
    delegationId: null,
    originNodeId: null,
    remoteId: null,
    kind: 'question',
    status: 'pending',
    title: '兼容性确认',
    prompt: '旧版 token 是否继续兼容？',
    payloadJson: null,
    optionsJson: null,
    assigneeNodeId: null,
    authorityJson: null,
    deadlineAt: null,
    timeoutPolicy: 'keep_waiting',
    lastRemindedAt: null,
    answerJson: null,
    answeredByNodeId: null,
    answeredAt: null,
    createdAt: now - 2 * 60_000,
    updatedAt: now - 2 * 60_000,
    canDecide: true,
    ...overrides,
  };
}

const TOOL_GATE_JSON = JSON.stringify({
  toolGate: {
    toolName: 'bash',
    command: 'psql -f migrations/0042_add_retry.sql',
    dirs: ['db/migrations', 'db/seeds'],
  },
});
const QUESTION_OPTS_JSON = JSON.stringify([
  { id: 'keep', label: '继续兼容旧 token', description: '保留 30 天过渡期' },
  { id: 'switch', label: '不兼容，直接切换' },
]);
const MANUAL_STEPS_JSON = JSON.stringify({
  manualAction: { steps: [{ id: 's1', label: '确认镜像已推送' }, { id: 's2', label: '执行滚动重启' }] },
});
const ACCEPTANCE_JSON = JSON.stringify({
  acceptance: {
    runNo: 2,
    summary: '回调重试改为幂等键 + 指数退避',
    files: ['src/payment/retry.ts', 'migrations/0042_add_retry.sql'],
    artifacts: [{ label: '测试结果', value: '12 项通过 · 0 失败' }],
  },
});

/** 挂载并冲刷首轮 loadPending promise */
async function mountPanel(
  sessionId = 'sess-1',
  props: { onAcceptanceFullscreenChange?: (v: boolean) => void } = {},
): Promise<void> {
  render(<HumanRequestPanel sessionId={sessionId} {...props} />);
  await act(async () => {});
}

/** 冲刷事件合并窗口（store REFETCH_COALESCE_MS=100ms）+ 重拉 promise */
async function flushRefresh(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useHumanStore.getState().__resetForTest();
  listMock.mockReset().mockResolvedValue([]);
  answerMock.mockReset().mockResolvedValue({ disposition: 'answered' });
  attentionMock.mockReset().mockResolvedValue({});
  humanOnChangedMock.mockClear();
  acceptMock.mockReset().mockResolvedValue({});
  rejectMock.mockReset().mockResolvedValue({});
  continueMock.mockReset().mockResolvedValue({});
  runChangedMock.mockClear();
});

afterEach(() => {
  useHumanStore.getState().__resetForTest();
  vi.useRealTimers();
});

describe('HumanRequestPanel — 空态与挂载', () => {
  it('无 pending → 面板不渲染（height 0）', async () => {
    listMock.mockResolvedValue([]);
    const { container } = render(<HumanRequestPanel sessionId="sess-1" />);
    await act(async () => {});
    expect(container.querySelector('[data-testid="human-request-panel"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('挂载即拉取当前会话 pending（human.list 默认 pending 面）', async () => {
    listMock.mockResolvedValue([]);
    await mountPanel();
    expect(listMock).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });
});

describe('HumanRequestPanel — tool_gate 卡', () => {
  const row = (): HumanRequestRow =>
    makeRow({
      id: 'req-gate',
      kind: 'tool_gate',
      title: '写授权：psql -f migrations/0042_add_retry.sql',
      payloadJson: TOOL_GATE_JSON,
      timeoutPolicy: 'deny_and_wrap',
    });

  it('渲染命令块 / 目录 chips / 三钮，答后卡片随真值消失', async () => {
    listMock.mockResolvedValue([row()]);
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    expect(screen.getByText('$ psql -f migrations/0042_add_retry.sql')).toBeInTheDocument();
    expect(screen.getByText('db/migrations')).toBeInTheDocument();
    expect(screen.getByText('db/seeds')).toBeInTheDocument();
    expect(screen.getByText('bash 工具请求写入 2 个目录。')).toBeInTheDocument();

    // 允许本次 → decision:approve（无 scope 注记）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '允许本次' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-gate', { decision: 'approve' }, undefined);
    // 答后立即重拉（store.answer → loadPending），卡片消失
    expect(screen.queryByRole('button', { name: '允许本次' })).not.toBeInTheDocument();
  });

  it('允许本会话 → approve + text=scope:session 注记（答后重拉卡片消失）', async () => {
    const r = row();
    listMock.mockResolvedValueOnce([r]).mockResolvedValue([]);
    await mountPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '允许本会话' }));
    });
    // scope 约定（plan T22 brief）：decision 恒 approve，会话级用 text 注记
    expect(answerMock).toHaveBeenCalledWith(
      'req-gate',
      { decision: 'approve', text: 'scope:session' },
      undefined,
    );
    expect(screen.queryByRole('button', { name: '允许本会话' })).not.toBeInTheDocument();
  });

  it('拒绝 → deny', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-gate', { decision: 'deny' }, undefined);
  });
});

describe('HumanRequestPanel — question 卡', () => {
  it('选项单选默认首项；换选 + 补充说明 → answer {selected, text}', async () => {
    listMock.mockResolvedValue([
      makeRow({ id: 'req-q', kind: 'question', optionsJson: QUESTION_OPTS_JSON }),
    ]);
    await mountPanel();

    expect(screen.getByText('旧版 token 是否继续兼容？')).toBeInTheDocument();
    expect(screen.getByText('继续兼容旧 token')).toBeInTheDocument();
    expect(screen.getByText('保留 30 天过渡期')).toBeInTheDocument();

    fireEvent.click(screen.getByText('不兼容，直接切换'));
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '注意灰度节奏' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    expect(answerMock).toHaveBeenCalledWith(
      'req-q',
      { selected: ['switch'], text: '注意灰度节奏' },
      undefined,
    );
  });

  it('无选项（optionsJson 空）→ 自由文本作答，selected 不携带', async () => {
    listMock.mockResolvedValue([makeRow({ id: 'req-free', kind: 'question' })]);
    await mountPanel();
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '直接切换，不用等产品' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-free', { text: '直接切换，不用等产品' }, undefined);
  });
});

describe('HumanRequestPanel — manual_action 卡', () => {
  const row = (): HumanRequestRow =>
    makeRow({
      id: 'req-m',
      kind: 'manual_action',
      prompt: '请在跳板机执行滚动重启，我没有生产环境权限。',
      payloadJson: MANUAL_STEPS_JSON,
      timeoutPolicy: 'escalate',
    });

  it('步骤 checklist 本地勾选 + 已完成 → answer {completed:true}', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    expect(screen.getByText('请在跳板机执行滚动重启，我没有生产环境权限。')).toBeInTheDocument();
    expect(screen.getByText('确认镜像已推送')).toBeInTheDocument();
    // 本地勾选第一步骤（不进答复载荷，纯跟踪态）
    fireEvent.click(screen.getByText('确认镜像已推送'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '已完成，继续' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-m', { completed: true }, undefined);
  });

  it('做不到 → answer {completed:false}；说明情况附言随答复透传', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: '说明情况' }));
    fireEvent.change(screen.getByLabelText('说明情况'), { target: { value: '生产权限没批下来' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '我做不到 / 转交' }));
    });
    expect(answerMock).toHaveBeenCalledWith(
      'req-m',
      { completed: false, text: '生产权限没批下来' },
      undefined,
    );
  });
});

describe('HumanRequestPanel — acceptance 卡（三动作裁决）', () => {
  const row = (over: Partial<HumanRequestRow> = {}): HumanRequestRow =>
    makeRow({
      id: 'req-acc',
      taskId: 'T-0100',
      kind: 'acceptance',
      title: '第 1 轮交付',
      payloadJson: ACCEPTANCE_JSON,
      ...over,
    });

  it('卡头显示轮次（提交验收 · 第 1 轮交付），跨节点不再靠任务号区分', async () => {
    listMock.mockResolvedValue([row()]);
    await mountPanel();
    expect(screen.getByText(/提交验收 · 第 1 轮交付/)).toBeInTheDocument();
  });

  it('交付说明走 Markdown：字面量 ** 不再出现；文件/产物分段呈现', async () => {
    listMock.mockResolvedValue([
      row({ payloadJson: ACCEPTANCE_JSON.replace('回调重试改为幂等键 + 指数退避', '**幂等键** + 指数退避') }),
    ]);
    await mountPanel();
    expect(screen.queryByText(/\*\*幂等键\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText('幂等键')).toBeInTheDocument();
    expect(screen.getByText('src/payment/retry.ts')).toBeInTheDocument();
    expect(screen.getByText('测试结果：12 项通过 · 0 失败')).toBeInTheDocument();
  });

  it('继续：展开必填要求，空禁用；填后调 task.continue', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    const confirm = screen.getByRole('button', { name: '发送要求并继续' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('下一步要求'), { target: { value: '按主题一写正文' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(continueMock).toHaveBeenCalledWith('T-0100', '按主题一写正文');
  });

  it('完成：二次确认后才调 task.accept', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(acceptMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
    });
    expect(acceptMock).toHaveBeenCalledWith('T-0100');
  });

  it('驳回：展开理由必填；填后调 task.reject 且不触 human.answer', async () => {
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel();

    fireEvent.click(screen.getByRole('button', { name: '驳回' }));
    const confirm = screen.getByRole('button', { name: '确认驳回' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('驳回理由'), { target: { value: '边界场景缺失' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(rejectMock).toHaveBeenCalledWith('T-0100', '边界场景缺失');
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('执行方（canDecide=false）→ 只读卡：等待发起方裁决、零按钮零输入', async () => {
    listMock.mockResolvedValue([row({ canDecide: false, originNodeId: 'node-a' })]);
    await mountPanel();

    expect(screen.getByText(/等待发起方裁决/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '完成' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('驳回理由')).not.toBeInTheDocument();
  });

  it('长交付：交付内容独立滚动、动作行在滚动区之外（方案 B 吸底）', async () => {
    listMock.mockResolvedValue([row({ payloadJson: ACCEPTANCE_JSON })]);
    await mountPanel();

    const scroll = screen.getByTestId('acceptance-scroll');
    expect(scroll.className).toContain('overflow-y-auto');
    const continueBtn = screen.getByRole('button', { name: '继续' });
    expect(scroll.contains(continueBtn)).toBe(false);
    expect(screen.getByTestId('acceptance-footer').contains(continueBtn)).toBe(true);
  });

  it('满屏态：交付说明不再折叠（无「展开全文」/无行数截断）', async () => {
    const longPayload = JSON.stringify({
      acceptance: { runNo: 1, summary: '长交付说明'.repeat(220), files: [], artifacts: [] },
    });
    listMock.mockResolvedValue([row({ payloadJson: longPayload })]);
    await mountPanel('sess-1');
    expect(screen.getByRole('button', { name: '展开全文' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '满屏查看' }));
    expect(screen.queryByRole('button', { name: '展开全文' })).not.toBeInTheDocument();
  });

  it('满屏按钮：点开 → 回调 true + 变「还原」；Esc 退出回调 false', async () => {
    const spy = vi.fn();
    listMock.mockResolvedValue([row()]);
    await mountPanel('sess-1', { onAcceptanceFullscreenChange: spy });

    fireEvent.click(screen.getByRole('button', { name: '满屏查看' }));
    expect(spy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: '还原' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(spy).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: '满屏查看' })).toBeInTheDocument();
  });

  it('满屏态下完成裁决 → 满屏自动复位（防留空面板）', async () => {
    const spy = vi.fn();
    listMock.mockResolvedValueOnce([row()]).mockResolvedValue([]);
    await mountPanel('sess-1', { onAcceptanceFullscreenChange: spy });

    fireEvent.click(screen.getByRole('button', { name: '满屏查看' }));
    expect(spy).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
    });
    expect(spy).toHaveBeenLastCalledWith(false);
  });

  it('镜像行 remote.truncated → 交付内容截断警示', async () => {
    const payload = { ...(JSON.parse(ACCEPTANCE_JSON) as Record<string, unknown>), remote: { truncated: true } };
    listMock.mockResolvedValue([
      row({ id: 'req-trunc', originNodeId: 'node-b', payloadJson: JSON.stringify(payload) }),
    ]);
    await mountPanel();

    expect(screen.getByText(/交付内容经旧版通道截断/)).toBeInTheDocument();
  });
});

describe('HumanRequestPanel — 超时预警态', () => {
  it('deadline 剩余 < 5 分钟 → 「剩余 N 分钟」pill + 超时策略行', async () => {
    listMock.mockResolvedValue([
      makeRow({
        id: 'req-warn',
        kind: 'tool_gate',
        payloadJson: TOOL_GATE_JSON,
        timeoutPolicy: 'deny_and_wrap',
        deadlineAt: Date.now() + 2 * 60_000,
      }),
    ]);
    await mountPanel();

    expect(screen.getByText('剩余 2 分钟')).toBeInTheDocument();
    expect(
      screen.getByText('超时策略：工具门到期默认「拒绝并让 agent 收尾」，不算 failed。'),
    ).toBeInTheDocument();
    // 未决态描述行不出现（预警态互换）
    expect(screen.queryByText('bash 工具请求写入 2 个目录。')).not.toBeInTheDocument();
  });

  it('deadline 远（≥5 分钟）→ 常规「等待 N 分钟」meta，无剩余 pill', async () => {
    listMock.mockResolvedValue([
      makeRow({ id: 'req-calm', kind: 'question', deadlineAt: Date.now() + 20 * 60_000 }),
    ]);
    await mountPanel();
    expect(screen.queryByText(/剩余 \d+ 分钟/)).not.toBeInTheDocument();
    expect(screen.getByText('提问 · 等待 2 分钟')).toBeInTheDocument();
  });
});

describe('HumanRequestPanel — 多卡堆叠态', () => {
  const gateRow = makeRow({
    id: 'req-a',
    kind: 'tool_gate',
    payloadJson: TOOL_GATE_JSON,
    deadlineAt: Date.now() + 60_000,
  });
  const questionRow = makeRow({
    id: 'req-b',
    kind: 'question',
    title: '登录回归 · 兼容性确认',
    optionsJson: QUESTION_OPTS_JSON,
    createdAt: Date.now() - 8 * 60_000,
  });

  it('两卡 → 折叠头「等待中 2 项」+ 首卡展开 + 次卡折叠行；点击折叠行换卡', async () => {
    listMock.mockResolvedValue([gateRow, questionRow]);
    await mountPanel();

    expect(screen.getByTestId('human-stack-head').textContent).toContain('等待中 2 项');
    expect(screen.getByTestId('human-stack-head').textContent).toContain('最早 1 分钟后超时预警');
    // 首卡（tool_gate）展开，次卡（question）为折叠行
    expect(screen.getByTestId('human-card-req-a')).toBeInTheDocument();
    expect(screen.getByTestId('human-collapsed-req-b')).toBeInTheDocument();
    expect(screen.getByTestId('human-collapsed-req-b').textContent).toContain('登录回归 · 兼容性确认');

    await act(async () => {
      fireEvent.click(screen.getByTestId('human-collapsed-req-b'));
    });
    expect(screen.getByTestId('human-card-req-b')).toBeInTheDocument();
    expect(screen.getByTestId('human-collapsed-req-a')).toBeInTheDocument();
  });

  it('单卡 → 无折叠头', async () => {
    listMock.mockResolvedValue([questionRow]);
    await mountPanel();
    expect(screen.queryByTestId('human-stack-head')).toBeNull();
  });

  it('同 kind 换卡状态隔离：两张 question 切换不串选中/草稿（KindCard key 锁）', async () => {
    const rowA = makeRow({
      id: 'req-qa',
      kind: 'question',
      optionsJson: JSON.stringify([
        { id: 'opt-a1', label: 'A 选项一' },
        { id: 'opt-a2', label: 'A 选项二' },
      ]),
    });
    const rowB = makeRow({
      id: 'req-qb',
      kind: 'question',
      prompt: 'B 的问题正文',
      optionsJson: JSON.stringify([{ id: 'opt-b1', label: 'B 选项一' }]),
    });
    listMock.mockResolvedValue([rowA, rowB]);
    await mountPanel();

    // A 展开（首卡）：选 A 的第二项 + 草稿
    fireEvent.click(screen.getByText('A 选项二'));
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: 'A 的草稿' },
    });

    // 切到 B（同 kind 折叠行换卡——缺 key 时 QuestionBody 实例复用、状态串卡）
    await act(async () => {
      fireEvent.click(screen.getByTestId('human-collapsed-req-qb'));
    });

    // B 全新实例：草稿为空、A 的选项不在场（选中态回 B 自己的首项）
    expect(screen.getByLabelText('补充说明（可选）')).toHaveValue('');
    expect(screen.queryByText('A 选项二')).not.toBeInTheDocument();

    // 直接提交 → 载荷只含 B 自己的选项 id（缺 key 时会串成 opt-a2）
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: 'B 的说明' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-qb', { selected: ['opt-b1'], text: 'B 的说明' }, undefined);
    expect(answerMock).not.toHaveBeenCalledWith(expect.stringContaining('req-q'), expect.objectContaining({ selected: ['opt-a2'] }), undefined);
  });
});

describe('HumanRequestPanel — 推送刷新', () => {
  it('human.onChanged(answered) → 合并重拉 → 卡片随真值消失', async () => {
    const r = makeRow({ id: 'req-push', kind: 'question' });
    listMock.mockResolvedValueOnce([r]).mockResolvedValue([]);
    await mountPanel();
    expect(screen.getByText('旧版 token 是否继续兼容？')).toBeInTheDocument();

    const onChanged = humanOnChangedMock.mock.calls[0]![0];
    await act(async () => {
      onChanged({ sessionId: 'sess-1', requestId: 'req-push', kind: 'answered' });
    });
    await flushRefresh();

    expect(screen.queryByText('旧版 token 是否继续兼容？')).not.toBeInTheDocument();
  });

  it('task.onTaskRunChanged → 兜底重拉（T16 carry：supersede/cancel 无 human:changed）', async () => {
    const r = makeRow({ id: 'req-run', kind: 'question' });
    listMock.mockResolvedValueOnce([r]).mockResolvedValue([]);
    await mountPanel();

    const onRunChanged = runChangedMock.mock.calls[0]![0];
    await act(async () => {
      onRunChanged({ taskId: 'T-1', runId: 'run-1', status: 'cancelled' });
    });
    await flushRefresh();

    expect(screen.queryByText('旧版 token 是否继续兼容？')).not.toBeInTheDocument();
  });
});

// ── P2 S6 镜像行（CONTRACT 2026-11-14-tracking #1–#5/#12）──────────────────

describe('HumanRequestPanel — S6 镜像行（远端来源 / 代答提示 / peer 中性卡）', () => {
  const mirrorRow = (overrides: Partial<HumanRequestRow> = {}): HumanRequestRow =>
    makeRow({
      id: 'req-mir',
      taskId: 'T-101',
      delegationId: 'dl-9',
      originNodeId: 'node-b',
      originNodeName: '研发工作站',
      remoteId: 'iv-9',
      kind: 'question',
      optionsJson: QUESTION_OPTS_JSON,
      ...overrides,
    });

  it('远端来源徽标「来自 研发工作站」+ 代答提示行「代答后 … 原地继续」（CONTRACT #1–#3）', async () => {
    listMock.mockResolvedValue([mirrorRow()]);
    await mountPanel();

    expect(screen.getByText('来自 研发工作站')).toBeInTheDocument();
    expect(screen.getByText('代答后 研发工作站 原地继续')).toBeInTheDocument();
    // 代答仍走 human.answer 通道（主进程路由 hub task.answer）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-mir', { selected: ['keep'] }, undefined);
  });

  it('节点名缺席 → 文案降级「远端节点」（presence 快照无此节点）', async () => {
    listMock.mockResolvedValue([mirrorRow({ originNodeName: null })]);
    await mountPanel();

    expect(screen.getByText('来自 远端节点')).toBeInTheDocument();
    expect(screen.getByText('代答后 远端节点 原地继续')).toBeInTheDocument();
  });

  // ── S9（A4，S6 Important-1 清偿）：工作站段（payload remote.workstation）──

  it('工作站段在场 → 徽标全形态「来自 研发工作站 · dev-ws」（CONTRACT #1）', async () => {
    listMock.mockResolvedValue([
      mirrorRow({ payloadJson: JSON.stringify({ remote: { workstation: 'dev-ws' } }) }),
    ]);
    await mountPanel();

    expect(screen.getByText('来自 研发工作站 · dev-ws')).toBeInTheDocument();
    expect(screen.queryByText('来自 研发工作站')).not.toBeInTheDocument();
  });

  it('acceptance 镜像：remote 段与 acceptance 段同 payload 并列（互不挤占）', async () => {
    const payload = JSON.parse(ACCEPTANCE_JSON) as Record<string, unknown>;
    payload['remote'] = { workstation: 'dev-ws' };
    listMock.mockResolvedValue([
      mirrorRow({ id: 'req-acc-ws', kind: 'acceptance', payloadJson: JSON.stringify(payload), taskId: 'T-101' }),
    ]);
    await mountPanel();

    expect(screen.getByText('来自 研发工作站 · dev-ws')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument();
  });

  it('remote 段畸形（workstation 非串/空串）→ 降级仅节点名（既有行为）', async () => {
    listMock.mockResolvedValue([
      mirrorRow({ payloadJson: JSON.stringify({ remote: { workstation: 42 } }) }),
    ]);
    await mountPanel();

    expect(screen.getByText('来自 研发工作站')).toBeInTheDocument();
  });

  it('peer 镜像干预行 → 中性卡：无任何操作钮、无代答入口（CONTRACT #4/#5）', async () => {
    listMock.mockResolvedValue([mirrorRow({ id: 'req-peer', peerMirror: true })]);
    await mountPanel();

    expect(screen.getByText('执行方等待人工处理 · 无需你操作')).toBeInTheDocument();
    expect(screen.getByText('平行组不转发人工请求，请在执行节点处理')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
    expect(screen.getByTestId('human-peer-neutral-req-peer')).toBeInTheDocument();
  });

  it('peer 镜像 acceptance 行 → 不替换中性卡（平行组发起方保留验收权）', async () => {
    listMock.mockResolvedValue([
      mirrorRow({ id: 'req-acc-peer', kind: 'acceptance', peerMirror: true, payloadJson: ACCEPTANCE_JSON, taskId: 'T-101' }),
    ]);
    await mountPanel();

    expect(screen.queryByTestId('human-peer-neutral-req-acc-peer')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument();
  });

  it('镜像 acceptance：why 注走 hub 送回变体 + remoteWarning 人话呈现（CONTRACT #12）', async () => {
    listMock.mockResolvedValueOnce([
      mirrorRow({ id: 'req-acc', kind: 'acceptance', payloadJson: ACCEPTANCE_JSON, taskId: 'T-101' }),
    ]).mockResolvedValue([]);
    acceptMock.mockResolvedValue({
      remoteWarning: '远端验收通知失败：连接已重置（本地已验收，执行节点将在重连后对账）',
    });
    await mountPanel();

    expect(screen.getByText('来自 研发工作站')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认完成' }));
    });
    expect(acceptMock).toHaveBeenCalledWith('T-101');
    expect(
      screen.getByText('远端验收通知失败：连接已重置（本地已验收，执行节点将在重连后对账）'),
    ).toBeInTheDocument();
  });

  it('代答发送失败（对端离线）→ 人话错误行呈现（面板 toast 出口）', async () => {
    listMock.mockResolvedValue([mirrorRow({ id: 'req-err' })]);
    answerMock.mockRejectedValue(new Error('代答发送失败：hub 未连接，请先在设置中接入 momo-hub'));
    await mountPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '提交' }));
    });
    expect(
      screen.getByText('代答发送失败：hub 未连接，请先在设置中接入 momo-hub'),
    ).toBeInTheDocument();
    // 行保持 pending：卡片仍在（可重试）
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument();
  });

  it('折叠行远端变体：行内「（来自 研发工作站）」后缀，不加徽标（CONTRACT #2）', async () => {
    listMock.mockResolvedValue([
      makeRow({ id: 'req-first', kind: 'tool_gate', payloadJson: TOOL_GATE_JSON }),
      mirrorRow({ id: 'req-collapsed' }),
    ]);
    await mountPanel();

    const collapsed = screen.getByTestId('human-collapsed-req-collapsed');
    expect(collapsed).toHaveTextContent('（来自 研发工作站）');
  });
});

// db-pro db 载荷渲染（spec 2026-11-17 §7-2）
describe('HumanRequestPanel — tool_gate db 载荷卡', () => {
  const DB_GATE_JSON = JSON.stringify({
    db: { connection: 'conn1', sql: 'UPDATE orders SET status = 1 WHERE id = 42', opClass: 'DML' },
  });
  const dbRow = (): HumanRequestRow =>
    makeRow({
      id: 'req-db',
      kind: 'tool_gate',
      title: '数据库写请求（DML）',
      payloadJson: DB_GATE_JSON,
    });

  it('渲染连接名与 SQL 命令块，无「允许本会话」按钮（数据写不可逆，spec §5.2②）', async () => {
    listMock.mockResolvedValueOnce([dbRow()]).mockResolvedValue([dbRow()]);
    await mountPanel();

    expect(screen.getByText('DML 写请求 · 连接 conn1')).toBeInTheDocument();
    expect(screen.getByText('$ UPDATE orders SET status = 1 WHERE id = 42')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许本会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许本次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('批准 → answer({decision:"approve"})，无 scope 注记', async () => {
    listMock.mockResolvedValueOnce([dbRow()]).mockResolvedValue([]);
    await mountPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '允许本次' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-db', { decision: 'approve' }, undefined);
  });

  it('拒绝 → deny', async () => {
    listMock.mockResolvedValueOnce([dbRow()]).mockResolvedValue([]);
    await mountPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    });
    expect(answerMock).toHaveBeenCalledWith('req-db', { decision: 'deny' }, undefined);
  });
});
