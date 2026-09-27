// electron/tests/agent/router-vision-hint.test.ts
//
// 多模态团队路由提示（Task 8，spec 2026-09-26-image-input-multimodal §8 场景 2）：
// routeUserChat 构造 TaskConfig.visionHint 的门控矩阵。
//   - 团队协作会话（有效成员 > 1）+ 接待者模型非 vision + 消息带图 + 存在其它
//     vision 成员 → visionHint.members 附上可视觉成员（name = agentName、
//     model = def.model_name）
//   - 快速/单 agent 会话、接待者可视觉、无 vision 成员、无图 → 一律不附
//
// 保真度约定（momo-test-rules）：
//   - Mock 收窄：仅 vi.mock spawn-helpers.resolveVisionCapability（三级优先级解析
//     已有 spawn-helpers-vision.test.ts 专项锁，本文件只测 hint 构造门控）；
//     路由判定、成员 JOIN 查询、expander 全走真实实现
//   - expander deps 清空（router-context.test.ts 同款）——context 展开走降级路径，
//     断言不依赖文件系统
//   - 车道（session-lane）模块级内存态：beforeEach 清空防跨用例污染
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { resolveVisionCapabilityMock } = vi.hoisted(() => ({
  resolveVisionCapabilityMock: vi.fn((_providerId: string, modelId: string): boolean =>
    modelId === 'glm-4.6v',
  ),
}));

vi.mock('../../src/main/agent/spawn-helpers', () => ({
  resolveVisionCapability: resolveVisionCapabilityMock,
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { setExpanderDeps } from '../../src/main/im/context-expander';
import { __clearLaneForTest } from '../../src/main/agent/session-lane';
import { RouterService } from '../../src/main/agent/router-service';

function mkRunner() {
  return {
    executeTask: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockReturnValue(true),
    abortStream: vi.fn(),
    notifyTaskReply: vi.fn(),
  };
}

beforeAll(() => {
  setExpanderDeps({ skillRoots: [], workspaceDir: () => null });
});

afterAll(() => {
  setExpanderDeps({});
});

const tmpRoot = path.join(os.tmpdir(), `ap-router-vision-${Date.now()}`);

describe('routeUserChat visionHint 构造（多模态团队路由）', () => {
  /** 会话 id 夹具（每个用例独立 seed，防车道/DB 跨用例污染） */
  let teamSess = '';
  let quickSess = '';
  let receiverVisionSess = '';
  let noVisionMemberSess = '';
  const ghostSess = 'sess-not-exist';

  beforeEach(() => {
    __clearLaneForTest();
    resolveVisionCapabilityMock.mockClear();
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
    ).run();
    // def-pm（队长，非视觉模型）/ def-seer（千里眼，视觉模型）
    for (const [defId, name, model] of [
      ['def-pm', '队长', 'pm-model'],
      ['def-seer', '千里眼', 'glm-4.6v'],
      ['def-plain', '老实人', 'plain-model'],
    ] as const) {
      db.prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
            default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
         VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', ?, 1)`,
      ).run(defId, name, name, model);
    }
    for (const [instId, defId] of [
      ['inst-pm', 'def-pm'],
      ['inst-seer', 'def-seer'],
      ['inst-plain', 'def-plain'],
    ] as const) {
      db.prepare(
        `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
         VALUES (?, 'ws', ?, ?)`,
      ).run(instId, defId, `agent-${instId}`);
    }
    const mk = (members: Array<[string, boolean]>): string => {
      const s = insertSession({ workspaceId: 'ws', title: 't' });
      for (const [instId, isLeader] of members) addSessionMember(s.id, instId, isLeader);
      return s.id;
    };
    // 团队会话：pm（leader）+ seer + plain（3 成员，接待者 inst-pm 非视觉）
    teamSess = mk([['inst-pm', true], ['inst-seer', false], ['inst-plain', false]]);
    // 快速会话：唯 pm 一人（即便带图也不附 hint）
    quickSess = mk([['inst-pm', true]]);
    // 团队但接待者本人可视觉
    receiverVisionSess = mk([['inst-seer', true], ['inst-plain', false]]);
    // 团队但无任何 vision 成员
    noVisionMemberSess = mk([['inst-pm', true], ['inst-plain', false]]);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  /** 带 1 图的 MessageContext（expander deps 已清空 → 展开降级，不影响 hint 门控） */
  const ctxWithImage = { skills: [], files: [], images: [{ path: 'shot.png', w: 10, h: 10 }] };

  it('带图消息 → TaskConfig 附每消息现解析 vision（接待者能力，与 hint 独立）；无图不附', async () => {
    // inst-seer 的 def 挂 glm-4.6v（resolveVisionCapability mock 认其为 true）
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: teamSess,
      assignmentId: 'inst-seer',
      body: '看图',
      context: ctxWithImage,
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.vision).toBe(true);

    // 无图消息：零查询开销，不附字段（用无车道残留的 receiverVisionSess——
    // 上一子调用已给 teamSess 注册 steer 车道，同会话再发会被 steer 分流）
    const runner2 = mkRunner();
    const svc2 = new RouterService({ runners: new Map([['inst-seer', runner2 as never]]) } as never);
    await svc2.routeUserChat({
      sessionId: receiverVisionSess,
      assignmentId: 'inst-seer',
      body: '纯文本',
      context: { skills: [], files: [], images: [] },
    });
    const task2 = runner2.executeTask.mock.calls[0]![0];
    expect('vision' in task2).toBe(false);
  });

  it('团队会话 + 非视觉接待者 + 带图 + 存在 vision 成员 → TaskConfig 附 visionHint（仅可视觉成员）', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: teamSess,
      assignmentId: 'inst-pm',
      body: '看图',
      context: ctxWithImage,
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toEqual({
      members: [{ name: '千里眼', model: 'glm-4.6v' }],
    });
  });

  it('快速会话（单成员）→ 即便带图也不附 visionHint', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: quickSess,
      assignmentId: 'inst-pm',
      body: '看图',
      context: ctxWithImage,
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toBeUndefined();
  });

  it('接待者本人可视觉 → 不附 visionHint', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: receiverVisionSess,
      assignmentId: 'inst-seer',
      body: '看图',
      context: ctxWithImage,
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toBeUndefined();
  });

  it('团队会话但无任何 vision 成员 → 不附 visionHint', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: noVisionMemberSess,
      assignmentId: 'inst-pm',
      body: '看图',
      context: ctxWithImage,
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toBeUndefined();
  });

  it('消息不带图 → 不附 visionHint 且不触成员解析（零额外 DB 开销）', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: teamSess,
      assignmentId: 'inst-pm',
      body: '纯文本',
      context: { skills: [], files: [], images: [] },
    });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toBeUndefined();
    expect(resolveVisionCapabilityMock).not.toHaveBeenCalled();
  });

  it('会话不存在（含 DB 查询空结果）→ 降级不附 hint，不阻塞派发', async () => {
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner as never]]) } as never);
    await svc.routeUserChat({
      sessionId: ghostSess,
      assignmentId: 'inst-pm',
      body: '看图',
      context: ctxWithImage,
    });
    expect(runner.executeTask).toHaveBeenCalledTimes(1);
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.visionHint).toBeUndefined();
  });
});
