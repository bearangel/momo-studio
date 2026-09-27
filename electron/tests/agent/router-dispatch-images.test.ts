// electron/tests/agent/router-dispatch-images.test.ts
//
// 多模态 dispatch 自动附图（Task 9 D3，spec 2026-09-26-image-input-multimodal §8）：
// routeDispatch 构造子 task-config 时合并会话近 2 轮 images，按目标 agent 的
// vision 能力过滤——vision 目标附 base64（≤6 张），非 vision 目标 images: []
// （droppedImages 不伪造）；读取失败 / 窗口无图不阻塞派发。
//
// 保真度（momo-test-rules）：
//   - 仅 vi.mock spawn-helpers.resolveVisionCapability（三级解析已有专项锁）；
//     路由、sender 反查、窗口读图、expander 全走真实实现
//   - 真实 workspace 目录 + 真实图片文件（不 mock fs）
//   - 身份 fixture 对齐 router-service.test.ts（B2：dispatch_from 反查一致）
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
import { insertMessage } from '../../src/main/storage/messages/repo';
import { RouterService } from '../../src/main/agent/router-service';
import { __resetDispatchRegistryForTest } from '../../src/main/agent/dispatch-registry';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

const SESSION_ID = '!room:img';
const tmpRoot = path.join(os.tmpdir(), `ap-router-img-${Date.now()}`);
let wsDir: string;

beforeAll(() => {
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-dispatch-img-'));
});

afterAll(() => {
  fs.rmSync(wsDir, { recursive: true, force: true });
});

function mkRunner() {
  return {
    executeTask: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockReturnValue(true),
    abortStream: vi.fn(),
    notifyTaskReply: vi.fn(),
  };
}

function mkDispatchEvent(from: string, to: string, taskId: string) {
  return {
    getType: () => 'io.momo-studio.dispatch',
    getContent: () => ({ body: '分析这张图', task_id: taskId, dispatch_from: from, dispatch_to: to }),
    getSender: () => (from === 'inst-pm' ? '@pm:home' : '@sub:home'),
    getRoomId: () => SESSION_ID,
    getId: () => `$evt-${taskId}`,
    getTs: () => Date.now(),
    isRedacted: () => false,
  } as never;
}

describe('routeDispatch 多模态附图（近 2 轮窗口 + 目标 vision 过滤）', () => {
  beforeEach(() => {
    resolveVisionCapabilityMock.mockClear();
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', ?, '@o')`,
    ).run(wsDir);
    // def-pm（非视觉）/ def-seer（视觉 glm-4.6v）/ def-plain（非视觉）
    for (const [defId, model] of [
      ['def-pm', 'pm-model'],
      ['def-seer', 'glm-4.6v'],
      ['def-plain', 'plain-model'],
    ] as const) {
      db.prepare(
        `INSERT INTO agent_definitions
           (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
            default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
         VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', ?, 1)`,
      ).run(defId, defId, defId, model);
    }
    for (const [instId, defId, userId] of [
      ['inst-pm', 'def-pm', '@pm:home'],
      ['inst-seer', 'def-seer', '@seer:home'],
      ['inst-plain', 'def-plain', '@plain:home'],
    ] as const) {
      db.prepare(
        `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
         VALUES (?, 'ws', ?, ?)`,
      ).run(instId, defId, userId);
    }
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at)
       VALUES (?, 'ws', 'T', 0, 'chat', NULL, ?, ?)`,
    ).run(SESSION_ID, Date.now(), Date.now());
    __resetDispatchRegistryForTest();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  /** 带 images context_json 的 owner 行 + 对应磁盘文件 */
  function seedOwnerTurn(body: string, ts: number, imageNames: string[]): void {
    for (const name of imageNames) {
      fs.writeFileSync(path.join(wsDir, name), Buffer.from(name));
    }
    const row = insertMessage({
      sessionId: SESSION_ID,
      sender: 'owner',
      eventType: 'm.room.message',
      body,
      workspaceId: 'ws',
      contextJson: JSON.stringify({
        skills: [],
        files: [],
        images: imageNames.map((p) => ({ path: p, w: 100, h: 80 })),
      }),
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(ts, row.id);
  }

  it('vision 目标：近 2 轮 images 以 base64 合入 task.context.images', async () => {
    const T0 = Date.now();
    seedOwnerTurn('第一轮', T0 + 100, ['a.png']);
    seedOwnerTurn('第二轮', T0 + 200, ['b.png']);
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as unknown as AgentRunner]]) });

    await svc.routeEvent(mkDispatchEvent('inst-pm', 'inst-seer', 'task-img-1'), '@pm:home', SESSION_ID, 'inst-seer');

    expect(runner.executeTask).toHaveBeenCalledTimes(1);
    const task = runner.executeTask.mock.calls[0]![0] as {
      context?: { skills: unknown[]; files: unknown[]; images: Array<{ path: string; base64: string }>; droppedImages: string[] };
    };
    expect(task.context).toBeDefined();
    expect(task.context!.skills).toEqual([]);
    expect(task.context!.files).toEqual([]);
    expect(task.context!.images.map((i) => i.path)).toEqual(['a.png', 'b.png']);
    expect(task.context!.images[0]!.base64).toBe(Buffer.from('a.png').toString('base64'));
    expect(task.context!.droppedImages).toEqual([]);
  });

  it('非 vision 目标：context.images = []（不传 base64，droppedImages 不伪造）', async () => {
    const T0 = Date.now();
    seedOwnerTurn('第一轮', T0 + 100, ['a.png']);
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-plain', runner as unknown as AgentRunner]]) });

    await svc.routeEvent(mkDispatchEvent('inst-pm', 'inst-plain', 'task-img-2'), '@pm:home', SESSION_ID, 'inst-plain');

    const task = runner.executeTask.mock.calls[0]![0] as {
      context?: { images: unknown[]; droppedImages: string[] };
    };
    expect(task.context).toBeDefined();
    expect(task.context!.images).toEqual([]);
    expect(task.context!.droppedImages).toEqual([]);
    // 目标 vision 解析确实发生（过滤依据可追溯）
    expect(resolveVisionCapabilityMock).toHaveBeenCalledWith('prov-1', 'plain-model');
  });

  it('窗口边界：第 3 轮图片不进 dispatch 载荷', async () => {
    const T0 = Date.now();
    seedOwnerTurn('第一轮', T0 + 100, ['old.png']);
    seedOwnerTurn('第二轮', T0 + 200, ['mid.png']);
    seedOwnerTurn('第三轮', T0 + 300, ['new.png']);
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as unknown as AgentRunner]]) });

    await svc.routeEvent(mkDispatchEvent('inst-pm', 'inst-seer', 'task-img-3'), '@pm:home', SESSION_ID, 'inst-seer');

    const task = runner.executeTask.mock.calls[0]![0] as { context?: { images: string[] } };
    expect(task.context!.images).toHaveLength(2);
  });

  it('会话无图 → task.context 缺省（dispatch 载荷零变化）', async () => {
    const row = insertMessage({
      sessionId: SESSION_ID, sender: 'owner', eventType: 'm.room.message', body: '纯文本', workspaceId: 'ws',
    });
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now(), row.id);
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as unknown as AgentRunner]]) });

    await svc.routeEvent(mkDispatchEvent('inst-pm', 'inst-seer', 'task-img-4'), '@pm:home', SESSION_ID, 'inst-seer');

    const task = runner.executeTask.mock.calls[0]![0] as { context?: unknown };
    expect(task.context).toBeUndefined();
  });

  it('图片文件被删（读取失败）→ 该图剔除，dispatch 照常派发', async () => {
    const T0 = Date.now();
    seedOwnerTurn('第一轮', T0 + 100, ['gone.png']);
    fs.rmSync(path.join(wsDir, 'gone.png'));
    seedOwnerTurn('第二轮', T0 + 200, ['ok.png']);
    const runner = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-seer', runner as unknown as AgentRunner]]) });

    await svc.routeEvent(mkDispatchEvent('inst-pm', 'inst-seer', 'task-img-5'), '@pm:home', SESSION_ID, 'inst-seer');

    expect(runner.executeTask).toHaveBeenCalledTimes(1);
    const task = runner.executeTask.mock.calls[0]![0] as {
      context?: { images: Array<{ path: string }> };
    };
    expect(task.context!.images.map((i) => i.path)).toEqual(['ok.png']);
  });
});
