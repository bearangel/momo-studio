// electron/src/main/hub/delegation-sync.ts
//
// M2.1 Task 9：外派投影与状态同步——hub 委派事件流 ↔ 本地 tasks 行的双视角回写。
//
//   ── leader 侧（hub/index.ts onEvent 桥接线）──
//   task.progress / task.completed / task.failed / task.interrupted 四推送 +
//   task.cancel 回执（hub 账本权威；协议无 cancelled leader 推送）→ 按
//   delegation_id 关联行回写状态（六态映射表）+ 进度摘要（excerpt 落 hub 域 kv，
//   重启后看板进度行不丢——tasks 表无 lastProgress 列，最小面裁定走 kv）。
//
//   ── worker 侧（delegation store 装饰器）──
//   收到的委派（task.assigned → delegation-runner 建 DelegationRecord）同步建
//   tasks 行投上看板（S6 合同：被委派任务画进看板）：routing.targetNodeId=本机
//   视角（ groupId 空——协议 TaskAssignedEvent 无 groupId，读侧判向不依赖它 ）、
//   byNode=来源（存 delegation record，卡片「来自 {node}」徽标数据源）。
//   零改 delegation-runner：装饰 store 的 upsert/updateState 观察状态迁移。
//
//   ── retryDispatch ──
//   待派发重试（RM-M21-5 无候选不轮询、手动驱动）与失败重派的单点：复位行 →
//   复用 dispatch-submit 的目标解析（调度单源）→ 既有委派管道 → 回写新
//   delegation_id（换 id——旧 id 属旧账本行，禁止续用）。
//
// 端口注入纪律（momo-test-rules #5）：DB / workspace / 节点身份全部经 Ports 注入，
// 生产接线在 hub/index.ts + hub/ipc.handlers.ts；tests/hub 注入 fake。
import type { Database } from 'better-sqlite3';
import type { DelegationStatus } from './protocol';
import type { DelegationRecord, HubDelegationStore } from './delegation-store';
import type { PermissionTier, DelegationTaskBrief } from './dispatch-submit';
import { expandTeamPayload } from './dispatch-submit';
import type { TaskRouting } from './task-routing';
import type { TaskRow, TaskStatus } from '../storage/tasks/repo';
import { isTerminal } from '../storage/tasks/state-machine';
import { blockedDispatchError } from '../task/dependency-gate';
import { logger } from '../logger';

/**
 * 七态映射表（hub 委派账本态 → 本地 tasks 行状态——测试锁 + 文档单源）：
 *
 * | hub 委派态   | 本地 TaskStatus | 看板列 | 说明                              |
 * |--------------|-----------------|--------|-----------------------------------|
 * | pending      | pending         | 待办   | 派发落行即 pending（无推送，纯初值）|
 * | running      | in_progress     | 进行中 | progress 拍驱动；首次写 startedAt  |
 * | waiting      | in_progress     | 进行中 | M3.1 七态：running 中等待用户确认 |
 * |              |                 |        | 的中间态——本地行维持进行中（看板 |
 * |              |                 |        | 无等待态；等待角标由 progress kv   |
 * |              |                 |        | waiting 标志驱动，不造新行状态）  |
 * | done         | completed       | 已完成 | 终态；completedAt + 摘要「已完成」  |
 * | failed       | failed          | 已关闭 | 终态；errorMessage=reason 原文     |
 * | cancelled    | cancelled       | 已关闭 | 终态；task.cancel 回执驱动         |
 * | interrupted  | pending         | 待办   | 裁定：等待续传语义映射回待处理列，  |
 * |              |                 |        | 中断事实经进度摘要行呈现（不造看板 |
 * |              |                 |        | 新状态；后续 running 拍合法回升）  |
 *
 * 写侧不走 transitionTaskStatus 状态机断言：外派行的状态权威是 hub 账本，
 * 本地九态转换表为本地 agent 执行管线设计（pending→in_progress 在该管线非法，
 * 在外派链是常态）；以「终态粘滞 + 映射表」替代转换合法性约束。
 */
export const DELEGATION_STATUS_TO_TASK: Record<DelegationStatus, TaskStatus> = {
  pending: 'pending',
  running: 'in_progress',
  waiting: 'in_progress',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'pending',
};

/** worker 本地账本四态 → 行状态（本地无 pending/interrupted 态：首录即 running） */
const WORKER_STATE_TO_TASK: Record<DelegationRecord['state'], TaskStatus> = {
  running: 'in_progress',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** interrupted 进度摘要（等待续传语义的呈现文案——卡片进度行消费） */
export const INTERRUPTED_SUMMARY = '目标节点连接中断，等待重连续传';

/** done 终态的进度摘要兜底（协议 done 不带 reason） */
const DONE_SUMMARY = '已完成';

/** cancelled 终态的进度摘要兜底（task.cancel 回执不带 reason） */
const CANCELLED_SUMMARY = '已取消';

// ── 进度摘要 kv（hub 域自有 kv，delegation-store 同款纪律）───────────────────

/** 进度摘要条目（delegationId 键；excerpt 恒非空——wire 契约） */
export interface DelegationProgressEntry {
  excerpt: string;
  lastSeq: number;
  at: number;
  /** 等待确认标志（T12）：kind='waiting-input' 拍置 true；恢复拍（无 kind）清除。
   *  可选——T11 前落库的旧条目无此字段（=== true 判定，不误报）。 */
  waiting?: boolean;
  /** 远程代答留痕（M3.1）：task.answered 事件置 {decision, at}；后续进度拍
   *  （handleProgress 整条覆写）自然清除——「较新才显示」由消费侧比较 at 判定。
   *  可选——旧条目无此字段（形状不符即弃，保守解析）。 */
  answered?: { decision: 'approve' | 'deny'; at: number };
}

const PROGRESS_KEY = 'hub_delegation_progress';

/** answered 形状校验（保守解析——decision 枚举 + at 数字，异形整字段丢弃不渗入持久化面） */
function isAnsweredShape(v: unknown): v is { decision: 'approve' | 'deny'; at: number } {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as { decision?: unknown; at?: unknown };
  return (a.decision === 'approve' || a.decision === 'deny') && typeof a.at === 'number';
}

function parseProgress(raw: string | undefined): Record<string, DelegationProgressEntry> {
  const out: Record<string, DelegationProgressEntry> = {};
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'object' || v === null) continue;
      const e = v as Partial<DelegationProgressEntry>;
      if (typeof e.excerpt === 'string' && typeof e.lastSeq === 'number' && typeof e.at === 'number') {
        // waiting 仅 true 落形——旧条目/T12 前数据零改写（toEqual 形状锁不破）；
        // answered 同款保守纪律（M3.1）
        out[k] = {
          excerpt: e.excerpt,
          lastSeq: e.lastSeq,
          at: e.at,
          ...(e.waiting === true ? { waiting: true } : {}),
          ...(isAnsweredShape(e.answered) ? { answered: e.answered } : {}),
        };
      }
    }
  } catch {
    // 脏 JSON 容错：整表按空处理（委派可重派，不炸读取方）
  }
  return out;
}

export interface DelegationProgressStore {
  get(delegationId: string): DelegationProgressEntry | null;
  save(delegationId: string, entry: DelegationProgressEntry): void;
  list(): Record<string, DelegationProgressEntry>;
}

/** 进度摘要持久层（kv_store 'hub_delegation_progress'——看板进度行数据源） */
export function createDelegationProgressStore(db: Database): DelegationProgressStore {
  const load = (): Record<string, DelegationProgressEntry> => {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(PROGRESS_KEY) as
      | { value: string }
      | undefined;
    return parseProgress(row?.value);
  };
  const write = (all: Record<string, DelegationProgressEntry>): void => {
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(PROGRESS_KEY, JSON.stringify(all));
  };
  return {
    get(delegationId) {
      return load()[delegationId] ?? null;
    },
    save(delegationId, entry) {
      const all = load();
      all[delegationId] = entry;
      write(all);
    },
    list() {
      return load();
    },
  };
}

// ── 状态回写（leader 侧 + worker 侧共用端口）─────────────────────────────────

/** 进程/DB 边界端口（唯一 mock 面；生产接线 hub/index.ts） */
export interface DelegationSyncPorts {
  /** delegation_id 反查看板行（外派行判别单源：dispatch-submit 建立的映射） */
  findTaskByDelegation(delegationId: string): TaskRow | null;
  /** 行直写（绕过状态机断言——见映射表头注；updatedAt 由实现 bump） */
  updateTask(id: string, patch: Partial<TaskRow>): void;
  /** 进度摘要落 kv */
  saveProgress(delegationId: string, entry: DelegationProgressEntry): void;
  /** 进度摘要读回（handleAnswered 合并写的前置读取——M3.1） */
  getProgress(delegationId: string): DelegationProgressEntry | null;
  /** worker 侧收委派建行（生产=storage/tasks/repo insertTask） */
  insertWorkerTaskRow(input: {
    workspaceId: string;
    title: string;
    status: TaskStatus;
    routing: TaskRouting;
    delegationId: string;
    startedAt: number;
  }): string;
  /** 工作空间名 → id（worker 建行前置；找不到不建行） */
  findWorkspaceByName(name: string): { id: string } | null;
  /** 本机 nodeId（worker 行 routing.targetNodeId——本机视角判向） */
  selfNodeId(): string | null;
  now(): number;
}

export interface DelegationSync {
  /**
   * leader：task.progress 拍 → running 映射 + 进度摘要。
   * kind='waiting-input' → kv waiting 标志（T12）；kind='denied'（M2.2 P2-1
   * 前向预留——hub v0.1.4 剥除该值不透传）→ 不置 waiting，文案由 excerpt 承载。
   */
  handleProgress(evt: { taskId: string; lastSeq: number; excerpt: string; kind?: 'waiting-input' | 'denied' }): void;
  /** leader：task.completed / task.failed / task.interrupted 终态 */
  handleTerminal(status: 'done' | 'failed' | 'interrupted', taskId: string, reason?: string): void;
  /** leader：task.cancel 回执（hub 账本权威 → 本地行同步） */
  markCancelled(taskId: string): void;
  /**
   * leader：task.answered 事件（M3.1）→ 进度 kv 条目合并写 answered 留痕
   * （excerpt/lastSeq/at 保留——行状态不动：hub 代答不迁移账本，waiting↔running
   * 单由 worker 上报驱动）。无既有条目（委派未开跑/无看板行）→ 静默无落点。
   */
  handleAnswered(evt: { taskId: string; decision: 'approve' | 'deny' }): void;
  /** worker：装饰 delegation store（观察 upsert/updateState；delegation-runner 零改） */
  wrapWorkerStore(store: HubDelegationStore): HubDelegationStore;
}

export function createDelegationSync(ports: DelegationSyncPorts): DelegationSync {
  /**
   * 映射态写行（粘滞语义）：
   *   - 行不存在 → 静默（手工 task.delegate 等无看板行的委派）
   *   - 行已终态且目标态不同 → 丢弃（迟到事件不回退；重派走 retryDispatch 换行复位）
   *   - 同态零写（T12 Low-1：终态同态重写会重盖章 completedAt/updatedAt 并丢
   *     first-write 语义——重复 done 推送不改变 completedAt）
   *   - interrupted→pending 是唯一「非终态回落」，显式放行（等待续传语义）
   */
  const applyMapped = (
    delegationId: string,
    hubStatus: DelegationStatus,
    extra: Partial<TaskRow>,
  ): void => {
    const row = ports.findTaskByDelegation(delegationId);
    if (!row) return;
    const next = DELEGATION_STATUS_TO_TASK[hubStatus];
    if (isTerminal(row.status) && row.status !== next) return;
    if (row.status === next) return;
    ports.updateTask(row.id, { status: next, ...extra });
  };

  const saveProgress = (
    delegationId: string,
    excerpt: string,
    lastSeq: number,
    kind?: 'waiting-input' | 'denied',
  ): void => {
    ports.saveProgress(delegationId, {
      excerpt,
      lastSeq,
      at: ports.now(),
      ...(kind === 'waiting-input' ? { waiting: true } : {}),
    });
  };

  return {
    handleProgress(evt) {
      // 摘要与行状态同拍落（摘要先写——行不存在时摘要仍保留，重派后可续显）；
      // waiting 标志随 kind 翻转：等待拍置 true，恢复拍（无 kind）自然清除
      saveProgress(evt.taskId, evt.excerpt, evt.lastSeq, evt.kind);
      const row = ports.findTaskByDelegation(evt.taskId);
      if (row && !isTerminal(row.status)) {
        applyMapped(evt.taskId, 'running', { startedAt: row.startedAt ?? ports.now() });
      }
    },

    handleTerminal(status, taskId, reason) {
      if (status === 'done') {
        applyMapped(taskId, 'done', { completedAt: ports.now() });
        saveProgress(taskId, DONE_SUMMARY, 0);
        return;
      }
      if (status === 'failed') {
        const text = reason ?? '执行失败（目标节点未附因）';
        applyMapped(taskId, 'failed', { errorMessage: text });
        saveProgress(taskId, text, 0);
        return;
      }
      // interrupted：回待处理 + 摘要行呈现中断（等待续传）
      applyMapped(taskId, 'interrupted', {});
      saveProgress(taskId, INTERRUPTED_SUMMARY, 0);
    },

    markCancelled(taskId) {
      applyMapped(taskId, 'cancelled', {});
      // 终态清等待（T12 修复轮）：取消拍与 done/failed 同样整条覆盖摘要——
      // 等待中取消若无此步，kv waiting 残留会让等待卡对已取消任务误亮
      saveProgress(taskId, CANCELLED_SUMMARY, 0);
    },

    handleAnswered(evt) {
      const prev = ports.getProgress(evt.taskId);
      if (prev === null) return;
      ports.saveProgress(evt.taskId, { ...prev, answered: { decision: evt.decision, at: ports.now() } });
    },

    wrapWorkerStore(store) {
      const ensureRow = (record: DelegationRecord): void => {
        if (ports.findTaskByDelegation(record.taskId)) return; // 幂等：行已存在不重建
        const ws = ports.findWorkspaceByName(record.workspaceName);
        if (!ws) {
          logger.warn('收委派建看板行跳过：工作空间不存在', {
            taskId: record.taskId,
            workspaceName: record.workspaceName,
          });
          return;
        }
        ports.insertWorkerTaskRow({
          workspaceId: ws.id,
          title: record.title,
          status: WORKER_STATE_TO_TASK[record.state],
          routing: { mode: 'node', groupId: '', targetNodeId: ports.selfNodeId() ?? '' },
          delegationId: record.taskId,
          startedAt: ports.now(),
        });
      };
      const syncState = (taskId: string, state: DelegationRecord['state'], reason?: string): void => {
        const row = ports.findTaskByDelegation(taskId);
        if (!row) return;
        const next = WORKER_STATE_TO_TASK[state];
        if (isTerminal(row.status) && row.status !== next) return; // 终态粘滞
        const extra: Partial<TaskRow> =
          state === 'done' && row.completedAt === null ? { completedAt: ports.now() } : {};
        // P2-1 worker 侧对称面：failed 附因落 errorMessage（leader handleTerminal 同款
        // 形态——reason 缺席不写，老数据/无因失败回退现状）
        if (state === 'failed' && typeof reason === 'string') extra.errorMessage = reason;
        ports.updateTask(row.id, { status: next, ...extra });
      };
      return {
        get: (taskId) => store.get(taskId),
        upsert(record) {
          store.upsert(record);
          ensureRow(record);
        },
        updateState(taskId, state, reason) {
          store.updateState(taskId, state, reason);
          syncState(taskId, state, reason);
        },
        list: () => store.list(),
      };
    },
  };
}

// ── retryDispatch（待派发重试 / 失败重派单点）────────────────────────────────

/** 重派端口（生产接线 hub/ipc.handlers.ts——复用 dispatch-submit 调度单源） */
export interface RedispatchPorts {
  getTask(taskId: string): TaskRow | null;
  /** workspaceId → 工作空间名（委派载荷 workspaceName） */
  workspaceNameOf(workspaceId: string): string | null;
  /** 目标解析（group=pickWorker least-busy / node=锁定直发；null=无候选）；
   *  opts.team=true 时走 M5.3 版本门（指定节点拒/组内排除——与首派同闸） */
  resolveTarget(
    routing: Exclude<TaskRouting, { mode: 'local' }>,
    workspaceName: string,
    opts?: { team?: boolean },
  ): Promise<string | null>;
  /**
   * M5.3 团队快照展开（与 DispatchSubmitPorts.getTeamSnapshot 同形）：重派行带
   * targetTeamId 时重建 team 段——防「重派团队任务静默退化为单 agent 载荷」
   * （spec §3 裁定 3：不静默换班）。团队不存在/已解散 → null
   */
  getTeamSnapshot(
    workspaceId: string,
    teamId: string,
  ): { name: string; members: Array<{ agentName: string; isLeader: boolean }> } | null;
  /** 既有委派管道（leader-only；目标离线即拒 node_offline） */
  delegate(brief: DelegationTaskBrief): Promise<{ taskId: string }>;
  updateTask(id: string, patch: Partial<TaskRow>): void;
  now(): number;
}

export interface RetryDispatchResult {
  dispatched: boolean;
  nodeId: string | null;
  /** 新委派 id（dispatched=true 在场；重派=换 id，旧 id 不续用） */
  delegationId: string | null;
}

/**
 * 重派既有外派行。可重试态门控 = pending（含待派发 delegationId 空 / interrupted
 * 回落）或 failed（失败重派）；其余态人话拒。链路：复位行（pending/清 error/清旧
 * delegation_id）→ 解析目标 → 无候选留待处理不轮询（RM-M21-5）→ 派发瞬断同样
 * 留待处理（重试入口回到本函数）→ 成功回写新 delegation_id。
 *
 * M5.3 团队重派（spec §3 裁定 3——不静默换班）：行带 targetTeamId → 重新展开
 * 当前团队快照重建 team 段（重派即新派发，快照语义=派发时刻定型）+ 版本闸随
 * resolveTarget({team:true}) 与首派同构；团队已解散/形态失效 → 不派，行转
 * failed 人话（永久性失败，对齐 executor validateTarget 的「目标团队已解散」
 * 风格——非瞬断不落待处理轮询）。单 agent 行（targetTeamId 空）零变化。
 */
export async function retryDispatch(
  taskId: string,
  ports: RedispatchPorts,
  permissionTier: PermissionTier = 'confirm',
): Promise<RetryDispatchResult> {
  const row = ports.getTask(taskId);
  if (!row) throw new Error(`任务 ${taskId} 不存在`);
  if (row.routing.mode === 'local') {
    throw new Error('本机执行的任务无需派发');
  }
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new Error('仅待派发或已失败的外派任务可重派');
  }
  // M3.3 派发闸：存在未完成依赖 → 拒绝重派（blocked 为 getTask 派生态，
  // 与 executor peek / move / startTaskAndKickoff 四闸同口径）；M4.3 起文案
  // 单源迁移 task/dependency-gate.ts（submitRoutedTask / taskDelegate 直通道同引）
  if (row.blocked) {
    throw blockedDispatchError(row.blockedBy ?? []);
  }
  const workspaceName = ports.workspaceNameOf(row.workspaceId);
  if (!workspaceName) {
    throw new Error(`任务 ${taskId} 的工作空间已不存在，无法重派`);
  }
  // M5.3 团队展开先于复位（错误路径零副作用——解散/形态失效不闪 pending）：
  // 展开失败均为永久性失败 → 行转 failed 人话，不派不分流
  let teamPayload: { members: Array<{ name: string; isLeader: boolean }> } | undefined;
  if (row.targetTeamId !== null) {
    if (ports.getTeamSnapshot(row.workspaceId, row.targetTeamId) === null) {
      ports.updateTask(taskId, {
        status: 'failed',
        errorMessage: '目标团队已解散，无法重派（原派发：团队协作）',
        completedAt: ports.now(),
      });
      return { dispatched: false, nodeId: null, delegationId: null };
    }
    try {
      teamPayload = expandTeamPayload(
        { workspaceId: row.workspaceId, workspaceName, teamId: row.targetTeamId },
        ports,
      );
    } catch (err) {
      // 形态失效（成员 <2 / >8 / leader 数 ≠1——展开单源人话）
      ports.updateTask(taskId, {
        status: 'failed',
        errorMessage: `目标团队已解散，无法重派（原派发：团队协作）——${(err as Error).message}`,
        completedAt: ports.now(),
      });
      return { dispatched: false, nodeId: null, delegationId: null };
    }
  }
  // 复位先行：旧 delegation_id 属旧账本行，重派=换 id（一义一名，禁续用）
  ports.updateTask(taskId, { status: 'pending', errorMessage: null, delegationId: null });

  const targetNodeId = await ports.resolveTarget(row.routing, workspaceName, {
    team: teamPayload !== undefined,
  });
  if (targetNodeId === null) {
    return { dispatched: false, nodeId: null, delegationId: null }; // 无候选：留待处理
  }
  try {
    const { taskId: delegationId } = await ports.delegate({
      groupId: row.routing.groupId,
      targetNodeId,
      workspaceName,
      task: {
        title: row.title,
        prompt: row.description.trim() !== '' ? row.description : row.title,
        permissionTier,
        // M5.3：team 段随重派载荷重建（不带 agentSlug——协议互斥）
        ...(teamPayload !== undefined ? { team: teamPayload } : {}),
      },
    });
    // D5：重派同样回写已解析目标（group 变体换新 targetNodeId）
    const resolvedRouting: TaskRouting =
      row.routing.mode === 'group' ? { ...row.routing, targetNodeId } : row.routing;
    ports.updateTask(taskId, { delegationId, routing: resolvedRouting });
    return { dispatched: true, nodeId: targetNodeId, delegationId };
  } catch {
    // 瞬断（node_offline / 网络抖动）：行保留待处理（RM-M21-5，与 dispatch-submit 同哲学）
    return { dispatched: false, nodeId: null, delegationId: null };
  }
}
