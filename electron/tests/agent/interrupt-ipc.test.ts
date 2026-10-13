// electron/tests/agent/interrupt-ipc.test.ts
//
// 三级中断四通道 IPC 契约测试（P0-B Task B2，spec 2026-10-13 §7.2）：
//   agent:abortTurn / session:stopAll / dispatch:cancelChain / dispatch:listInFlight
//
// mock 收窄纪律（momo-test-rules 规则 5）：只 mock 进程边界——ipcMain.handle
// Map 捕获（照抄 tests/journal/ipc.handlers.test.ts 形态）+ logger 打桩；
// 被测模块 interrupt-ipc.ts 本体真实执行。deps 全为 vi.fn 桩——RouterService
// 级联本体由 tests/agent/interrupt-cascade-e2e.test.ts 锁定，此处只锁 IPC 边界：
//   1. 四通道注册名精确（不多不少）
//   2. 载荷校验抛错路径：缺 sessionId / 空串 / 非法类型 / cancelChain 双键全缺
//      ——且非法载荷不触达 deps（错误不外溢成级联动作）
//   3. 合法载荷 deps 透传（参数形状 + 返回值回传）
//
// P2-D Task D1（spec 2026-10-13 §9）：追加「数据面」describe——真 registry +
// 真 SQLite（interrupt-cascade-e2e 同款 harness：AP_USER_DATA_DIR 临时库 +
// runMigrations + 直 SQL 种子），deps 注入真实现 listInFlightViews，经捕获
// handler 全链断言：
//   - subAgentName 名解析：subAssignmentId（= workspace_agent_members.instance_id）
//     → listMembers(ws) JOIN agent_definitions 的 agentName（与 session-tools
//     buildNameMaps 同源——listMembers 是唯一名映射数据源，不造第二套映射）
//   - 成员已删 / DB 异常 → subAgentName null（降级不抛错，UI 降级短 taskId 由 D2）
//   - 只返 in_flight；sessionId 过滤；可选流 id 键的缺省不出现（契约形状）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock 会被提升到所有 import 之前；被工厂引用的 mock 必须用 vi.hoisted 提前声明。
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerInterruptIpc } from '../../src/main/agent/interrupt-ipc';
import { listInFlightViews } from '../../src/main/agent/inflight-view';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import type { InFlightChainView } from '../../../renderer/src/ipc/types';

/** 构造四方法 vi.fn 桩（返回值可区分，验证回传链路） */
function mkDeps() {
  return {
    abortTurn: vi.fn(
      (sessionId: string): { stoppedStream: boolean } => ({
        stoppedStream: sessionId === 'sess-1',
      }),
    ),
    stopAll: vi.fn(
      (_sessionId: string): { stoppedStreams: number; cancelledChains: number } => ({
        stoppedStreams: 2,
        cancelledChains: 3,
      }),
    ),
    cancelChain: vi.fn(
      (_arg: { taskId?: string; subStreamSessionId?: string }): { status: string } => ({
        status: 'cancelled',
      }),
    ),
    listInFlight: vi.fn(
      (_sessionId?: string): InFlightChainView[] => [
        {
          taskId: 't-1',
          round: 1,
          sessionId: 'sess-1',
          pmAssignmentId: 'pm-1',
          subAssignmentId: 'sub-1',
          subAgentName: null,
          startedAt: 1,
        },
      ],
    ),
  };
}

/** 注册后取回指定通道的 handler（省略样板） */
function handler(channel: string): (...args: unknown[]) => unknown {
  const h = ipcHandlers.get(channel);
  if (!h) throw new Error(`通道 ${channel} 未注册`);
  return h;
}

describe('registerInterruptIpc 契约（spec §7.2 四通道）', () => {
  beforeEach(() => {
    ipcHandlers.clear();
  });

  it('四通道注册名精确——不多不少', () => {
    registerInterruptIpc(mkDeps());
    expect([...ipcHandlers.keys()].sort()).toEqual(
      ['agent:abortTurn', 'dispatch:cancelChain', 'dispatch:listInFlight', 'session:stopAll'].sort(),
    );
  });

  describe('agent:abortTurn', () => {
    it('合法载荷：sessionId 解包透传 deps，返回值回传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('agent:abortTurn')(undefined, { sessionId: 'sess-1' })).toEqual({
        stoppedStream: true,
      });
      expect(deps.abortTurn).toHaveBeenCalledTimes(1);
      expect(deps.abortTurn).toHaveBeenCalledWith('sess-1');
    });

    it('缺 sessionId 抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('agent:abortTurn')(undefined, {})).toThrow('sessionId 非法');
      expect(deps.abortTurn).not.toHaveBeenCalled();
    });

    it('空串 / 非字符串 sessionId 抛错', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('agent:abortTurn')(undefined, { sessionId: '' })).toThrow(
        'sessionId 非法',
      );
      expect(() => handler('agent:abortTurn')(undefined, { sessionId: 42 })).toThrow(
        'sessionId 非法',
      );
      expect(deps.abortTurn).not.toHaveBeenCalled();
    });
  });

  describe('session:stopAll', () => {
    it('合法载荷：透传 + 返回值回传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('session:stopAll')(undefined, { sessionId: 'sess-1' })).toEqual({
        stoppedStreams: 2,
        cancelledChains: 3,
      });
      expect(deps.stopAll).toHaveBeenCalledWith('sess-1');
    });

    it('缺 sessionId 抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('session:stopAll')(undefined, {})).toThrow('sessionId 非法');
      expect(deps.stopAll).not.toHaveBeenCalled();
    });
  });

  describe('dispatch:cancelChain', () => {
    it('taskId 单键：deps 收到仅含 taskId 的对象', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 't-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ taskId: 't-1' });
    });

    it('subStreamSessionId 单键：仅含该键（renderer chip 的查找键，spec §7.6）', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('dispatch:cancelChain')(undefined, { subStreamSessionId: 'ssi-1' })).toEqual({
        status: 'cancelled',
      });
      expect(deps.cancelChain).toHaveBeenCalledWith({ subStreamSessionId: 'ssi-1' });
    });

    it('双键齐全：两键均透传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 't-1', subStreamSessionId: 'ssi-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ taskId: 't-1', subStreamSessionId: 'ssi-1' });
    });

    it('双键全缺抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('dispatch:cancelChain')(undefined, {})).toThrow(
        'taskId 与 subStreamSessionId 至少一项',
      );
      expect(deps.cancelChain).not.toHaveBeenCalled();
    });

    it('非字符串键不混入透传对象', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 42, subStreamSessionId: 'ssi-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ subStreamSessionId: 'ssi-1' });
    });
  });

  describe('dispatch:listInFlight', () => {
    it('无载荷（undefined）：deps 收到 undefined（全量查询），完整视图回传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('dispatch:listInFlight')(undefined, undefined)).toEqual([
        {
          taskId: 't-1',
          round: 1,
          sessionId: 'sess-1',
          pmAssignmentId: 'pm-1',
          subAssignmentId: 'sub-1',
          subAgentName: null,
          startedAt: 1,
        },
      ]);
      expect(deps.listInFlight).toHaveBeenCalledWith(undefined);
    });

    it('空对象载荷：同样落到全量查询', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:listInFlight')(undefined, {});
      expect(deps.listInFlight).toHaveBeenCalledWith(undefined);
    });

    it('合法 sessionId 透传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:listInFlight')(undefined, { sessionId: 'sess-1' });
      expect(deps.listInFlight).toHaveBeenCalledWith('sess-1');
    });

    it('非法 sessionId 类型抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('dispatch:listInFlight')(undefined, { sessionId: 42 })).toThrow(
        'sessionId 非法',
      );
      expect(deps.listInFlight).not.toHaveBeenCalled();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 数据面（P2-D Task D1，spec 2026-10-13 §9）：listInFlightViews 真实现
// ══════════════════════════════════════════════════════════════════════════
describe('dispatch:listInFlight 数据面（真 registry + 真 SQLite）', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `ap-inflight-d1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  let sessId = '';

  /** 种子 agent 定义 + workspace 成员行（cascade-e2e seedAgentInstance 同款） */
  function seedAgentInstance(instanceId: string, defName: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(instanceId, defName, instanceId);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws-d1', ?, ?)`,
    ).run(instanceId, instanceId, `agent-${instanceId}`);
  }

  /** 经生产入口 register 种子在途链（不直改 registry 内部状态） */
  function seedChain(
    taskId: string,
    subInstanceId: string,
    opts?: { sessionId?: string; subStreamSessionId?: string; pmStreamSessionId?: string },
  ): void {
    dispatchRegistry.register({
      taskId,
      pmAssignmentId: 'inst-pm-d1',
      subAssignmentId: subInstanceId,
      sessionId: opts?.sessionId ?? sessId,
      ...(opts?.subStreamSessionId !== undefined ? { subStreamSessionId: opts.subStreamSessionId } : {}),
      ...(opts?.pmStreamSessionId !== undefined ? { pmStreamSessionId: opts.pmStreamSessionId } : {}),
      isFollowupRound: false,
    });
  }

  /** 通道注入真实现后的 dispatch:listInFlight handler（全链：解包 → listInFlightViews → registry+DB） */
  function realListInFlightHandler(): (...args: unknown[]) => unknown {
    registerInterruptIpc({
      abortTurn: () => ({ stoppedStream: false }),
      stopAll: () => ({ stoppedStreams: 0, cancelledChains: 0 }),
      cancelChain: () => ({ status: 'not_found' }),
      listInFlight: listInFlightViews,
    });
    return handler('dispatch:listInFlight');
  }

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-d1', 'T', '/tmp', '@o')`)
      .run();
    seedAgentInstance('inst-pm-d1', '项目经理');
    seedAgentInstance('inst-researcher-d1', '研究员');
    sessId = insertSession({ workspaceId: 'ws-d1', title: 'd1' }).id;
    __resetDispatchRegistryForTest();
    ipcHandlers.clear();
  });

  afterEach(() => {
    __resetDispatchRegistryForTest();
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('名解析命中：subAssignmentId 反查成员 → agentName；双流 id 键透传（契约形状）', () => {
    seedChain('task-a', 'inst-researcher-d1', { subStreamSessionId: 'ssi-a', pmStreamSessionId: 'pmssi-a' });
    const views = realListInFlightHandler()(undefined, undefined) as InFlightChainView[];
    expect(views).toEqual([
      {
        taskId: 'task-a',
        round: 1,
        sessionId: sessId,
        pmAssignmentId: 'inst-pm-d1',
        subAssignmentId: 'inst-researcher-d1',
        subStreamSessionId: 'ssi-a',
        pmStreamSessionId: 'pmssi-a',
        startedAt: expect.any(Number),
        subAgentName: '研究员',
      },
    ]);
  });

  it('成员已删 → subAgentName null（视图仍返回，不抛错——UI 降级短 taskId 由 D2 处理）', () => {
    seedChain('task-b', 'inst-researcher-d1');
    getDb().prepare(`DELETE FROM workspace_agent_members WHERE instance_id = 'inst-researcher-d1'`).run();
    const views = realListInFlightHandler()(undefined, {}) as InFlightChainView[];
    expect(views).toHaveLength(1);
    expect(views[0]!.taskId).toBe('task-b');
    expect(views[0]!.subAgentName).toBeNull();
  });

  it('只返 in_flight：done 链被过滤；未种流 id 的链视图不含可选键', () => {
    seedChain('task-live', 'inst-researcher-d1');
    seedChain('task-done', 'inst-researcher-d1');
    dispatchRegistry.settle('task-done', 'completed', 'ok');
    const views = realListInFlightHandler()(undefined, undefined) as InFlightChainView[];
    expect(views.map((v) => v.taskId)).toEqual(['task-live']);
    expect('subStreamSessionId' in views[0]!).toBe(false);
    expect('pmStreamSessionId' in views[0]!).toBe(false);
  });

  it('sessionId 过滤生效（只返该会话的在途链）', () => {
    const other = insertSession({ workspaceId: 'ws-d1', title: 'other' });
    seedChain('task-x', 'inst-researcher-d1', { sessionId: sessId });
    seedChain('task-y', 'inst-researcher-d1', { sessionId: other.id });
    const views = realListInFlightHandler()(undefined, { sessionId: other.id }) as InFlightChainView[];
    expect(views.map((v) => v.taskId)).toEqual(['task-y']);
  });

  it('DB 异常降级：成员表不可读 → 视图仍返回、subAgentName null（面板不白屏）', () => {
    seedChain('task-c', 'inst-researcher-d1', { subStreamSessionId: 'ssi-c' });
    getDb().prepare('DROP TABLE workspace_agent_members').run();
    const views = realListInFlightHandler()(undefined, undefined) as InFlightChainView[];
    expect(views).toHaveLength(1);
    expect(views[0]!.subAgentName).toBeNull();
    expect(views[0]!.subStreamSessionId).toBe('ssi-c');
  });
});
