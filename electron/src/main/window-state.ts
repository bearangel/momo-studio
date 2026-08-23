// electron/src/main/window-state.ts
//
// 窗口状态持久化（bounds + maximized）——kv_store key='window_state'。
// 独立于 electron 模块（纯 DB 读写 + 纯函数校验），便于单测。
//
// x/y 设计为可空：null 表示「无有效定位信息」（记录缺失 / clampToDisplays 剔除越界坐标），
// 调用方（window.ts）判空后交由系统默认居中定位。
import { getDb } from './storage/db';

/** 窗口状态。x/y 为 null 时表示不指定窗口位置（由系统默认定位）。 */
export interface WindowState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

/** 屏幕 workArea 矩形（screen.getAllDisplays().map(d => d.workArea) 的形状） */
export interface WorkAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const KEY = 'window_state';

/** 保存窗口状态（upsert）。 */
export function saveWindowState(s: WindowState): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(KEY, JSON.stringify(s));
}

/**
 * 读取窗口状态；无记录或记录损坏（非法 JSON / 缺宽高）时返回 null。
 * 只信任结构完整的记录——宽高缺失的半截状态直接作废。
 */
export function loadWindowState(): WindowState | null {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(KEY) as { value: string } | undefined;
  if (!row) return null;

  let parsed: Partial<WindowState>;
  try {
    parsed = JSON.parse(row.value) as Partial<WindowState>;
  } catch {
    return null;
  }

  if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null;
  return {
    x: typeof parsed.x === 'number' ? parsed.x : null,
    y: typeof parsed.y === 'number' ? parsed.y : null,
    width: parsed.width,
    height: parsed.height,
    maximized: parsed.maximized === true,
  };
}

/**
 * 越界坐标剔除（防窗口消失）：外接屏拔掉后残留的坐标可能落在所有现存屏幕之外，
 * 照搬会让窗口出现在不可见区域。左上角不在任何屏 workArea 内 → 丢弃 x/y（保留尺寸，
 * 由系统默认定位）；命中任一屏则原样返回。
 */
export function clampToDisplays(
  state: WindowState,
  displays: readonly WorkAreaRect[],
): WindowState {
  const { x, y } = state;
  if (x === null || y === null) return state;
  const visible = displays.some(
    (d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height,
  );
  if (!visible) return { ...state, x: null, y: null };
  return state;
}
