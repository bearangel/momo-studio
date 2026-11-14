// electron/tests/task/write-path-consolidation.test.ts
//
// 写路径收敛锁（任务生命周期 v2 spec §9.3「禁止外部 updateTask({status}) 直写」，
// Task 15）：任务状态写入收敛至 lifecycle-runs 单点后的回归锁，防止逃生门回潮。
//
// 1) grep 级断言（读源码字符串）：electron/src/main 除白名单外，
//    - 无 transitionTaskStatus( 直调
//    - 无 updateTask( 且实参段含 status patch
//    白名单（逐条裁定依据）：
//    - storage/tasks/repo.ts —— transitionTaskStatus / updateTask 的实现本身
//    - task/lifecycle-runs.ts —— 生命周期服务单点（projectTaskStatus 内部唯一通道）
//    - task/lifecycle.ts —— 既有通道（resumePausedTask 的 K7-5 恢复转换；
//      cancelTask / kickoff 失败已收敛至服务函数，仅 resume 保留直调）
//    - task/starter.ts —— 启动服务原语本体（Task 9 裁定：startTask 事务内的
//      draft→assigned 快捷与 →in_progress 转换与 startRun 同笔原子，属生命
//      周期服务边界内写入；消费面矩阵 A14/A15）
//    - hub/delegation-sync.ts —— hub 同步适配器（spec §9.3 明示豁免，Task 18 处理）
//    - task/dispatcher.ts —— 2.1 未接线预留（消费面矩阵 R12/R25 裁定：
//      接线时随服务原语对齐，不提前改造）
// 2) 行为级：ipc task:transition(id,'completed') → 人话拒（指路 task:submit/accept/reject）
// 3) 行为级：dispatch ledger settle completed → submitRun + auto_accept 直达 completed
// 4) 行为级：stopAgentRuntime → 任务 paused + 活动 run 状态不动（§6.6 暂停不停 run）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

/** 用 hoisted 状态捕获 ipcMain.handle 注册的 handler 集合 */
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      handlers.set(channel, fn);
    },
  },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask } from '../../src/main/storage/tasks/repo';
import { getActiveRun } from '../../src/main/storage/tasks/runs-repo';
import {
  ledgerInsertDispatch,
  ledgerSettleDispatch,
} from '../../src/main/agent/dispatch-task-ledger';
import { insertSession } from '../../src/main/storage/sessions/repo';

// ── 1) grep 级：源码字符串断言 ─────────────────────────────────────────────

/** 写路径收敛白名单（相对 electron/src/main 的 posix 路径；裁定见文件头注） */
const WRITE_PATH_WHITELIST: readonly string[] = [
  'storage/tasks/repo.ts',
  'task/lifecycle-runs.ts',
  'task/lifecycle.ts',
  'task/starter.ts',
  'hub/delegation-sync.ts',
  // P2 S5 豁免惯例：发起方 submitted 镜像消费对 out 行直写 submitted
  // （tests/hub/origin-submitted-mirror.test.ts §3「pending → submitted 直写」锁）
  'hub/remote-intervene-bridge.ts',
  'task/dispatcher.ts',
];

const SRC_ROOT = path.resolve(__dirname, '../../src/main');

/** 递归收集 .ts 源文件（相对 SRC_ROOT 的 posix 路径） */
function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
    }
  }
  return acc;
}

/** 剥掉行注释（// 至行尾）——注释性命中不算写入点（消费面矩阵锚①裁定） */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

/** 从 start（'(' 后一位）走平衡括号取实参段；未闭合回退到首个 ')' 或 500 字符 */
function argSpanOf(code: string, openParenIdx: number): string {
  let depth = 1;
  for (let i = openParenIdx + 1; i < code.length && i < openParenIdx + 500; i++) {
    if (code[i] === '(') depth++;
    if (code[i] === ')') {
      depth--;
      if (depth === 0) return code.slice(openParenIdx + 1, i);
    }
  }
  return code.slice(openParenIdx + 1, openParenIdx + 500);
}

describe('写路径收敛锁（§9.3 grep 级）', () => {
  const files = listTsFiles(SRC_ROOT);

  it('src/main 已被扫描（防路径漂移导致空断言假绿）', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('白名单外无 transitionTaskStatus( 直调', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (WRITE_PATH_WHITELIST.includes(rel)) continue;
      const code = stripLineComments(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'));
      if (/transitionTaskStatus\(/.test(code)) offenders.push(rel);
    }
    expect(offenders, `以下文件绕过生命周期服务直调 transitionTaskStatus：${offenders.join(', ')}`).toEqual([]);
  });

  it('白名单外无 updateTask( 携带 status patch', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (WRITE_PATH_WHITELIST.includes(rel)) continue;
      const code = stripLineComments(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'));
      let searchFrom = 0;
      while (true) {
        const idx = code.indexOf('updateTask(', searchFrom);
        if (idx < 0) break;
        const args = argSpanOf(code, idx + 'updateTask('.length - 1).replace(/\s+/g, ' ');
        // status 作为 patch 键或字面量出现（statusXxx 等字段名不算）
        if (/\bstatus\b\s*:/.test(args)) offenders.push(`${rel}: updateTask(${args.slice(0, 80)})`);
        searchFrom = idx + 1;
      }
    }
    expect(offenders, `以下调用点绕过生命周期服务直写任务状态：\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ── 2-4) 行为级断言 ────────────────────────────────────────────────────────

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-write-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessionId = '';

function seedWorkspaceWithMembers(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  for (const inst of ['inst-pm', 'inst-sub']) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, `agent-${inst}`);
  }
  sessionId = insertSession({ workspaceId: 'ws', title: '协作', kind: 'chat' }).id;
}

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedWorkspaceWithMembers();
  handlers.clear();
  const { registerTaskHandlers } = await import('../../src/main/task/ipc.handlers');
  registerTaskHandlers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('task:transition 白名单收窄（§9.3 行9）', () => {
  it("to='completed' → 人话拒并指路 task:submit / accept / reject，零副作用", async () => {
    const { insertTask } = await import('../../src/main/storage/tasks/repo');
    const t = insertTask({ workspaceId: 'ws', title: 'T', creatorUserId: '@o', status: 'in_progress' });

    const handler = handlers.get('task:transition')!;
    await expect(handler(null, t.id, 'completed')).rejects.toThrow('task:submit');
    expect(getTask(t.id)!.status).toBe('in_progress'); // 拒绝零副作用
  });

  it("to='failed' → 人话拒并指路验收链通道", async () => {
    const { insertTask } = await import('../../src/main/storage/tasks/repo');
    const t = insertTask({ workspaceId: 'ws', title: 'T', creatorUserId: '@o', status: 'in_progress' });

    const handler = handlers.get('task:transition')!;
    await expect(handler(null, t.id, 'failed')).rejects.toThrow('task:submit');
    expect(getTask(t.id)!.status).toBe('in_progress');
  });
});

describe('dispatch ledger settle completed → 提交验收单点', () => {
  it('origin=dispatch 行 auto_accept：settle completed → submitted 瞬态 → 直达 completed', () => {
    ledgerInsertDispatch({
      taskId: 'wp-chain-1',
      body: '写收敛锁用例',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId,
    });
    expect(getTask('wp-chain-1')!.autoAccept, 'dispatch 簿记行生而 auto_accept（spec §6.9）').toBe(true);

    ledgerSettleDispatch('wp-chain-1', 'completed', '交付完成');

    expect(getTask('wp-chain-1')!.status).toBe('completed');
    expect(getActiveRun('wp-chain-1')).toBeNull(); // accepted 是 run 终态
  });
});

describe('stopAgentRuntime 用户停止 → pauseForTask（§6.6 暂停不停 run）', () => {
  it('in_progress 任务转 paused，活动 run 状态不动', async () => {
    const { insertTask } = await import('../../src/main/storage/tasks/repo');
    const { startRun } = await import('../../src/main/task/lifecycle-runs');
    const t = insertTask({
      workspaceId: 'ws',
      title: 'T',
      creatorUserId: '@o',
      assigneeAgentId: 'inst-sub',
      status: 'in_progress',
      executionSessionId: sessionId,
    });
    startRun(t.id, { trigger: 'initial', executionSessionId: sessionId });

    const { stopAgentRuntime } = await import('../../src/main/agent/runtime-registry');
    await stopAgentRuntime('inst-sub');

    expect(getTask(t.id)!.status).toBe('paused');
    expect(getActiveRun(t.id)!.status, 'pauseForTask 只落任务态，run 由中止链另行收尾').toBe('running');
  });
});
