// electron/tests/task/runtime-init-quota.test.ts
//
// 配额受限自动续跑（2026-11-04 生产事故）：executor 放行 → kickoff 注入的分流契约。
// 到点的配额续跑行（routing_json 带 quotaRetryCount 标记）不走通用 kickoff
// （sendUserMessage → ephemeral 回合无 task-driven 生命周期，错误无人收尾），
// 改走 resumeTask 的 task-driven 断点续跑——同任务同会话，task-end 统一收尾。
// 两边界模块（resume / session-service）mock 收窄（momo-test-rules 第 5 条），
// executor / startTask / DB 走真实实现。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/task/resume', () => ({
  resumeTask: vi.fn().mockResolvedValue({ streamSessionId: '' }),
}));
vi.mock('../../src/main/im/session-service', () => ({
  sendUserMessage: vi.fn().mockResolvedValue({ readOnly: false }),
  broadcastSessionListChanged: vi.fn(),
}));

import { resumeTask } from '../../src/main/task/resume';
import { sendUserMessage } from '../../src/main/im/session-service';
import { initTaskRuntime, stopTaskRuntime } from '../../src/main/task/runtime-init';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-quota-kickoff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const MARKER_TASK = 'q-kick-001';
const PLAIN_TASK = 'T-500';
let sessionId = '';

function setupDb(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', ?, '@o')`,
  ).run(tmpRoot);
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES ('inst-sub', 'sub', 'sub', '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('inst-sub', 'ws', 'inst-sub', 'agent-sub')`,
  ).run();
  sessionId = insertSession({ workspaceId: 'ws', title: '协作', kind: 'chat' }).id;
}

/** 已到点的 assigned 任务行（executor 放行候选） */
function seedAssignedTask(id: string, routingJson: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, creator_user_id, status, origin,
         source_session_id, assignee_agent_id, scheduled_at, routing_json, created_at, updated_at)
       VALUES (?, 'ws', ?, '@o', 'assigned', ?, ?, 'inst-sub', ?, ?, ?, ?)`,
    )
    .run(id, `任务 ${id}`, id === MARKER_TASK ? 'dispatch' : 'user', sessionId, Date.now() - 1000, routingJson, Date.now(), Date.now());
}

/** 等 executor 的 100ms 去抖 notify + admitOnce 异步链跑完 */
async function settleAdmission(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDb();
});

afterEach(() => {
  stopTaskRuntime();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('runtime-init kickoff 分流：配额续跑行走 resumeTask（task-driven 收尾）', () => {
  it('标记行（quotaRetryCount）到点放行 → resumeTask(taskId)，不走 sendUserMessage', async () => {
    seedAssignedTask(MARKER_TASK, JSON.stringify({ quotaRetryCount: 1 }));
    initTaskRuntime();
    await settleAdmission();

    expect(resumeTask).toHaveBeenCalledWith(MARKER_TASK);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getTask(MARKER_TASK)!.status, 'startTask 已放行转 in_progress（resumeTask 接管执行）').toBe('in_progress');
  });

  it('普通任务（无标记）→ 走通用 kickoff（sendUserMessage），不触 resumeTask', async () => {
    seedAssignedTask(PLAIN_TASK, null);
    initTaskRuntime();
    await settleAdmission();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(resumeTask).not.toHaveBeenCalled();
  });
});
