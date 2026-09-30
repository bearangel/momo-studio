// electron/tests/agent/tools/task-tools-groups.test.ts
//
// agent 任务工具分组信息同步回归锁（看板重构 spec §8「补信息不给能力」，Task 8）：
//   - create_task 带 groupId 落组；组不存在 / 跨 ws / 已归档 → Error 拒绝
//   - list_task_groups 新工具：返回活跃组 id/name/color（workspace 收窄）
//   - list_tasks 入参 groupId 过滤 + 结果附 groupName 注入
//   - read_task 返回体加 groupId/groupName
//
// fixture 照 task-tools.test.ts（tmp 目录 + runMigrations + 直插 workspace 行）
// 与 task-tools-delegation.test.ts（seedCtx 构造 ToolContext，走 TaskTools 类）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { insertTask } from '../../../src/main/storage/tasks/repo';
import { createGroup, archiveGroup } from '../../../src/main/storage/task-groups/repo';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const WS = 'ws1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-groups-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** 直插 workspace 行（task_groups / tasks 表有 FK 到 workspaces） */
const seedWorkspace = (id: string): void => {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', `/tmp/${id}`, 'owner');
};

/** 最小 ToolContext 桩——task 工具只消费 workspaceId / creatorUserId */
function seedCtx(wsId: string): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: wsId,
    workspaceDir: '/tmp/ws',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ss-1',
    roomId: 'room-x',
    sendStreamChunk: () => undefined,
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: 'owner',
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedWorkspace(WS);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('agent 任务工具分组同步（看板重构 Task 8）', () => {
  const tools = new TaskTools();

  it('create_task 带 groupId 落组', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v2.1' });
    const row = JSON.parse(
      await tools.execute('create_task', { title: 'x', groupId: g.id }, seedCtx(WS)),
    ) as { groupId: string | null };
    expect(row.groupId).toBe(g.id);
  });

  it('create_task 组不存在 → Error 拒绝', async () => {
    await expect(
      tools.execute('create_task', { title: 'y', groupId: 'G-999' }, seedCtx(WS)),
    ).rejects.toThrow('分组');
  });

  it('create_task 跨工作空间组拒绝（防跨 ws 落组）', async () => {
    seedWorkspace('ws2');
    const g = createGroup({ workspaceId: 'ws2', name: '别家的组' });
    await expect(
      tools.execute('create_task', { title: 'z', groupId: g.id }, seedCtx(WS)),
    ).rejects.toThrow('分组');
  });

  it('归档组不可作为 create_task 目标', async () => {
    const g = createGroup({ workspaceId: WS, name: '归档组' });
    archiveGroup(g.id);
    await expect(
      tools.execute('create_task', { title: 'a', groupId: g.id }, seedCtx(WS)),
    ).rejects.toThrow('归档');
  });

  it('list_task_groups 已注册且返回活跃组 id/name/color（归档组与跨 ws 组不出现）', async () => {
    expect(tools.getDefs().find((d) => d.name === 'list_task_groups')).toBeDefined();
    expect(tools.handles('list_task_groups')).toBe(true);

    const active = createGroup({ workspaceId: WS, name: 'v2.1', color: 'violet' });
    const archived = createGroup({ workspaceId: WS, name: '已归档' });
    archiveGroup(archived.id);
    seedWorkspace('ws2');
    createGroup({ workspaceId: 'ws2', name: '别家的组' });

    const result = JSON.parse(await tools.execute('list_task_groups', {}, seedCtx(WS))) as Array<{
      id: string;
      name: string;
      color: string | null;
    }>;
    expect(result).toEqual([{ id: active.id, name: 'v2.1', color: 'violet' }]);
  });

  it('list_tasks groupId 过滤 + groupName 注入（未分组任务 groupName 为 null）', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v2.1' });
    insertTask({ workspaceId: WS, title: 'in-group', creatorUserId: 'owner', groupId: g.id });
    insertTask({ workspaceId: WS, title: 'no-group', creatorUserId: 'owner' });

    const filtered = JSON.parse(
      await tools.execute('list_tasks', { groupId: g.id }, seedCtx(WS)),
    ) as Array<{ title: string; groupName: string | null }>;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.title).toBe('in-group');
    expect(filtered[0]!.groupName).toBe('v2.1');

    const all = JSON.parse(
      await tools.execute('list_tasks', {}, seedCtx(WS)),
    ) as Array<{ title: string; groupName: string | null }>;
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.title === 'no-group')!.groupName).toBeNull();
  });

  it('read_task 返回 groupId/groupName', async () => {
    const g = createGroup({ workspaceId: WS, name: 'v2.1' });
    const t = insertTask({ workspaceId: WS, title: 'T', creatorUserId: 'owner', groupId: g.id });
    const t2 = insertTask({ workspaceId: WS, title: 'T2', creatorUserId: 'owner' });

    const grouped = JSON.parse(
      await tools.execute('read_task', { taskId: t.id }, seedCtx(WS)),
    ) as { groupId: string | null; groupName: string | null };
    expect(grouped.groupId).toBe(g.id);
    expect(grouped.groupName).toBe('v2.1');

    const ungrouped = JSON.parse(
      await tools.execute('read_task', { taskId: t2.id }, seedCtx(WS)),
    ) as { groupId: string | null; groupName: string | null };
    expect(ungrouped.groupId).toBeNull();
    expect(ungrouped.groupName).toBeNull();
  });
});
