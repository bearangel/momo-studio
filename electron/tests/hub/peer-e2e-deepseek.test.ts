// electron/tests/hub/peer-e2e-deepseek.test.ts
//
// 1.10.0 平行模式 DeepSeek 端到端验收（spec 2026-11-05 §5.2 + §7）——
// 环境门控：DEEPSEEK_API_KEY（缺省整文件 skip；密钥只经环境变量，绝不落库进 git）。
//
// 链路保真度（momo-test-rules 铁律 5）：除 hub 网络边界（SimHub 已由
// m2-integration.test.ts 全真覆盖；此处 stub client 收集上报）外全部真实——
//   真 DB/迁移 → 真 delegation-runner（生产 ports）→ 真草稿落板/监督器 →
//   真本地任务启动（task/starter.startTask）→ 真 sendUserMessage →
//   真 RouterService/AgentRunner/WarmPool → 真 runtime 子进程（dist runtime-entry）→
//   真 DeepSeek API（chat/completions 流式）→ 真 stream-relay 落库 →
//   真 watchTurn 终态 → received/arranged/running/done 四拍全序断言。
//
// 运行：DEEPSEEK_API_KEY=sk-xxx [DEEPSEEK_MODEL=deepseek-flash] \
//   npx pnpm@9.0.0 vitest run tests/hub/peer-e2e-deepseek.test.ts --pool=forks
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createProvider } from '../../src/main/agent/provider-crud';
import { saveAgentDefinition, addMember, generateAgentUserId } from '../../src/main/agent/crud';
import { listMembers } from '../../src/main/agent/agent-queries';
import { createWorkspace } from '../../src/main/workspace/crud';
import { ensureMemberRuntime } from '../../src/main/agent/start-chain';
import { agentRunners } from '../../src/main/agent/runtime-registry';
import { ensureRouterService } from '../../src/main/agent/router-bootstrap';
import { sendUserMessage } from '../../src/main/im/session-service';
import { startTask } from '../../src/main/task/starter';
import { updateTask } from '../../src/main/storage/tasks/repo';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';
import { createDelegationSync } from '../../src/main/hub/delegation-sync';
import { createDelegationRunner, type AssignedTaskEvent } from '../../src/main/hub/delegation-runner';
import { wireDelegationRunnerPorts } from '../../src/main/hub/delegation-ports';
import { createGroupBindingStore } from '../../src/main/hub/group-binding-store';
import { __setRuntimeEntryPathForTest } from '../../src/main/agent/runtime-spawner';
import type { TaskReportPayload } from '../../src/main/hub/delegation-wire';

const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
const DIST_ENTRY = path.join(__dirname, '../../dist/main/agent/runtime-entry.js');
const hasDist = fs.existsSync(DIST_ENTRY);
const gated = API_KEY !== '' && hasDist;

describe.skipIf(!gated)('平行模式 DeepSeek 端到端（真模型真执行链）', { timeout: 240_000 }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ap-peer-e2e-${Date.now()}-`));
  const reports: Array<TaskReportPayload> = [];
  let runner: ReturnType<typeof createDelegationRunner>;
  let workspaceId = '';
  let workerInstanceId = '';

  beforeAll(async () => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
    const memStore = new Map<string, string>();
    const keychain: KeychainImpl = {
      async setSecret(k: string, v: string) { memStore.set(k, v); },
      async getSecret(k: string) { return memStore.get(k) ?? null; },
      async deleteSecret(k: string) { memStore.delete(k); },
    };
    setKeychainImpl(keychain);
    runMigrations();
    __setRuntimeEntryPathForTest(DIST_ENTRY);

    // 数据域：workspace + provider（DeepSeek）+ agent 定义 + 成员 + 组绑定
    const ws = await createWorkspace(
      { name: '研发空间-e2e', directoryPath: path.join(tmpRoot, 'ws') },
      '@owner',
    );
    workspaceId = ws.id;
    const provider = await createProvider({
      name: 'DeepSeek e2e',
      baseUrl: 'https://api.deepseek.com',
      apiKey: API_KEY,
      defaultModel: MODEL,
      isDefault: false,
      platform: 'openai',
    });
    const def = {
      id: crypto.randomUUID(),
      name: '联调工兵',
      slug: 'e2e-worker',
      version: '1.0.0',
      runtime: 'declarative' as const,
      systemPrompt: '你是研发团队的执行工程师。收到任务后简明输出结论（两三句话即可），不要调用工具。',
      defaultTools: [],
      source: 'custom' as const,
      description: 'peer e2e worker',
      iconEmoji: '🛠',
      defaultMcps: [],
      defaultSkills: [],
      workspaceId: null,
      modelProviderId: provider.id,
      modelName: MODEL,
    };
    saveAgentDefinition(def);
    const member = await addMember(workspaceId, def.id, generateAgentUserId(def.slug));
    workerInstanceId = member.instanceId;
    createGroupBindingStore(getDb()).upsert('g-peer-e2e', workspaceId);

    // 真实执行链：成员 runtime（真子进程）+ RouterService（真路由）
    await ensureMemberRuntime(workerInstanceId);
    await ensureRouterService(agentRunners);

    // delegation-runner（生产 ports；client stub 收集上报——hub wire 已由 m2 锁）
    const settings = createHubDelegationSettingsStore(getDb());
    const store = createHubDelegationStore(getDb());
    const fakeClient = {
      state: () => 'online' as const,
      hubProtoVer: () => '1.10.0',
      sendRes: (_id: string, _method: string, payload: TaskReportPayload) => {
        reports.push(payload);
        return true;
      },
      request: async () => ({ tasks: [] }),
    };
    // fakeClient 是 HubClient 的结构子集（生产端口仅消费 state/hubProtoVer/sendRes/request）
    const wired = wireDelegationRunnerPorts({
      clientGetter: () => fakeClient as unknown as import('../../src/main/hub/client').HubClient,
      selfNodeId: () => 'node-worker-e2e',
      settings: () => settings.read(),
    });
    // 生产同款 wrap（hub/index.ts:264）：settle 状态迁移同步回写本地 tasks 行
    const sync = createDelegationSync({
      findTaskByDelegation: (delegationId) => {
        const row = getDb().prepare('SELECT id, status FROM tasks WHERE delegation_id = ?').get(delegationId) as { id: string; status: string } | undefined;
        return row ? ({ id: row.id, status: row.status } as never) : null;
      },
      updateTask: (id, patch) => { updateTask(id, patch); },
      saveProgress: () => undefined,
      getProgress: () => null,
      insertWorkerTaskRow: () => { throw new Error('e2e 不经 ensureRow 建行'); },
      findWorkspaceByName: () => null,
      selfNodeId: () => 'node-worker-e2e',
      now: () => Date.now(),
    });
    runner = createDelegationRunner({ ports: wired, store: sync.wrapWorkerStore(store), tickMs: 100 });
  });

  afterAll(() => {
    runner?.destroy();
    __setRuntimeEntryPathForTest(null);
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  async function waitReports(pred: (list: Array<TaskReportPayload>) => boolean, what: string, timeoutMs = 180_000): Promise<void> {
    const start = Date.now();
    while (!pred(reports)) {
      if (Date.now() - start > timeoutMs) {
        // 超时诊断：messages 行状态 + 尾部事件（定位回合卡在哪一层）
        const sessRow = getDb().prepare('SELECT execution_session_id FROM tasks WHERE delegation_id = ?').get((globalThis as { __e2eTaskId?: string }).__e2eTaskId ?? '') as { execution_session_id: string | null } | undefined;
        const msgRows = sessRow?.execution_session_id
          ? getDb().prepare('SELECT id, sender, status, substr(body,1,60) AS body, stream_session_id, parent_stream_session_id, segment_of, rowid FROM messages WHERE session_id = ? ORDER BY rowid').all(sessRow.execution_session_id)
          : [];
        const evtRows = sessRow?.execution_session_id
          ? getDb().prepare(`SELECT me.event_type, substr(me.payload_json,1,120) AS p FROM message_events me
             JOIN messages m ON m.id = me.message_id WHERE m.session_id = ? ORDER BY me.rowid DESC LIMIT 8`).all(sessRow.execution_session_id)
          : [];
        throw new Error(`等待超时: ${what}\n上报: ${JSON.stringify(reports)}\nmessages: ${JSON.stringify(msgRows)}\n尾事件: ${JSON.stringify(evtRows)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  (globalThis as { __e2eTaskId?: string }).__e2eTaskId = '';

  it('草稿→安排→真启动（DeepSeek 真回合）→done 四拍全序', async () => {
    // 1. 草稿到达（模拟 task.assigned draft 事件——生产经 hub 事件桥）
    const evt: AssignedTaskEvent = {
      taskId: `e2e-${Date.now()}`,
      workspaceName: '需求空间（源）',
      byNode: 'node-req-e2e',
      groupId: 'g-peer-e2e',
      task: {
        title: '回答联调检查单',
        prompt: '请用一句话回答：1+1 等于几？然后在第二行写「联调就绪」四个字。',
        draft: true,
        priority: 5,
      },
    };
    (globalThis as { __e2eTaskId?: string }).__e2eTaskId = evt.taskId;
    await runner.handleAssigned(evt);

    // 2. 落板断言：draft 行进绑定空间（真 DB）
    await waitReports((rs) => rs.some((r) => r.progress?.kind === 'received'), 'received 拍');
    const row = getDb().prepare('SELECT * FROM tasks WHERE delegation_id = ?').get(evt.taskId) as
      | { id: string; status: string; origin: string; workspace_id: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('draft');
    expect(row!.origin).toBe('peer_draft');
    expect(row!.workspace_id).toBe(workspaceId);

    // 3. 安排（真本地路径：指派成员 → assigned）
    updateTask(row!.id, { status: 'assigned', assigneeAgentId: workerInstanceId });
    await waitReports((rs) => rs.some((r) => r.progress?.kind === 'arranged'), 'arranged 拍');

    // 4. 真启动：startTask（真 starter：建执行会话 + in_progress + 锁定 execution_session_id）
    //    + kickoff（真 sendUserMessage → 真路由 → 真子进程 → DeepSeek）
    const started = await startTask(row!.id);
    await sendUserMessage({
      sessionId: started.executionSessionId,
      body: evt.task.prompt,
      systemKickoff: true,
    });

    // 5. 监督器接管 → running 拍；真回合终态 → done 拍
    await waitReports((rs) => rs.some((r) => r.status === 'running'), 'running 拍（执行接管）');
    await waitReports((rs) => rs.some((r) => r.status === 'done'), 'done 拍（真 DeepSeek 回合终态）');

    // 6. 全序断言：received → arranged → running → done（按到达序）
    const kinds = reports.map((r) => (r.progress?.kind ?? r.status));
    expect(kinds.indexOf('received')).toBeLessThan(kinds.indexOf('arranged'));
    expect(kinds.indexOf('arranged')).toBeLessThan(kinds.indexOf('running'));
    expect(kinds.indexOf('running')).toBeLessThan(kinds.indexOf('done'));

    // 7. 真模型输出落库：执行会话有 agent 回复（DeepSeek 真内容，非空）
    const reply = getDb()
      .prepare(
        `SELECT body FROM messages WHERE session_id = ? AND sender != 'owner' AND body != '' ORDER BY rowid DESC LIMIT 1`,
      )
      .get(started.executionSessionId) as { body: string } | undefined;
    expect(reply?.body).toBeTruthy();
    expect(reply!.body.length).toBeGreaterThan(0);

    // 8. 任务行终态：completed（监督器 done 上报同拍本地清算）
    const finalRow = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(row!.id) as { status: string };
    expect(['completed', 'in_progress']).toContain(finalRow.status); // done 拍在前，行清算随后一拍
    await waitReports(
      () => (getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(row!.id) as { status: string }).status === 'completed',
      '任务行 completed',
      5_000,
    );
  });
});
