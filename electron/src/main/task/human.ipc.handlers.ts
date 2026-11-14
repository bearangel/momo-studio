// electron/src/main/task/human.ipc.handlers.ts
//
// human: 命名空间 IPC（任务生命周期 v2 Task 16，spec §6 HITL IPC 面）+
// 生命周期服务装配点。三通道 + 两推送 + 定时器：
//   - human:list      人工请求列表（sessionId/taskId 过滤 + status pending|all）
//   - human:answer    答复（question / manual_action / tool_gate；acceptance 走
//                     task:accept / task:reject——answerHuman 通道守卫）
//   - human:attention 会话注意力聚合（waiting / submitted / executorSubmitted / failed）
//   - 推送 human:changed / task:runChanged：sink 注册（lifecycle-runs setter 注入，
//     服务层零 electron 依赖——子进程可达隔离约束）
//   - 装配：boot recoverOrphanToolGates（重启孤儿 tool_gate 置 expired）+
//     60s interval sweepHumanTimeouts（人工请求超时五策略）
//
// 本模块顶层 import electron（ipcMain），铁定主进程专属——不进 runtime 子进程图
// （write-blocked-emit 禁入断言的隔离锁同款先例）。
import { ipcMain } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { loadElectronApis } from '../electron-access';
import { createHubConfigStore } from '../hub/config-store';
import {
  answerHuman,
  setHumanChangedSink,
  setTaskRunChangedSink,
  type HumanAnswerInput,
} from './lifecycle-runs';
import { sweepHumanTimeouts } from './human-timeout-sweeper';
import { recoverOrphanToolGates } from '../sandbox/write-blocked-emit';
import { listRequests } from '../storage/tasks/human-requests-repo';

/** 推送到当前主窗口 renderer（session-service pushToMainWindow 同法：按推送时点
 *  动态解析当前窗口——窗口销毁重建不断链；非主进程环境静默跳过） */
function pushToMainWindow(channel: string, ...args: unknown[]): void {
  const { BrowserWindow } = loadElectronApis();
  if (!BrowserWindow) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}

/** 未配置 hub 时的本地答复节点标识（answered_by_node_id 落账） */
const LOCAL_NODE_ID = 'local';

/** 答复者节点标识：hub 已配置且有 nodeId 用自身节点 id，否则 'local' */
function resolveLocalNodeId(): string {
  try {
    return createHubConfigStore(getDb()).read()?.nodeId ?? LOCAL_NODE_ID;
  } catch {
    return LOCAL_NODE_ID;
  }
}

/** attention 单会话聚合值（HumanApiSurface.attention 的 Record 值形状） */
export interface SessionAttention {
  waiting: number;
  submitted: boolean;
  executorSubmitted: boolean;
  failed: boolean;
}

/**
 * 会话注意力聚合（human:attention 数据面，导出供测试直调）。
 * 两条轻量 SQL 内存合并（避免巨型 JOIN，brief Step 3）：
 *   1) waiting：pending 人工请求（kind != 'acceptance'——验收单不折叠加急）
 *      按 session 计数，JOIN sessions 限定 workspace
 *   2) 任务面：workspace 内 execution_session_id 非空且 status 属
 *      submitted / failed 的任务行（归档排除）。submitted 的验收方判定：
 *      delegation_role IS NULL（本机任务）或 'out'（外派他人——本机是验收方）
 *      → submitted=true；delegation_role='in'（承接外派——本机是执行方）
 *      → executorSubmitted=true；failed → failed=true
 * 只输出至少有一个信号的会话（零信号会话不占位）。
 */
export function aggregateAttention(workspaceId: string): Record<string, SessionAttention> {
  const out: Record<string, SessionAttention> = {};
  const ensure = (sessionId: string): SessionAttention => {
    const existing = out[sessionId];
    if (existing) return existing;
    const fresh: SessionAttention = { waiting: 0, submitted: false, executorSubmitted: false, failed: false };
    out[sessionId] = fresh;
    return fresh;
  };

  const waitingRows = getDb()
    .prepare(
      `SELECT hr.session_id AS sessionId, COUNT(*) AS n
       FROM human_requests hr JOIN sessions s ON s.id = hr.session_id
       WHERE s.workspace_id = ? AND hr.status = 'pending' AND hr.kind != 'acceptance'
       GROUP BY hr.session_id`,
    )
    .all(workspaceId) as Array<{ sessionId: string; n: number }>;
  for (const row of waitingRows) ensure(row.sessionId).waiting = row.n;

  const taskRows = getDb()
    .prepare(
      `SELECT execution_session_id AS sessionId, status, delegation_role AS role
       FROM tasks
       WHERE workspace_id = ? AND execution_session_id IS NOT NULL
         AND status IN ('submitted', 'failed') AND archived_at IS NULL`,
    )
    .all(workspaceId) as Array<{ sessionId: string; status: string; role: string | null }>;
  for (const row of taskRows) {
    const entry = ensure(row.sessionId);
    if (row.status === 'failed') {
      entry.failed = true;
      continue;
    }
    if (row.role === 'in') entry.executorSubmitted = true;
    else entry.submitted = true; // 本机任务（NULL）或外派他人（'out'）——本机是验收方
  }
  return out;
}

/** sweeper 扫描间隔（spec §6 超时策略；oauth lifecycle 60s 同档） */
const SWEEP_INTERVAL_MS = 60_000;

/** 注册幂等 flag + 定时器句柄（重复调用 no-op——brief Step 1 用例 5） */
let registered = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 注册 human 命名空间 + 生命周期装配（boot 时 ipc/index.ts 调用一次；
 * 重复调用幂等 no-op）。装配顺序：sink → boot 孤儿回收 → 定时器 → handlers
 * （sink 先于一切可能触发推送的动作）。
 */
export function registerHumanIpc(): void {
  if (registered) return;
  registered = true;

  setHumanChangedSink((e) => pushToMainWindow('human:changed', e));
  setTaskRunChangedSink((e) => pushToMainWindow('task:runChanged', e));

  // 重启恢复（Task 13 §6.8）：内存注册表重启恒空 → 重启前全部授权卡置 expired
  try {
    const res = recoverOrphanToolGates();
    if (res.expired > 0) logger.info('boot tool_gate 孤儿回收完成', res);
  } catch (err) {
    logger.warn('boot tool_gate 孤儿回收失败（不阻塞启动）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  sweepTimer = setInterval(() => {
    try {
      sweepHumanTimeouts();
    } catch (err) {
      logger.warn('人工请求超时扫描失败（下轮重试）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, SWEEP_INTERVAL_MS);
  // 定时器不得单独保活进程（oauth lifecycle 同纪律）
  sweepTimer.unref();

  ipcMain.handle('human:list', (_evt, input: { sessionId?: unknown; taskId?: unknown; status?: unknown }) => {
    const a = input ?? {};
    if (a.sessionId !== undefined && typeof a.sessionId !== 'string') throw new Error('sessionId 非法');
    if (a.taskId !== undefined && typeof a.taskId !== 'string') throw new Error('taskId 非法');
    if (a.status !== undefined && a.status !== 'pending' && a.status !== 'all') {
      throw new Error('status 只支持 pending / all');
    }
    return listRequests({
      sessionId: a.sessionId as string | undefined,
      taskId: a.taskId as string | undefined,
      status: a.status as 'pending' | 'all' | undefined,
    });
  });

  /**
   * 答复人工请求：message 附言并入 answer.text（换行拼接——答复正文单字段）；
   * 答复者节点 = hub 自身 nodeId（未配置 'local'）。acceptance kind 由
   * answerHuman 通道守卫人话拒（验收走 task:accept / task:reject）。
   */
  ipcMain.handle(
    'human:answer',
    (
      _evt,
      requestId: string,
      answer: HumanAnswerInput,
      message?: string,
    ): { disposition: 'answered' | 'stale' } => {
      if (typeof requestId !== 'string' || requestId === '') throw new Error('requestId 缺失');
      if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
        throw new Error('answer 非法');
      }
      if (message !== undefined && typeof message !== 'string') throw new Error('message 非法');
      const merged: HumanAnswerInput =
        message !== undefined && message !== ''
          ? { ...answer, text: answer.text !== undefined && answer.text !== '' ? `${answer.text}\n${message}` : message }
          : answer;
      return answerHuman(requestId, merged, resolveLocalNodeId());
    },
  );

  ipcMain.handle('human:attention', (_evt, workspaceId: string) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('workspaceId 缺失');
    return aggregateAttention(workspaceId);
  });

  logger.info('Human IPC handlers 已注册');
}

/** 测试拆卸端：还原模块级装配态（幂等） */
export function __teardownHumanIpcForTest(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  registered = false;
  setHumanChangedSink(null);
  setTaskRunChangedSink(null);
}
