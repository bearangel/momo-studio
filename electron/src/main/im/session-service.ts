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
import { getSession, touchSessionLastMessage } from '../storage/sessions/repo';
import { broadcastLocalMessage } from '../p2p';
import { detectConflict } from '../task/conflict-detector';
import { listTasks, getTask } from '../storage/tasks/repo';
import { applyFirstMessageTitle } from './session-naming';
import { getSessionMembersInfo, type SessionMemberInfo } from './session-ops';
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
 * 目标解析（v25 Task 9，spec §4.6 / D5——leader 接待语义）：
 *   1. 显式 mention → 第一个被 @ 且有效（仍在 ws）的成员直答，leader 不插嘴
 *   2. 非 @ 消息 → 会话内 is_leader=1 且有效成员接待（建会时快照，spec §3.3）
 *   3. 无 leader（历史会话 / leader 已失效）→ null（不派发任何 agent）
 *
 * 失效过滤：getSessionMembersInfo 的 JOIN（session_members × workspace_agent_members）
 * 天然剔除已被移出 workspace 的成员——快照行残留但成员表无行的「失效成员」不参与
 * 接待判定，也不算作会话的有效成员（readOnly 判定同源）。
 *
 * 注：sendUserMessage 只处理本地用户消息（单用户应用，所有消息 sender='owner'），
 * v1.x decide-response 的 isOwnerMessage 守卫在结构上已满足。
 */
export function resolveTarget(sessionId: string, mentionedInstanceIds: string[]): string | null {
  return pickRoutingTarget(getSessionMembersInfo(sessionId), mentionedInstanceIds);
}

/** 路由选目标纯函数：mention 优先 → leader 接待；无 leader → null */
function pickRoutingTarget(
  members: SessionMemberInfo[],
  mentionedInstanceIds: string[],
): string | null {
  const mentioned = mentionedInstanceIds.find((id) =>
    members.some((m) => m.instanceId === id),
  );
  if (mentioned) return mentioned;
  return members.find((m) => m.isLeader)?.instanceId ?? null;
}

/** sendUserMessage 返回：readOnly=true 表示会话全部成员失效（renderer 据此禁用输入） */
export interface SendUserMessageResult {
  readOnly: boolean;
}

/**
 * 用户消息写入路径：INSERT → touch → 推 renderer → P2P 广播 → 冲突检测 → 路由到目标 agent。
 *
 * - 会话不存在直接抛错（调用方 IPC 层转 renderer 错误提示）
 * - P2P 广播与冲突检测均为非阻塞路径：失败不影响消息落库与路由
 * - 无 router（RouterService 未启动）或无目标（无 leader / 全失效）时跳过路由，消息仍落库
 * - 首条用户消息落库后接线 applyFirstMessageTitle 截断占位（T8 命名服务，内部守卫
 *   仅占位态生效，重复调用不覆盖）
 * - 返回 readOnly：会话内有效成员数为 0（全部被移出 ws）时为 true（spec §7「会话只读」）
 */
export async function sendUserMessage(input: {
  sessionId: string;
  body: string;
  mentionedInstanceIds?: string[];
}): Promise<SendUserMessageResult> {
  const session = getSession(input.sessionId);
  if (!session) throw new Error(`会话不存在: ${input.sessionId}`);

  const msg = insertMessage({
    sessionId: input.sessionId,
    sender: 'owner', // 单用户应用：本地用户消息统一 sender='owner'（取代 Matrix user id；
    // 该字面量与 session-naming 的 firstUser 过滤条件构成契约，测试锁死）
    eventType: 'm.room.message', // 事件类型字符串保留（renderer 渲染分支依赖；P2 收敛命名）
    body: input.body,
    workspaceId: session.workspaceId,
  });
  touchSessionLastMessage(input.sessionId);
  pushMessageRow(msg);

  // 首条用户消息截断占位（T8 接线；守卫：title=「新会话」占位 且 title_auto=1）
  applyFirstMessageTitle(input.sessionId, input.body);

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

  // 有效成员（JOIN 过滤失效）→ 选目标派发；全失效时 members 为空（readOnly）
  const members = getSessionMembersInfo(input.sessionId);
  const target = pickRoutingTarget(members, input.mentionedInstanceIds ?? []);
  if (target) {
    if (router) {
      // routeUserChat.assignmentId：RouterService 现行契约字段（值即 instance_id），
      // 随 Task 9 路由改造一并更名。
      await router.routeUserChat({ sessionId: input.sessionId, assignmentId: target, body: input.body });
    } else {
      // router 缺席（RouterService 未启动/销毁）必须留痕——防静默死路
      // （Task 9 评审：零 runner 启动也已保证 router 在位，此分支仅剩极端时序）
      logger.warn('路由目标已解析但 RouterService 未就绪，消息跳过派发', {
        sessionId: input.sessionId,
        target,
      });
    }
  }
  return { readOnly: members.length === 0 };
}

/** 推送 SQLite MessageRow 到 renderer（与 im:message 载荷形状对齐，跨 IPC 一致） */
function pushMessageRow(msg: MessageRow): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('session:message', msg);
}
