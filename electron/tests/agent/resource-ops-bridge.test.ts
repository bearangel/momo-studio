// electron/tests/agent/resource-ops-bridge.test.ts
//
// resource-ops 桥主进程侧分支单测（spec 2026-11-09-resource-creation-skills §6；
// 确认门扩面 spec 2026-11-12 §5.6/§7/§10）。
// executor 注入 fake——纯函数化锁线协议（type/id 配对、error string 化、非本分支不消费）。
// 桥模块 import resource-ops → crud.ts 引入的 runtime 依赖在测试环境不可用，
// 与 resource-ops.test.ts 同款 mock。确认通道整体 mock（进程边界——BrowserWindow
// 广播不进单测）；allow/deny 以 fake 注入，桥内门控逻辑全真。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../src/main/storage/db';
import { handleResourceOpMessage, notifyResourceOpSucceeded, MEMBER_AFFECTING_OPS, confirmWaitBudgetMs, memberAffecting } from '../../src/main/agent/resource-ops-bridge';
import { confirmTierForOp, buildConfirmPayload } from '../../src/main/agent/resource-ops';
import { getSkillsDir } from '../../src/main/skill/zip-uploader';
import { broadcastRuntimeChanged } from '../../src/main/im/session-service';
import { broadcastResourceChanged } from '../../src/main/resource/changed-emit';

// 确认通道 mock（momo-test-rules：只 mock 进程边界，桥逻辑全真）。hoisted 可变
// fake——每用例经 mockResolvedValueOnce 注入 allow/deny，免 doMock 动态重导入。
const confirmMock = vi.hoisted(() => ({ requestAgentOpConfirm: vi.fn() }));
vi.mock('../../src/main/agent/agent-op-confirm', () => ({
  requestAgentOpConfirm: confirmMock.requestAgentOpConfirm,
  resolvePendingByChildExit: vi.fn(),
}));

vi.mock('../../src/main/agent/runtime-status', () => ({
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  stopAgentRuntime: vi.fn(),
  // resource-ops 引入 resource/mcp-config（updateMcp，Task 8）后模块图经
  // hub-install → delegation-runner 在顶层调用 broadcastWriteGrantDenied——
  // 本文件不测委派，桩掉即可
  broadcastWriteGrantDenied: vi.fn(),
}));
vi.mock('../../src/main/im/session-service', () => ({
  broadcastRuntimeChanged: vi.fn(),
}));
vi.mock('../../src/main/resource/changed-emit', () => ({
  broadcastResourceChanged: vi.fn(),
}));

// 确认门用例会触发 buildConfirmPayload 的容忍式 DB 查询（workspace 名 / agent
// 目标解析）——无 AP_USER_DATA_DIR 时 getDb 会落到 ~/.momo-studio 建库（副作用
// 出测试沙箱）。钉到临时目录；容忍路径在「无表」上降级，无需跑迁移。
const tmpRoot = path.join(os.tmpdir(), `ap-bridge-confirm-${Date.now()}`);
beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  confirmMock.requestAgentOpConfirm.mockReset();
});
afterEach(() => {
  closeDb();
  delete process.env.AP_USER_DATA_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('handleResourceOpMessage（主进程侧分支）', () => {
  it('type=resource-op 且 id 配对：成功回 result', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r1', op: 'list', args: { type: 'teams' } },
      'ws-1',
      send,
      async (op, args, wsId) => ({ op, args, wsId }), // 注入 fake executeResourceOp
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r1', result: expect.anything() }));
  });

  it('执行失败回 error（string 化——非 Error 抛出物不许误判成功）', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r2', op: 'createTeam', args: {} },
      'ws-1',
      send,
      async () => { throw '裸字符串错误'; },
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r2', error: '裸字符串错误' }));
  });

  it('非 resource-op 消息返回 false（不消费）', async () => {
    const send = vi.fn();
    const consumed = await handleResourceOpMessage({ type: 'mcp:listTools', id: 'x' }, 'ws-1', send, async () => null);
    expect(consumed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('list 成功不广播刷新（只读 op——技能「创建前先盘点」高频触发，不得引发 renderer 重拉）', async () => {
    vi.mocked(broadcastResourceChanged).mockClear();
    vi.mocked(broadcastRuntimeChanged).mockClear();
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-list', op: 'list', args: {} },
      'ws-1',
      send,
      async () => ({ agents: [] }),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r-list' }));
    expect(broadcastResourceChanged).not.toHaveBeenCalled();
    expect(broadcastRuntimeChanged).not.toHaveBeenCalled();
  });

  it('写 op 成功广播 resource:changed（member 类额外广播 runtimeChanged）', async () => {
    vi.mocked(broadcastResourceChanged).mockClear();
    vi.mocked(broadcastRuntimeChanged).mockClear();
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-cs', op: 'createSkill', args: {} },
      'ws-1',
      send,
      async () => ({ slug: 's' }),
    );
    expect(broadcastResourceChanged).toHaveBeenCalledTimes(1);
    expect(broadcastRuntimeChanged).not.toHaveBeenCalled();

    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-ct', op: 'createTeam', args: {} },
      'ws-1',
      send,
      async () => ({ teamId: 't' }),
    );
    expect(broadcastResourceChanged).toHaveBeenCalledTimes(2);
    expect(broadcastRuntimeChanged).toHaveBeenCalledTimes(1);

    // MEMBER_AFFECTING_OPS = createAgent | addMember | createTeam | updateCapabilities | updateProfile（语义固定）
    expect(MEMBER_AFFECTING_OPS).toContain('createTeam');
  });
});

describe('resource-ops-bridge 确认门（spec §7/§10）', () => {
  const executor = vi.fn(async (op: string) => ({ ok: op }));
  const send = vi.fn();

  beforeEach(() => {
    // 共享 fake 跨用例清账（momo-test-rules：断言「未调用」前必须清历史）
    executor.mockClear();
    send.mockClear();
  });

  it('确认档位矩阵：describeAgent=none / updateProfile·updateSkill·updateMcp=required / updateCapabilities 按 add 与 scope 判', () => {
    expect(confirmTierForOp('describeAgent', {})).toBe('none');
    expect(confirmTierForOp('updateProfile', {})).toBe('required');
    expect(confirmTierForOp('updateSkill', {})).toBe('required');
    expect(confirmTierForOp('updateMcp', {})).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { add: { skills: ['x'] } })).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { scope: 'definition', remove: { tools: ['bash'] } })).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { remove: { tools: ['bash'] } })).toBe('none'); // 纯减权免确认
    expect(confirmTierForOp('createAgent', {})).toBe('none'); // 既有 create 零变化
  });

  it('需确认 op：用户允许 → executor 执行且 ctx 透传（5 参）', async () => {
    confirmMock.requestAgentOpConfirm.mockResolvedValueOnce({ allowed: true, reason: '' });
    const m = { type: 'resource-op', id: 'r1', op: 'updateProfile', args: { agent: 'x' } };
    await handleResourceOpMessage(m, 'ws-1', send, executor, { background: false, callerInstanceId: 'me' });
    expect(confirmMock.requestAgentOpConfirm).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('updateProfile', expect.anything(), 'ws-1', undefined, { background: false, callerInstanceId: 'me' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r1', result: { ok: 'updateProfile' } }));
  });

  it('用户拒绝 → executor 不执行，错误文案回子进程', async () => {
    confirmMock.requestAgentOpConfirm.mockResolvedValueOnce({ allowed: false, reason: '用户在确认卡上拒绝了本次变更' });
    await handleResourceOpMessage({ type: 'resource-op', id: 'r2', op: 'updateMcp', args: {} }, 'ws-1', send, executor, { background: false });
    expect(executor).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r2', error: expect.stringContaining('拒绝') }));
  });

  it('后台链 fail-closed：background=true 的需确认 op 立即拒绝、不弹卡（spec §7.3）', async () => {
    await handleResourceOpMessage({ type: 'resource-op', id: 'r3', op: 'updateProfile', args: {} }, 'ws-1', send, executor, { background: true });
    expect(confirmMock.requestAgentOpConfirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('后台') }));
  });

  it('background 取自 ctx 闭包而非消息体（Review Focus ⑤）', async () => {
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r4', op: 'updateProfile', args: {}, background: false }, // 消息体伪造 false
      'ws-1', send, executor, { background: true });
    expect(confirmMock.requestAgentOpConfirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('后台') }));
  });

  it('免确认 op 直通：describeAgent 不触碰确认通道', async () => {
    await handleResourceOpMessage({ type: 'resource-op', id: 'r5', op: 'describeAgent', args: {} }, 'ws-1', send, executor, { background: false });
    expect(confirmMock.requestAgentOpConfirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
  });

  it('per-op 超时：需确认 op 子进程等待 10min30s，普通 op 维持 30s', () => {
    expect(confirmWaitBudgetMs('updateProfile')).toBe(10 * 60_000 + 30_000);
    expect(confirmWaitBudgetMs('updateCapabilities', { add: { skills: ['x'] } })).toBe(10 * 60_000 + 30_000);
    expect(confirmWaitBudgetMs('updateCapabilities', { remove: { tools: ['bash'] } })).toBe(30_000);
    expect(confirmWaitBudgetMs('describeAgent')).toBe(30_000);
    expect(confirmWaitBudgetMs('createAgent')).toBe(30_000);
  });

  it('广播矩阵：updateCapabilities → resource:changed + runtimeChanged；updateSkill → 仅 resource:changed；describeAgent → 零广播', () => {
    expect(memberAffecting('updateCapabilities')).toBe(true);
    expect(memberAffecting('updateProfile')).toBe(true);
    expect(memberAffecting('updateSkill')).toBe(false);
    expect(memberAffecting('describeAgent')).toBe(false);

    // describeAgent 只读：成功后不触发任何刷新广播（spec §6.2 矩阵）
    vi.mocked(broadcastResourceChanged).mockClear();
    vi.mocked(broadcastRuntimeChanged).mockClear();
    notifyResourceOpSucceeded('describeAgent');
    expect(broadcastResourceChanged).not.toHaveBeenCalled();
    expect(broadcastRuntimeChanged).not.toHaveBeenCalled();
  });

  it('updateCapabilities 幽灵 ref：确认门前置校验——不弹卡不执行，错误含非法项回子进程（F3）', async () => {
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-ghost', op: 'updateCapabilities', args: { agent: 'x', add: { skills: ['ghost-skill'] } } },
      'ws-1', send, executor, { background: false },
    );
    expect(confirmMock.requestAgentOpConfirm).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-op', id: 'r-ghost',
      error: expect.stringContaining('skill=ghost-skill'),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-op', id: 'r-ghost',
      error: expect.stringContaining('非法引用'),
    }));
  });

  it('updateCapabilities 合法 ref：前置校验通过——卡照常弹且 executor 执行（F3）', async () => {
    // 种子 custom skill（.sha256 标记 = listInstalled 识别前提——resource-ops.test 同款手法）
    const dir = getSkillsDir();
    fs.mkdirSync(`${dir}/weather`, { recursive: true });
    fs.writeFileSync(`${dir}/weather/SKILL.md`, '---\nname: weather\ndescription: d\n---\nb');
    fs.writeFileSync(`${dir}/weather/.sha256`, 'seed');
    confirmMock.requestAgentOpConfirm.mockResolvedValueOnce({ allowed: true, reason: '' });
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-ok', op: 'updateCapabilities', args: { agent: 'x', add: { skills: ['weather'] } } },
      'ws-1', send, executor, { background: false },
    );
    expect(confirmMock.requestAgentOpConfirm).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('updateCapabilities', expect.anything(), 'ws-1', undefined, { background: false });
  });

  it('updateCapabilities 形状歪输入（add 非对象）：前置校验同口径先验，不弹卡', async () => {
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r-shape', op: 'updateCapabilities', args: { agent: 'x', scope: 'definition', add: 'not-an-object' } },
      'ws-1', send, executor, { background: false },
    );
    expect(confirmMock.requestAgentOpConfirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource-op', id: 'r-shape',
      error: expect.stringContaining('add'),
    }));
  });

  it('buildConfirmPayload：updateCapabilities 结构化 diff（riskNote 拼接扩权与定义提示）', () => {
    const p = buildConfirmPayload('updateCapabilities', {
      agent: 'ghost-agent', scope: 'definition',
      add: { tools: ['bash'] }, remove: { skills: ['old'] },
    }, 'ws-1');
    expect(p).not.toBeNull();
    expect(p!.requester.op).toBe('updateCapabilities');
    expect(p!.requester.toolName).toBe('update_agent_capabilities');
    expect(p!.diff.target.kind).toBe('definition');
    expect(p!.diff.adds).toEqual([{ field: 'tools', ref: 'bash' }]);
    expect(p!.diff.removes).toEqual([{ field: 'skills', ref: 'old' }]);
    expect(p!.riskNote).toContain('扩权');
    expect(p!.riskNote).toContain('全局生效');
  });

  it('buildConfirmPayload：免确认 op 返回 null', () => {
    expect(buildConfirmPayload('describeAgent', {}, 'ws-1')).toBeNull();
    expect(buildConfirmPayload('createAgent', {}, 'ws-1')).toBeNull();
  });
});
