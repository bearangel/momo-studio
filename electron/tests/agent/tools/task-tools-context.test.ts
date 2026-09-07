// electron/tests/agent/tools/task-tools-context.test.ts
//
// create_task / list_tasks 上下文注入回归锁（Bug 1 修复）：
// 任务工具的 workspaceId/creatorUserId 是环境上下文字段，必须从 ToolContext 注入，
// 不允许 LLM 自由填——否则会 FK 违约（FOREIGN KEY constraint failed）。
//
// 复现形态：args 填不存在 workspaceId（'ws_default'）+ 不存在 creatorUserId（'user_pm'），
// 旧代码直接报 FK 错；新代码忽略 args 字段、用 ctx 注入的真实 workspaceId。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { getWorkspace } from '../../../src/main/workspace/crud';
import { listTasks } from '../../../src/main/storage/tasks/repo';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const REAL_OWNER_ID = '@real-owner:home';
// createWorkspace 用 randomUUID 生成 id，故真 id 在每个 it 内创建后捕获
let REAL_WORKSPACE_ID = '';

function seedCtx(wsId: string, owner = REAL_OWNER_ID): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: wsId,
    workspaceDir: '/tmp/ws',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ss-1',
    roomId: 'room-1',
    sendStreamChunk: () => undefined,
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: owner,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('create_task 上下文注入（Bug 1 FK 修复回归锁）', () => {
  const tools = new TaskTools();
  const def = tools.getDefs().find((d) => d.name === 'create_task');
  if (!def) throw new Error('create_task 工具定义不存在');

  it('schema：workspaceId / creatorUserId 已不再 required（LLM 不必填）', () => {
    expect(def.inputSchema.required).not.toContain('workspaceId');
    expect(def.inputSchema.required).not.toContain('creatorUserId');
  });

  it('LLM 胡填不存在的 workspaceId="ws_default" + creatorUserId="user_pm" → ctx 注入的真 workspaceId 生效，task 落库', async () => {
    // seed 真实 workspace（uuid 格式，非 'ws_default'）
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      {
        name: 'T',
        directoryPath: '/tmp/ws-task-tools',
        description: '',
        iconEmoji: '📁',
      },
      REAL_OWNER_ID,
    );
    REAL_WORKSPACE_ID = ws.id;
    const ctx = seedCtx(REAL_WORKSPACE_ID);
    const result = JSON.parse(
      await tools.execute(
        'create_task',
        {
          // LLM 幻觉填的：FK 必然违约
          workspaceId: 'ws_default',
          creatorUserId: 'user_pm',
          title: '最小测试',
        },
        ctx,
      ),
    );
    expect(result.id).toMatch(/^T-\d+$/);
    expect(result.workspaceId).toBe(REAL_WORKSPACE_ID); // ctx 注入值生效
    expect(result.creatorUserId).toBe(REAL_OWNER_ID); // ctx 注入值生效
    expect(result.status).toBe('draft');
    // 反查 DB：行确实存在
    expect(getWorkspace(REAL_WORKSPACE_ID)).not.toBeNull();
  });

  it('ctx 注入的 workspaceId 必须存在于 workspaces 表（不存在时 FK 错抛透传给 LLM）', async () => {
    const ctx = seedCtx('00000000-0000-4000-8000-000000000099'); // 不存在
    await expect(
      tools.execute('create_task', { title: 'X' }, ctx),
    ).rejects.toThrow();
  });
});

describe('list_tasks 上下文默认收窄（Bug 1 修复回归锁）', () => {
  const tools = new TaskTools();
  const def = tools.getDefs().find((d) => d.name === 'list_tasks');
  if (!def) throw new Error('list_tasks 工具定义不存在');

  it('ctx 注入 workspaceId 时，list_tasks 默认收窄到当前工作空间（LLM 漏填不漏数据）', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const ws = await createWorkspace(
      { name: 'Ws1', directoryPath: '/tmp/ws1', description: '', iconEmoji: '📁' },
      REAL_OWNER_ID,
    );
    REAL_WORKSPACE_ID = ws.id;
    const { insertTask } = await import('../../../src/main/storage/tasks/repo');
    insertTask({ workspaceId: REAL_WORKSPACE_ID, title: '任务1', creatorUserId: REAL_OWNER_ID });
    const ctx = seedCtx(REAL_WORKSPACE_ID);
    // LLM 不传 workspaceId——应自动用 ctx 注入值
    const result = JSON.parse(await tools.execute('list_tasks', {}, ctx));
    expect(result).toHaveLength(1);
    expect(result[0].workspaceId).toBe(REAL_WORKSPACE_ID);
  });

  it('LLM 填别的 workspaceId → 仍以 ctx 注入为准（防跨 ws 信息泄漏）', async () => {
    const { createWorkspace } = await import('../../../src/main/workspace/crud');
    const wsA = await createWorkspace(
      { name: 'WsA', directoryPath: '/tmp/wsA', description: '', iconEmoji: '📁' },
      REAL_OWNER_ID,
    );
    const wsB = await createWorkspace(
      { name: 'WsB', directoryPath: '/tmp/wsB', description: '', iconEmoji: '📁' },
      REAL_OWNER_ID,
    );
    REAL_WORKSPACE_ID = wsA.id;
    const { insertTask } = await import('../../../src/main/storage/tasks/repo');
    insertTask({ workspaceId: wsA.id, title: '当前 ws', creatorUserId: REAL_OWNER_ID });
    insertTask({ workspaceId: wsB.id, title: '别的 ws', creatorUserId: REAL_OWNER_ID });
    const ctx = seedCtx(wsA.id);
    const result = JSON.parse(
      await tools.execute('list_tasks', { workspaceId: 'leak-target' }, ctx),
    );
    expect(result.every((t: { workspaceId: string }) => t.workspaceId === wsA.id)).toBe(true);
  });
});