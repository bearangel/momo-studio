// renderer/src/stores/ui.store.ts
import { create } from 'zustand';

export type ViewKey = 'im' | 'files' | 'agents' | 'marketplace' | 'settings' | 'tasks';

/** 有侧边栏的视图（单一真相源：ViewSidebar / SidebarRestoreButton / ActivityBar 共用） */
export type SidebarViewKey = 'im' | 'files' | 'tasks';
export const SIDEBAR_VIEWS: readonly SidebarViewKey[] = ['im', 'files', 'tasks'];

/** 侧边栏宽度边界（px）：拖拽钳制与持久化值校验共用（spec §5.1） */
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 260;

/** localStorage 持久化 key（spec D4）：各视图宽度 + 收起状态 */
const SIDEBAR_STORAGE_KEY = 'ui.sidebar.v1';

interface PersistedSidebarState {
  sidebarWidths: Record<SidebarViewKey, number>;
  sidebarCollapsed: boolean;
}

interface UiState {
  activeView: ViewKey;
  setActiveView: (view: ViewKey) => void;
  /** 侧边栏收起状态（v2.2 起收起=完全消失，随 ui.sidebar.v1 持久化） */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** 各视图独立宽度（px）；提交时钳制到 [MIN, MAX] */
  sidebarWidths: Record<SidebarViewKey, number>;
  setSidebarWidth: (view: SidebarViewKey, width: number) => void;
}

const clampWidth = (w: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));

const defaultWidths = (): Record<SidebarViewKey, number> => ({
  im: SIDEBAR_WIDTH_DEFAULT,
  files: SIDEBAR_WIDTH_DEFAULT,
  tasks: SIDEBAR_WIDTH_DEFAULT,
});

// 启动时读一次持久化（spec §5.1）：JSON 坏 → 全默认；单项非有限数值或超
// [MIN, MAX] → 该项回默认 260（非法值不信任、不钳制补救）
const loadPersisted = (): PersistedSidebarState => {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!raw) return { sidebarWidths: defaultWidths(), sidebarCollapsed: false };
    const parsed = JSON.parse(raw) as Partial<PersistedSidebarState>;
    const widths = defaultWidths();
    if (parsed.sidebarWidths) {
      for (const key of SIDEBAR_VIEWS) {
        const v = parsed.sidebarWidths[key];
        if (
          typeof v === 'number' &&
          Number.isFinite(v) &&
          v >= SIDEBAR_WIDTH_MIN &&
          v <= SIDEBAR_WIDTH_MAX
        ) {
          widths[key] = Math.round(v);
        }
      }
    }
    return { sidebarWidths: widths, sidebarCollapsed: parsed.sidebarCollapsed === true };
  } catch {
    return { sidebarWidths: defaultWidths(), sidebarCollapsed: false };
  }
};

// 写回持久化（跟随 file.store 手写惯例）；写失败静默，不影响内存状态
const persistSidebar = (state: Pick<UiState, 'sidebarWidths' | 'sidebarCollapsed'>): void => {
  try {
    const payload: PersistedSidebarState = {
      sidebarWidths: state.sidebarWidths,
      sidebarCollapsed: state.sidebarCollapsed,
    };
    localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage 不可用（隐私模式/配额）不阻塞交互
  }
};

const initial = loadPersisted();

export const useUiStore = create<UiState>((set) => ({
  activeView: 'im',
  setActiveView: (view) => set({ activeView: view }),
  sidebarCollapsed: initial.sidebarCollapsed,
  toggleSidebar: () =>
    set((s) => {
      const next = { sidebarCollapsed: !s.sidebarCollapsed };
      persistSidebar({ ...s, ...next });
      return next;
    }),
  sidebarWidths: initial.sidebarWidths,
  setSidebarWidth: (view, width) =>
    set((s) => {
      const next = { sidebarWidths: { ...s.sidebarWidths, [view]: clampWidth(width) } };
      persistSidebar({ ...s, ...next });
      return next;
    }),
}));
