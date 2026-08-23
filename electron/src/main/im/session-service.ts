// electron/src/main/im/session-service.ts
//
// SessionService（v2.0.0 P1 Task 7）——用户消息写入 + 目标解析 + 进程内路由。
// 取代原 im/ipc.handlers.ts 内联的 sendUserMessage + decide-response 的 Matrix 语义，
// 全链纯 SQLite + 进程内路由，无 Matrix 依赖。
//
// 消息写路径（spec）：
//   INSERT messages（source='local'）→ touch sessions.last_message_at
//   → push session:message 到 renderer → P2P 广播（fire-and-forget）
//   → 冲突检测（失败不阻塞）→ resolveTarget → router.routeUserChat
//
// 依赖注入（与 sync-manager 的 setMainWindow / router-bootstrap 的 setBridgeRouter 同法）：
//   - setSessionRouter：RouterService 由 router-bootstrap lazy 启动后注入；null 表示未就绪
//   - setSessionMainWindow：主窗口由 main/index.ts 创建后注入
//
// 对 electron 仅做 type-only import——模块在测试进程（无 Electron 运行时）可安全加载。

import { insertMessage, type MessageRow } from '../storage/messages/repo';
import { getSession, listSessionMembers, touchSessionLastMessage } from '../storage/sessions/repo';
import { getWorkspace } from '../workspace/crud';
import { broadcastLocalMessage } from '../p2p';
import { detectConflict } from '../task/conflict-detector';
import { listTasks, getTask } from '../storage/tasks/repo';
import type { BrowserWindow } from 'electron';
import { logger } from '../logger';

/** 进程内路由器最小契约（RouterService 的结构子集；避免直接依赖 agent 模块防循环引用） */
interface SessionRouter {
  routeUserChat(input: { sessionId: string; assignmentId: string; body: string; streamSessionId?: string }): Promise<void>;
}

/** 模块级注入：router-bootstrap ensureRouterService 注入 / destroyRouterService 置空 */
let router: SessionRouter | null = null;

export function setSessionRouter(svc: SessionRouter | null): void {
  router = svc;
}

/** 模块级注入：主窗口引用（push session:message / im:conflict / agent:runtimeChanged 用） */
let mainWindow: BrowserWindow | null = null;

export function setSessionMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/**
 * 通知 renderer：agent 运行态变化（启动/停止/自动恢复完成），让其重新同步 running 状态。
 * v2.0 P1 Task 12：原属 matrix/sync-manager（随 Matrix 全家删除迁此）——推送通道
 * 名 'agent:runtimeChanged' 保持不变，renderer 订阅方无感知。
 */
export function broadcastRuntimeChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('agent:runtimeChanged');
}

/**
 * 目标解析（原 decide-response 三场景的 session 语义）：
 *   1. 显式 mention → 第一个被 @ 且是本会话成员的 assignment
 *   2. 会话仅 1 个成员 agent → 自动响应（原"单聊无需 @"）
 *   3. 本会话是 workspace 团队会话（team_session_id）且有协调 agent → 协调 agent 自动接待
 *      （仅当会话 IS 团队会话时才接待——普通群不越权；协调者不要求是会话成员，
 *       与原 decide-response 的主 agent 默认接待语义一致）
 *   4. 其余 → null（不路由）
 *
 * 注：原 decide-response 有 isOwnerMessage 守卫（仅用户本人消息触发自动接待）。
 * 新模型下 sendUserMessage 只处理本地用户消息（单用户应用，所有消息 sender='owner'），
 * 该守卫在结构上已满足，无需重复判断。
 */
export function resolveTarget(sessionId: string, mentionedAssignmentIds: string[]): string | null {
  const members = listSessionMembers(sessionId).map((m) => m.assignmentId);
  const mentioned = mentionedAssignmentIds.find((id) => members.includes(id));
  if (mentioned) return mentioned;
  if (members.length === 1) return members[0]!; // 单成员会话：发言即应答
  const session = getSession(sessionId);
  if (!session) return null;
  const ws = getWorkspace(session.workspaceId);
  if (ws && ws.teamSessionId === sessionId && ws.coordinatorInstanceId) return ws.coordinatorInstanceId;
  return null;
}

/**
 * 用户消息写入路径：INSERT → touch → 推 renderer → P2P 广播 → 冲突检测 → 路由到目标 agent。
 *
 * - 会话不存在直接抛错（调用方 IPC 层转 renderer 错误提示）
 * - P2P 广播与冲突检测均为非阻塞路径：失败不影响消息落库与路由
 * - 无 router（RouterService 未启动）或无目标（resolveTarget null）时静默跳过路由
 */
export async function sendUserMessage(input: {
  sessionId: string;
  body: string;
  mentionedAssignmentIds?: string[];
}): Promise<void> {
  const session = getSession(input.sessionId);
  if (!session) throw new Error(`会话不存在: ${input.sessionId}`);

  const msg = insertMessage({
    sessionId: input.sessionId,
    sender: 'owner', // 单用户应用：本地用户消息统一 sender='owner'（取代 Matrix user id）
    eventType: 'm.room.message', // 事件类型字符串保留（renderer 渲染分支依赖；P2 收敛命名）
    body: input.body,
    workspaceId: session.workspaceId,
  });
  touchSessionLastMessage(input.sessionId);
  pushMessageRow(msg);

  // P2P 广播（fire-and-forget；sync 未初始化时静默返回）。
  // 注意：p2p SyncMessage 字段名仍为 roomId（p2p 模块属阶段三重构范围，本 task 不动），
  // 此处按值映射 sessionId → roomId；p2p 模块重构时统一改名。
  void broadcastLocalMessage({
    roomId: input.sessionId,
    sender: 'owner',
    body: input.body,
    eventType: 'm.room.message',
  });

  // 冲突检测（沿用 im:send 的保护语义：失败不阻塞消息发送）
  try {
    const conflict = detectConflict(input.sessionId, input.body, {
      findInProgressTaskByRoom: (sessionId) =>
        listTasks({ executionSessionId: sessionId, status: 'in_progress', limit: 1 })[0] ?? null,
      getTask,
    });
    if (conflict && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('im:conflict', conflict);
    }
  } catch (err) {
    logger.warn('冲突检测失败（不阻塞消息发送）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const target = resolveTarget(input.sessionId, input.mentionedAssignmentIds ?? []);
  if (target && router) {
    await router.routeUserChat({ sessionId: input.sessionId, assignmentId: target, body: input.body });
  }
}

/** 推送 SQLite MessageRow 到 renderer（与 im:message 载荷形状对齐，跨 IPC 一致） */
function pushMessageRow(msg: MessageRow): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('session:message', msg);
}
