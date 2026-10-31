// M5.3 委派建会端口真 DB 回归锁——wireDelegationRunnerPorts 的 createDelegatedSession
// 多成员/单成员两形态 + resolveAgentInstanceByNameProduct 按名解析。
// 与 delegation-ports.test 的差别：session-ops 不 mock（建会 SQL 形状是本文件的
// 被测面——session_members 行、is_leader 快照位、kind 落值）；仍只 mock 进程边界
// （electron / session-service / router-bootstrap / logger）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/im/session-service', () => ({
  sendUserMessage: vi.fn(async () => undefined),
  broadcastSessionListChanged: vi.fn(),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: vi.fn(() => null),
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { addMember, saveAgentDefinition } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';
import { wireDelegationRunnerPorts, resolveAgentInstanceByNameProduct } from '../../src/main/hub/delegation-ports';
import { broadcastSessionListChanged } from '../../src/main/im/session-service';

let tmpRoot = '';
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-delegation-session-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
});

function makeDef(name: string): AgentDefinition {
  return {
    id: `def-${name}`,
    name,
    slug: name.toLowerCase(),
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: `你是 ${name}`,
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  };
}

async function seedWorkspace(name: string, agentNames: string[]): Promise<string> {
  const ws = await createWorkspace(
    { name, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner',
  );
  for (const n of agentNames) {
    saveAgentDefinition(makeDef(n));
    await addMember(ws.id, `def-${n}`, `@${n}:localhost`);
  }
  return ws.id;
}

function ports() {
  return wireDelegationRunnerPorts({
    clientGetter: () => null,
    selfNodeId: () => null,
    settings: () => ({ acceptTasks: true, maxConcurrent: 2, hitlTimeoutMinutes: 15 }),
  });
}

interface SessionMemberRow {
  instance_id: string;
  is_leader: number;
}

function sessionMembers(sessionId: string): SessionMemberRow[] {
  return getDb()
    .prepare('SELECT instance_id, is_leader FROM session_members WHERE session_id = ? ORDER BY rowid ASC')
    .all(sessionId) as SessionMemberRow[];
}

function sessionKind(sessionId: string): string {
  const row = getDb()
    .prepare('SELECT kind FROM sessions WHERE id = ?')
    .get(sessionId) as { kind: string };
  return row.kind;
}

describe('resolveAgentInstanceByNameProduct（M5.3 按名解析）', () => {
  it('按 agentName 匹配目标 ws 成员表；异空间同名成员不串台；无匹配 → null', async () => {
    const wsA = await seedWorkspace('ws-a', ['PM', 'Coder']);
    const wsB = await seedWorkspace('ws-b', ['PM']);

    const pmA = resolveAgentInstanceByNameProduct(wsA, 'PM');
    const coderA = resolveAgentInstanceByNameProduct(wsA, 'Coder');
    const pmB = resolveAgentInstanceByNameProduct(wsB, 'PM');
    expect(pmA).toBeTruthy();
    expect(coderA).toBeTruthy();
    expect(pmA).not.toBe(coderA);
    // 同名成员跨空间是不同实例（按目标 ws 成员表隔离，不串台）
    expect(pmB).toBeTruthy();
    expect(pmB).not.toBe(pmA);
    expect(resolveAgentInstanceByNameProduct(wsA, 'QA')).toBeNull();
    // 大小写敏感（精确匹配口径与镜像按名对齐一致）
    expect(resolveAgentInstanceByNameProduct(wsA, 'pm')).toBeNull();
  });
});

describe('createDelegatedSession 会话列表广播（外派会话实时可见）', () => {
  beforeEach(() => {
    vi.mocked(broadcastSessionListChanged).mockClear();
  });

  it('单 agent 建会 → 广播 session:listChanged（否则停留 IM 视图看不到新会话，切走再切回才出现）', async () => {
    const wsId = await seedWorkspace('ws-bcast', ['Solo']);
    const solo = resolveAgentInstanceByNameProduct(wsId, 'Solo')!;
    ports().createDelegatedSession({
      workspaceId: wsId,
      title: '单 agent 外派',
      memberInstanceId: solo,
    });
    expect(broadcastSessionListChanged).toHaveBeenCalledTimes(1);
  });

  it('多成员建会 → 广播 session:listChanged（团队外派同口径）', async () => {
    const wsId = await seedWorkspace('ws-bcast-t', ['L', 'M']);
    const ids = ['L', 'M'].map((n) => resolveAgentInstanceByNameProduct(wsId, n)!);
    ports().createDelegatedSession({
      workspaceId: wsId,
      title: '团队外派',
      members: ids.map((id, i) => ({ instanceId: id, isLeader: i === 0 })),
    });
    expect(broadcastSessionListChanged).toHaveBeenCalledTimes(1);
  });

  it('建会抛错（成员越集等）→ 不广播', async () => {
    const wsId = await seedWorkspace('ws-bcast-x', ['Solo']);
    expect(() =>
      ports().createDelegatedSession({
        workspaceId: wsId,
        title: '坏成员',
        memberInstanceId: 'no-such-instance',
      }),
    ).toThrow();
    expect(broadcastSessionListChanged).not.toHaveBeenCalled();
  });
});

describe('createDelegatedSession 多成员版（M5.3 团队外派建会）', () => {
  it('members 在场 → kind=task_execution 多成员会话：成员全入 session_members、恰 leader is_leader=1', async () => {
    const wsId = await seedWorkspace('ws-a', ['PM', 'Coder', 'QA']);
    const ids = ['PM', 'Coder', 'QA'].map((n) => resolveAgentInstanceByNameProduct(wsId, n)!);
    const [pm, coder, qa] = [ids[0]!, ids[1]!, ids[2]!];

    const sessionId = ports().createDelegatedSession({
      workspaceId: wsId,
      title: '团队任务书',
      members: [
        { instanceId: coder, isLeader: false },
        { instanceId: pm, isLeader: true },
        { instanceId: qa, isLeader: false },
      ],
    });

    expect(sessionKind(sessionId)).toBe('task_execution');
    expect(sessionMembers(sessionId)).toEqual([
      { instance_id: coder, is_leader: 0 },
      { instance_id: pm, is_leader: 1 },
      { instance_id: qa, is_leader: 0 },
    ]);
  });

  it('members 缺省（单 agent 路径）→ kind=chat 单成员 is_leader=1——回归锁', async () => {
    const wsId = await seedWorkspace('ws-a', ['Coder']);
    const coder = resolveAgentInstanceByNameProduct(wsId, 'Coder')!;

    const sessionId = ports().createDelegatedSession({
      workspaceId: wsId,
      title: '单 agent 任务书',
      memberInstanceId: coder,
    });

    expect(sessionKind(sessionId)).toBe('chat');
    expect(sessionMembers(sessionId)).toEqual([{ instance_id: coder, is_leader: 1 }]);
  });
});
