// electron/tests/agent/dispatch-progress-segment.test.ts
//
// dispatch 链进度分段可见性（2026-11-04 生产事故 B 面）：
// 子 agent 静默工作 83 分钟，会话里零进度信号——用户无法判断是否还在动，
// 很可能因此手动停止。本文件锁定新语义：routeTaskReply 心跳（in_progress）
// piggyback 注入单行【进度分段】消息：
//   1. 首条：≥1 工具活动立即发射（用户尽快看到「动起来了」）；零活动不发射
//   2. 节流：同链 2 分钟最多一条 + 自上次发射后无新工具活动不发射（事件时
//      时间检查，无定时器）
//   3. 行形状契约：字面量锁死（boundary-rules：文案是协议）
//   4. 纯会话可见性：不 routeUserChat / 不额外 notifyTaskReply / 不 tryDeliver
//      （绝不唤醒 PM leader）；行不带 taskId（不进链历史聚合面）
//   5. settle / cancel / 链复用（followup）清理节流状态
//
// fixture 保真度：真实 SQLite + 真实 RouterService / dispatchRegistry / 审计
// 写入链（insertToolCall）；mock 仅 runner（进程边界）与 electron 推送。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn<(channel: string, payload?: unknown) => void>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listMessagesBySession } from '../../src/main/storage/messages/repo';
import { insertToolCall } from '../../src/main/audit/insert';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import { RouterService } from '../../src/main/agent/router-service';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
  DispatchRegistry,
  PROGRESS_SEGMENT_INTERVAL_MS,
} from '../../src/main/agent/dispatch-registry';
import { ledgerInsertDispatch } from '../../src/main/agent/dispatch-task-ledger';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessChatId = '';

/** 注册链的捷径（本文件全部用 bg 形态 isFollowupRound=false——进度与投递无关） */
function registerChain(taskId: string): void {
  dispatchRegistry.register({
    taskId,
    pmAssignmentId: 'inst-pm',
    subAssignmentId: 'inst-sub',
    sessionId: sessChatId,
    isFollowupRound: false,
  });
}

/** 经真实 routeEvent 驱动一次 in_progress 心跳（applyRegistryReply 的真实入口） */
async function heartbeat(svc: RouterService, taskId: string): Promise<void> {
  await svc.routeEvent(
    {
      getType: () => 'io.momo-studio.task_reply',
      getContent: () => ({ task_id: taskId, status: 'in_progress', body: '子任务运行中' }),
      getSender: () => 'agent-inst-sub',
      getRoomId: () => sessChatId,
    },
    'owner',
    null,
  );
}

function seedAuditRows(taskId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    insertToolCall({
      workspaceId: 'ws',
      agentBotUserId: 'agent-inst-sub',
      toolName: 'write_file',
      inputSummary: '',
      outputSummary: '',
      success: true,
      durationMs: 1,
      taskId,
    });
  }
}

function seedJournalRows(taskId: string, n: number): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO journal_entries (id, workspace_id, task_id, stream_session_id, tool_name, path, op, created_at)
     VALUES (?, 'ws', ?, 'ss-jx', 'write_file', ?, 'create', ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`je-${taskId}-${i}`, taskId, `src/f${i}.ts`, Date.now());
  }
}

/** 会话里的【进度分段】行（可选按显示名过滤——行本身不带 taskId 列） */
function progressRows(label?: string) {
  return listMessagesBySession(sessChatId).filter(
    (r) =>
      r.body.includes('【进度分段】') &&
      (label === undefined || r.body.includes(`子任务 ${label} `)),
  );
}

beforeEach(() => {
  mockSend.mockClear();
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
  });
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  for (const [inst, uid] of [['inst-pm', 'agent-pm-01'], ['inst-sub', 'agent-inst-sub']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, uid);
  }
  const sess = insertSession({ workspaceId: 'ws', title: 'progress' });
  sessChatId = sess.id;
  __resetDispatchRegistryForTest();
});

afterEach(() => {
  __setElectronApisForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('进度分段：首条发射条件 + 行形状契约', () => {
  it('零工具活动的心跳不发射；出现 ≥1 工具活动后首条立即发射（字面量锁形状）', async () => {
    ledgerInsertDispatch({
      taskId: 'T-p1',
      body: '重构登录模块',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    registerChain('T-p1');
    const executeTask = vi.fn(async (t: { streamSessionId: string }) => ({
      streamSessionId: t.streamSessionId,
    }));
    const notifyTaskReply = vi.fn(async (_n: { body: string }): Promise<void> => undefined);
    const runner = {
      executeTask,
      steer: vi.fn(),
      notifyTaskReply,
      get busy(): boolean {
        return false;
      },
    } as unknown as AgentRunner;
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    // 首拍零工具活动 → 不发射
    await heartbeat(svc, 'T-p1');
    expect(progressRows('重构登录模块')).toHaveLength(0);

    // 工具活动出现（审计 3 次 + 账本 2 处）→ 首条立即发射
    seedAuditRows('T-p1', 3);
    seedJournalRows('T-p1', 2);
    await heartbeat(svc, 'T-p1');
    const rows = progressRows('重构登录模块');
    expect(rows).toHaveLength(1);
    // 行形状契约（字面量）：单行、标题取任务行 title
    expect(rows[0]?.body).toBe(
      '【进度分段】子任务 重构登录模块 进行中 · 工具调用累计 3 次 · 文件变更累计 2 处',
    );
    expect(rows[0]?.sender).toBe('system');
    // 可见性行不进链历史：不带 taskId（区别于回执行）
    expect(rows[0]?.taskId).toBeNull();
    // 实时推送（§6.4 同款——用户看得到）
    expect(
      mockSend.mock.calls.some(
        (c) => c[0] === 'session:message' && (c[1] as { body: string }).body?.includes('【进度分段】'),
      ),
    ).toBe(true);

    // 不唤醒 PM leader：无新回合（executeTask 零调用）；
    // notifyTaskReply 只收到两次原始 in_progress 转发（每拍一次，既有语义）——
    // 进度分段行自身不产生任何额外通知（转发载荷不含进度分段文案）
    expect(executeTask).not.toHaveBeenCalled();
    expect(notifyTaskReply).toHaveBeenCalledTimes(2);
    for (const call of notifyTaskReply.mock.calls) {
      expect(call[0]?.body).not.toContain('【进度分段】');
    }
  });

  it('无任务行 → 标题降级为 taskId 短 id', async () => {
    registerChain('T-p2');
    seedAuditRows('T-p2', 1);
    // 空 runners：结构上杜绝任何 notify / 唤醒（进度的可见性与 leader 无关）
    const svc = new RouterService({ runners: new Map() });

    await heartbeat(svc, 'T-p2');
    const rows = progressRows('T-p2');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(
      '【进度分段】子任务 T-p2 进行中 · 工具调用累计 1 次 · 文件变更累计 0 处',
    );
  });
});

describe('进度分段：2 分钟节流 + 新活动判定', () => {
  it('窗口内新活动抑制；跨窗口且有新活动再发；跨窗口但无新活动仍抑制', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_700_000_000_000;
      vi.setSystemTime(now);
      registerChain('T-p3');
      const svc = new RouterService({ runners: new Map() });

      // t0：3 次工具活动 → 首条
      seedAuditRows('T-p3', 3);
      await heartbeat(svc, 'T-p3');
      expect(progressRows('T-p3')).toHaveLength(1);

      // t0+30s：新增 1 次工具活动，但在 2 分钟窗口内 → 抑制
      now += 30_000;
      vi.setSystemTime(now);
      seedAuditRows('T-p3', 1);
      await heartbeat(svc, 'T-p3');
      expect(progressRows('T-p3')).toHaveLength(1);

      // t0+121s：再新增 1 次工具活动，跨窗口 → 第二条（累计计数）
      now += 91_000;
      vi.setSystemTime(now);
      seedAuditRows('T-p3', 1);
      await heartbeat(svc, 'T-p3');
      const rows = progressRows('T-p3');
      expect(rows).toHaveLength(2);
      expect(rows[1]?.body).toBe(
        '【进度分段】子任务 T-p3 进行中 · 工具调用累计 5 次 · 文件变更累计 0 处',
      );

      // t0+300s：无新工具活动（审计计数不变）→ 即使跨窗口也不发
      now += 179_000;
      vi.setSystemTime(now);
      await heartbeat(svc, 'T-p3');
      expect(progressRows('T-p3')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('进度分段：节流状态清理', () => {
  it('settle 后链复用（followup 新轮）→ 节流状态已清，首条立即再发射', async () => {
    registerChain('T-p4');
    const svc = new RouterService({ runners: new Map() });

    // 首条发射（节流状态落位）
    seedAuditRows('T-p4', 3);
    await heartbeat(svc, 'T-p4');
    expect(progressRows('T-p4')).toHaveLength(1);

    // 终态（真实 routeEvent settle 路径）→ 清理
    await svc.routeEvent(
      {
        getType: () => 'io.momo-studio.task_reply',
        getContent: () => ({ task_id: 'T-p4', status: 'completed', body: '完成' }),
        getSender: () => 'agent-inst-sub',
        getRoomId: () => sessChatId,
      },
      'owner',
      null,
    );
    expect(dispatchRegistry.get('T-p4')?.status).toBe('done');

    // followup 复用链（register 重置在途态）→ 心跳（计数未变、时间未过窗口）
    // 若节流状态未清：lastToolCount=3 ≥ 3 → 抑制；已清 → 首条规则立即发射
    registerChain('T-p4');
    await heartbeat(svc, 'T-p4');
    expect(progressRows('T-p4')).toHaveLength(2);
  });

  it('cancelBySession 清理节流状态（取消链不泄漏 map 条目语义）', async () => {
    registerChain('T-p5');
    const svc = new RouterService({ runners: new Map() });
    seedAuditRows('T-p5', 2);
    await heartbeat(svc, 'T-p5');
    expect(progressRows('T-p5')).toHaveLength(1);

    dispatchRegistry.cancelBySession(sessChatId);
    expect(dispatchRegistry.get('T-p5')?.status).toBe('cancelled');

    // 复用 + 心跳（计数未变、时间未过窗口）→ 已清则立即发射
    registerChain('T-p5');
    await heartbeat(svc, 'T-p5');
    expect(progressRows('T-p5')).toHaveLength(2);
  });
});

describe('registry.progressGate 纯逻辑（注入时钟）', () => {
  it('未注册链 / 非在途链 → 恒 false；首条 ≥1 活动即放行；窗口与活动双闸', () => {
    let now = 1_700_000_000_000;
    const reg = new DispatchRegistry({ now: () => now });
    // 未注册链
    expect(reg.progressGate('T-ghost', 5)).toBe(false);

    reg.register({
      taskId: 'T-g1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: 'sess',
      isFollowupRound: false,
    });
    // 首条：零活动不放行；≥1 立即放行
    expect(reg.progressGate('T-g1', 0)).toBe(false);
    expect(reg.progressGate('T-g1', 2)).toBe(true);
    // 窗口内：有新活动也压制
    now += 30_000;
    expect(reg.progressGate('T-g1', 3)).toBe(false);
    // 跨窗口：无新活动压制
    now += PROGRESS_SEGMENT_INTERVAL_MS;
    expect(reg.progressGate('T-g1', 2)).toBe(false);
    // 跨窗口 + 新活动 → 放行
    expect(reg.progressGate('T-g1', 4)).toBe(true);
    // settle 后（非在途）→ 恒 false
    reg.settle('T-g1', 'completed', 'done', 4);
    now += PROGRESS_SEGMENT_INTERVAL_MS;
    expect(reg.progressGate('T-g1', 9)).toBe(false);
  });
});
