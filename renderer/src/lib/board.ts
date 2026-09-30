// renderer/src/lib/board.ts
// 看板列组装纯函数（看板重构 Task 9）：排序 / 泳道切分 / 过滤 / 组色映射。
// 全部无副作用——调用方先 sortColumn 再按列 filter，列分组是渲染层 BoardColumn 的职责。
import type { GroupRow, TaskRow, TaskStatus } from '../ipc/types';

/**
 * 终态集合（看板 done/closed 两列合并的底层状态；与 electron state-machine
 * TERMINAL 集合同步）——归档等终态限定入口（spec §5.2 终态卡片右键归档）的判定单源。
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 编辑资格（2026-09-30 用户反馈收敛）：仅 draft / pending 可编辑——任务一旦
 * 进入执行管线（assigned / session_queued / in_progress / paused）即锁定，
 * 防「已分配/进行中还能改字段」与 agent 已收到的任务简报漂移。
 * BoardCard 菜单与 TaskDetailPanel 编辑入口共用本谓词（判定单源）。
 */
export function isEditableStatus(status: TaskStatus): boolean {
  return status === 'draft' || status === 'pending';
}

/**
 * 委派目标三列任一非空——与 electron starter.hasDelegationTarget 同义
 * （spec §4.4 renderer 单源）。TaskDetailPanel / AssignTargetDialog /
 * useBoardDrop 拖拽拦截共用，禁再内联三列判断（防同义判定漂移）。
 */
export function hasDelegationTarget(t: {
  assigneeAgentId?: string | null;
  targetTeamId?: string | null;
  targetSessionId?: string | null;
}): boolean {
  return t.assigneeAgentId != null || t.targetTeamId != null || t.targetSessionId != null;
}

/**
 * 列内排序（2026-09-30 排序模型收敛，迁移 050）：
 *   1. 顶置组在前——pinnedAt 倒序（最近 pin 的最顶）
 *   2. 未顶置组在后——createdAt 倒序（后创建的排前面，新建任务天然可见）
 * 排序规则单点：boardPosition 退役后无跨端排序双实现（electron move 不再算落点）。
 * 返回新数组，不修改输入。
 */
export function sortColumn(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    if (a.pinnedAt !== null && b.pinnedAt !== null) return b.pinnedAt - a.pinnedAt;
    if (a.pinnedAt !== null) return -1; // 顶置在前
    if (b.pinnedAt !== null) return 1;
    return b.createdAt - a.createdAt; // 未顶置：createdAt 倒序
  });
}

/** 泳道（BoardLane）：一个组（或未分组）+ 其归属任务 */
export interface BoardLane {
  /** 组行；null=未分组道 / 平铺单道 */
  group: GroupRow | null;
  /** 组内任务（保持输入序——列内序由调用方的 sortColumn 决定） */
  tasks: TaskRow[];
}

/**
 * 按组切分泳道。
 * - lanes：活跃组按 position 升序各成道（空组保留），未分组（groupId=null）垫底为 group:null 道；
 *   归属未知组 id 的任务也归入未分组道（防御：组刚被删但任务行还带旧 id）。
 * - flat：单道全量（group:null），保持输入序。
 * 只按组切分，不排序不滤列。
 */
export function splitLanes(
  tasks: TaskRow[],
  groups: GroupRow[],
  mode: 'lanes' | 'flat',
): BoardLane[] {
  if (mode === 'flat') return [{ group: null, tasks }];

  const ordered = [...groups].sort((a, b) => a.position - b.position);
  const byGroup = new Map<string | null, TaskRow[]>();
  for (const t of tasks) {
    const key = t.groupId !== null && ordered.some((g) => g.id === t.groupId) ? t.groupId : null;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(t);
    else byGroup.set(key, [t]);
  }
  const lanes: BoardLane[] = ordered.map((g) => ({
    group: g,
    tasks: byGroup.get(g.id) ?? [],
  }));
  const ungrouped = byGroup.get(null);
  if (ungrouped && ungrouped.length > 0) lanes.push({ group: null, tasks: ungrouped });
  return lanes;
}

/** 看板过滤条件：文本 AND 指派人（字段空值表示该维度不过滤） */
export interface BoardTaskFilter {
  /** 不区分大小写包含 title 或 description；空串不过滤 */
  text: string;
  /** 匹配 assigneeAgentId；null 不过滤 */
  assigneeId: string | null;
}

/**
 * 看板任务过滤：text 命中 title/description（不区分大小写包含）AND assigneeId 匹配。
 */
export function filterBoardTasks(tasks: TaskRow[], filter: BoardTaskFilter): TaskRow[] {
  const needle = filter.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.assigneeId !== null && t.assigneeAgentId !== filter.assigneeId) return false;
    if (needle === '') return true;
    return t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle);
  });
}

/** 语义色名 → inline style 颜色串（token 单源，spec §5）；未知名返回 null 由调用方回退 */
const GROUP_COLOR_VARS: Record<string, string> = {
  accent: 'rgb(var(--accent-500))',
  success: 'rgb(var(--status-success))',
  warning: 'rgb(var(--status-warning))',
  error: 'rgb(var(--status-error))',
  violet: 'rgb(var(--status-violet))',
};

/** 自定义组色格式：6 位小写 hex（入库约定小写，UX 波 2 #5） */
const GROUP_HEX_RE = /^#[0-9a-f]{6}$/;

/** 是否为自定义组色 hex（#rrggbb，小写）；类型谓词收窄 null */
export function isGroupHexColor(color: string | null): color is string {
  return color !== null && GROUP_HEX_RE.test(color);
}

/**
 * 组色语义名或自定义 hex 映射为 CSS 颜色串。
 * - hex（^#[0-9a-f]{6}$）→ 原值直返（用户内容色，豁免设计系统 inline 色禁令）
 * - null 或未知名 → null（调用方自定回退，如中性色）
 */
export function groupColorStyle(color: string | null): string | null {
  if (color === null) return null;
  if (isGroupHexColor(color)) return color;
  return GROUP_COLOR_VARS[color] ?? null;
}

/** 语义色名 → hex（亮色主题值，与 globals.css :root 同源）——仅作应用内取色器初始值 */
const GROUP_COLOR_HEX: Record<string, string> = {
  accent: '#5e6ad2',
  violet: '#6e56cf',
  success: '#23835c',
  warning: '#b7791f',
  error: '#d33f49',
};

/** 取色器初始值兜底（无色/未知色）：与 accent-500 同值的靛蓝 */
const DEFAULT_PICKER_COLOR = '#5e6ad2';

/**
 * 组色 → 应用内取色器（react-colorful）初始 hex。
 * - 自定义 hex → 原值
 * - 语义名 → 亮色主题 hex（暗色值不同，但取色器只作选色起点无须跟随主题）
 * - null / 未知名 → 兜底靛蓝 #5e6ad2（与 accent-500 同值）
 */
export function groupColorHex(color: string | null): string {
  if (isGroupHexColor(color)) return color;
  return GROUP_COLOR_HEX[color ?? ''] ?? DEFAULT_PICKER_COLOR;
}

/** 组色 chip 配色：前景（文字/边框）+ 低透明底（透明度量级对齐 --status-*-tint） */
export interface GroupChipColor {
  fg: string;
  bg: string;
}

/**
 * 组色 → 平铺模式组 chip 配色（UX 波 2 #7）：
 * - hex → 前景原值 / 底色原值 + '22' alpha（≈13%，双主题下低透明底保可读）
 * - 语义名 → 前景 rgb(var(--x-500)) / 底色 color-mix 14% 透明
 * - null / 未知名 → null（调用方回退中性样式）
 * 用户内容色豁免设计系统禁 inline 色（UI chrome 才受限）。
 */
export function groupChipColor(color: string | null): GroupChipColor | null {
  if (color !== null && GROUP_HEX_RE.test(color)) {
    return { fg: color, bg: `${color}22` };
  }
  const base = color === null ? null : (GROUP_COLOR_VARS[color] ?? null);
  if (base === null) return null;
  return { fg: base, bg: `color-mix(in srgb, ${base} 14%, transparent)` };
}
