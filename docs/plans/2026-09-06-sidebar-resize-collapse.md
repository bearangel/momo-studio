# 统一侧边栏宽度调整与完全收起 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话/文件/看板统一侧边栏支持拖拽调宽（200–480px、双击重置）+ 完全收起（顶行内联恢复按钮）+ 三视图独立宽度与收起状态的 localStorage 持久化。

**Architecture:** 状态集中在 `ui.store`（`sidebarWidths` + `sidebarCollapsed`，手写 localStorage 持久化，key `ui.sidebar.v1`）；`Sidebar.tsx` 改为展开态外壳（36px 头部行 + 4px 拖拽分隔条，拖拽本地预览、pointerup 一次提交）；收起判定上移 `ViewSidebar`（收起 = 渲染 null）；恢复按钮 `SidebarRestoreButton` 内联停靠三个视图主区顶行首位。

**Tech Stack:** React 18 + zustand + Tailwind（v2.1 语义 token）+ lucide-react + vitest/jsdom + @testing-library/react。

**Spec:** `docs/specs/2026-09-06-sidebar-resize-collapse-design.md`（已批准）

## Global Constraints

- Node 20 LTS：容器内先 `nvm use 20`（Node 26 破坏 better-sqlite3 native binding）
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（普通收窄 `as` 允许）
- renderer 新代码只用语义 token（`bg-surface-*` / `text-tertiary` / `border-subtle` / `bg-accent-500` 等），禁标准 Tailwind 色阶类与 inline 硬编码颜色；图标一律 lucide-react，16px / stroke 1.75
- 单测贴源 colocated：测试文件与源码同目录（`renderer/vitest.config.ts` 显式 `include: ['src/**/*.test.{ts,tsx}']`）
- 所有代码注释使用中文；Conventional Commits（`feat:` / `test:` 等）
- 单文件测试命令：`cd renderer && npx pnpm@9.0.0 vitest run src/<路径>`；全套：`npx pnpm@9.0.0 --filter momo-studio-renderer test`
- jsdom 无 `setPointerCapture` / PointerEvent 构造器：实现必须 try/catch guard，拖拽 move/up 监听挂 `window`（与真实 DOM pointer capture 语义等价，保证两环境一致）
- mock 规范遵循 `.opencode/skills/momo-test-rules`：store 用真实 zustand store（`setState` 重置），不做接口简化；持久化加载测试用「预置 localStorage + 动态 import」仿真真实启动

---

### Task 1: ui.store — 宽度状态 + clamp + localStorage 持久化

**Files:**
- Modify: `renderer/src/stores/ui.store.ts`（全量重写，现文件仅 19 行）
- Test: `renderer/src/stores/ui.store.test.ts`（新建）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces（后续任务依赖，名称精确）:
  - `type SidebarViewKey = 'im' | 'files' | 'tasks'`
  - `const SIDEBAR_VIEWS: readonly SidebarViewKey[]`
  - `const SIDEBAR_WIDTH_MIN = 200` / `SIDEBAR_WIDTH_MAX = 480` / `SIDEBAR_WIDTH_DEFAULT = 260`
  - `sidebarWidths: Record<SidebarViewKey, number>`（store 字段）
  - `setSidebarWidth: (view: SidebarViewKey, width: number) => void`（store action，内部 clamp + 持久化）
  - localStorage key `ui.sidebar.v1`，值 `{ sidebarWidths, sidebarCollapsed }`

- [ ] **Step 1: 写失败测试**

```ts
// renderer/src/stores/ui.store.test.ts
//
// ui.store 侧边栏状态测试（v2.2）：
// - 默认宽度 260 × 3、collapsed false；localStorage 预置值恢复
// - 非法持久化值（超范围/类型错/JSON 坏）→ 该项回默认 260
// - setSidebarWidth 钳制 [200, 480] 并四舍五入；写 round-trip
// - toggleSidebar 持久化；localStorage 写失败静默
//
// 加载语义测试用「预置 localStorage + vi.resetModules + 动态 import」仿真真实启动
//（store 初始值在模块加载时从 localStorage 读一次）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const STORAGE_KEY = 'ui.sidebar.v1';

async function loadStore(): Promise<typeof import('./ui.store')> {
  vi.resetModules();
  return await import('./ui.store');
}

const seed = (widths: unknown, collapsed?: boolean): void => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sidebarWidths: widths, sidebarCollapsed: collapsed ?? false }),
  );
};

describe('ui.store 侧边栏宽度与收起持久化', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('无持久化时：三视图默认 260px，未收起', async () => {
    const { useUiStore, SIDEBAR_WIDTH_DEFAULT } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({
      im: SIDEBAR_WIDTH_DEFAULT,
      files: SIDEBAR_WIDTH_DEFAULT,
      tasks: SIDEBAR_WIDTH_DEFAULT,
    });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('持久化的合法宽度与收起状态在启动时恢复', async () => {
    seed({ im: 320, files: 200, tasks: 480 }, true);
    const { useUiStore } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({ im: 320, files: 200, tasks: 480 });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('超范围/类型错的持久化项回默认 260，合法项保留', async () => {
    seed({ im: 150, files: 999, tasks: 'abc' });
    const { useUiStore, SIDEBAR_WIDTH_DEFAULT } = await loadStore();
    expect(useUiStore.getState().sidebarWidths).toEqual({
      im: SIDEBAR_WIDTH_DEFAULT,
      files: SIDEBAR_WIDTH_DEFAULT,
      tasks: SIDEBAR_WIDTH_DEFAULT,
    });
  });

  it('JSON 坏 / 字段缺失 → 全默认', async () => {
    localStorage.setItem(STORAGE_KEY, '{not-json');
    const mod1 = await loadStore();
    expect(mod1.useUiStore.getState().sidebarWidths.im).toBe(mod1.SIDEBAR_WIDTH_DEFAULT);

    localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
    const mod2 = await loadStore();
    expect(mod2.useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setSidebarWidth 钳制到 [200, 480] 并四舍五入，且写回 localStorage', async () => {
    const { useUiStore } = await loadStore();
    useUiStore.getState().setSidebarWidth('files', 199);
    useUiStore.getState().setSidebarWidth('im', 481);
    useUiStore.getState().setSidebarWidth('tasks', 300.6);

    const s = useUiStore.getState().sidebarWidths;
    expect(s).toEqual({ im: 480, files: 200, tasks: 301 });

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(persisted.sidebarWidths).toEqual({ im: 480, files: 200, tasks: 301 });
  });

  it('toggleSidebar 翻转并持久化收起状态', async () => {
    const { useUiStore } = await loadStore();
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').sidebarCollapsed).toBe(true);
  });

  it('localStorage 写失败静默，内存状态照常更新', async () => {
    const { useUiStore } = await loadStore();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => useUiStore.getState().setSidebarWidth('im', 300)).not.toThrow();
    expect(useUiStore.getState().sidebarWidths.im).toBe(300);
    expect(() => useUiStore.getState().toggleSidebar()).not.toThrow();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/ui.store.test.ts`
Expected: FAIL（`sidebarWidths` 不存在于 `UiState`，编译/断言失败）

- [ ] **Step 3: 实现 ui.store**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/ui.store.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add renderer/src/stores/ui.store.ts renderer/src/stores/ui.store.test.ts
git commit -m "feat: ui.store 侧边栏宽度状态与 localStorage 持久化"
```

---

### Task 2: Sidebar.tsx — 头部行 + 拖拽分隔条重构

**Files:**
- Modify: `renderer/src/components/layout/Sidebar.tsx`（全量重写，现文件 47 行）
- Test: `renderer/src/components/layout/Sidebar.test.tsx`（新建，现状无覆盖）

**Interfaces:**
- Consumes: Task 1 的 `SIDEBAR_WIDTH_MIN/MAX/DEFAULT`
- Produces: `Sidebar({ label, width, onWidthCommit, onCollapse, children })`——props 移除旧 `collapsed` / `icon` / `onToggle`；`onWidthCommit` 在拖拽 pointerup/pointercancel 与双击重置时调用（每次手势恰好一次）

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/layout/Sidebar.test.tsx
//
// Sidebar 展开态外壳测试（v2.2）：
// - 宽度 props 驱动；头部行（标题 + 收起按钮）
// - 拖拽：pointerdown → window pointermove 实时预览（角标）→ pointerup 一次提交
// - 钳制 200–480；触界角标「最小/最大」；pointercancel 同 up 提交；双击重置 260
// - 拖拽期间不调用 onWidthCommit（预览不写 store，spec §5.3）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const baseProps = {
  label: '会话',
  width: 260,
  onWidthCommit: vi.fn(),
  onCollapse: vi.fn(),
};

const renderSidebar = (props: Partial<typeof baseProps> = {}) =>
  render(<Sidebar {...baseProps} {...props}>内容</Sidebar>);

describe('Sidebar', () => {
  it('宽度由 props 驱动，渲染头部行标题与收起按钮', () => {
    renderSidebar({ width: 320 });
    expect(screen.getByTestId('view-sidebar').style.width).toBe('320px');
    expect(screen.getByText('会话')).toBeInTheDocument();
    expect(screen.getByLabelText('收起侧边栏')).toBeInTheDocument();
  });

  it('点击收起按钮调用 onCollapse', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('收起侧边栏'));
    expect(baseProps.onCollapse).toHaveBeenCalledTimes(1);
  });

  it('拖拽：down→move 实时预览（角标 350），up 一次提交 350', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    // 预览阶段：宽度已变 + 角标显示，但未提交
    expect(screen.getByTestId('view-sidebar').style.width).toBe('310px');
    expect(screen.getByTestId('sidebar-width-badge').textContent).toBe('310 px');
    expect(onWidthCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 150 });
    expect(onWidthCommit).toHaveBeenCalledTimes(1);
    expect(onWidthCommit).toHaveBeenCalledWith(310);
  });

  it('拖拽钳制：超出上限角标提示「最大」，提交 480', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ width: 400, onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 2000 });
    expect(screen.getByTestId('sidebar-width-badge').textContent).toBe('480 px · 最大');
    expect(screen.getByTestId('view-sidebar').style.width).toBe('480px');

    fireEvent.pointerUp(window, { clientX: 2000 });
    expect(onWidthCommit).toHaveBeenCalledWith(480);
  });

  it('拖拽钳制：低于下限提交 200', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: -500 });
    fireEvent.pointerUp(window, { clientX: -500 });
    expect(onWidthCommit).toHaveBeenCalledWith(200);
  });

  it('pointercancel 与 pointerup 同路径提交当前预览宽度', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ onWidthCommit });

    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 60 });
    fireEvent.pointerCancel(window);
    expect(onWidthCommit).toHaveBeenCalledTimes(1);
    expect(onWidthCommit).toHaveBeenCalledWith(220);
  });

  it('双击分隔条重置默认 260', () => {
    const onWidthCommit = vi.fn();
    renderSidebar({ width: 400, onWidthCommit });

    fireEvent.doubleClick(screen.getByTestId('sidebar-resizer'));
    expect(onWidthCommit).toHaveBeenCalledWith(260);
  });

  it('拖拽中 children 仍渲染（不卸载）', () => {
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId('sidebar-resizer'), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(screen.getByText('内容')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/Sidebar.test.tsx`
Expected: FAIL（新 props / testid 不存在，或模块编译失败）

- [ ] **Step 3: 实现 Sidebar**

```tsx
// renderer/src/components/layout/Sidebar.tsx
//
// 侧边栏容器（v2.2 宽度拖拽 + 完全收起改造）：ViewSidebar 的展开态外壳。
// - 顶部 36px 头部行：视图标题 + 收起按钮（PanelLeftClose）
// - 右缘 4px 分隔条：拖拽调宽（本地预览，pointerup/pointercancel 一次提交 onWidthCommit）；
//   双击重置默认 260
// - 收起态（完全消失）由 ViewSidebar 判定 return null，本组件不再渲染 48px 图标轨
//
// 拖拽 move/up 监听挂 window：真实 DOM 中 setPointerCapture 后事件仍冒泡到 window，
// jsdom 无 capture API（try/catch guard），两环境语义一致——移出侧边栏仍可跟踪。
import { useRef, useState, type ReactNode } from 'react';
import { PanelLeftClose } from 'lucide-react';
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../../stores/ui.store';

interface SidebarProps {
  label: string;
  /** 当前宽度（px），来自 ui.store.sidebarWidths[view] */
  width: number;
  /** 拖拽结束 / 双击重置时提交新宽度（ViewSidebar 绑 setSidebarWidth） */
  onWidthCommit: (width: number) => void;
  /** 头部收起按钮回调（ViewSidebar 绑 toggleSidebar） */
  onCollapse: () => void;
  children?: ReactNode;
}

const clampWidth = (w: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));

export function Sidebar({ label, width, onWidthCommit, onCollapse, children }: SidebarProps) {
  // 拖拽本地预览宽度：null = 非拖拽。拖拽期间不写 store（避免每帧 setState + localStorage）
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  // 手势上下文：起点 clientX / 起始宽度；lastX 记录最新位置供 up 时提交
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const lastX = useRef(0);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragStart.current = { x: e.clientX, width };
    lastX.current = e.clientX;
    // 真实 DOM：锁定指针；jsdom 无此 API，guard 调用
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom: setPointerCapture not implemented */
    }
    const onMove = (ev: PointerEvent): void => {
      if (!dragStart.current) return;
      lastX.current = ev.clientX;
      setPreviewWidth(clampWidth(dragStart.current.width + ev.clientX - dragStart.current.x));
    };
    // up / cancel 同路径：提交最新预览宽度（spec §6）
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const start = dragStart.current;
      dragStart.current = null;
      setPreviewWidth(null);
      if (start) onWidthCommit(clampWidth(start.width + lastX.current - start.x));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const effectiveWidth = previewWidth ?? width;

  return (
    <div
      data-testid="view-sidebar"
      className={`relative shrink-0 border-r border-subtle bg-surface-1 flex overflow-hidden ${
        previewWidth !== null ? 'select-none' : ''
      }`}
      style={{ width: effectiveWidth }}
    >
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 头部行（spec §5.5）：视图标题 + 收起按钮 */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-subtle pl-3.5 pr-1.5">
          <span className="text-xs font-medium text-secondary">{label}</span>
          <button
            type="button"
            aria-label="收起侧边栏"
            title="收起侧边栏（Ctrl/Cmd+B）"
            onClick={onCollapse}
            className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
          >
            <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">{children}</div>
      </div>
      {/* 拖拽分隔条（spec §5.3） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度（双击重置默认宽度）"
        data-testid="sidebar-resizer"
        onPointerDown={handlePointerDown}
        onDoubleClick={() => onWidthCommit(SIDEBAR_WIDTH_DEFAULT)}
        className={`w-1 shrink-0 cursor-col-resize touch-none transition-colors ${
          previewWidth !== null ? 'bg-accent-500' : 'bg-subtle hover:bg-accent-500'
        }`}
      />
      {/* 拖拽宽度角标：跟随分隔条位置，触界提示最小/最大 */}
      {previewWidth !== null && (
        <div
          data-testid="sidebar-width-badge"
          className="absolute top-2 z-10 -translate-x-1/2 rounded-md border border-accent-500 bg-surface-3 px-2 py-0.5 font-mono text-xs text-primary"
          style={{ left: effectiveWidth - 2 }}
        >
          {previewWidth}
          {previewWidth === SIDEBAR_WIDTH_MIN
            ? ' px · 最小'
            : previewWidth === SIDEBAR_WIDTH_MAX
              ? ' px · 最大'
              : ' px'}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/Sidebar.test.tsx`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/layout/Sidebar.tsx renderer/src/components/layout/Sidebar.test.tsx
git commit -m "feat: Sidebar 拖拽调宽分隔条与头部收起按钮"
```

---

### Task 3: ViewSidebar — 完全收起 + 宽度接线

**Files:**
- Modify: `renderer/src/components/layout/ViewSidebar.tsx`
- Test: `renderer/src/components/layout/ViewSidebar.test.tsx`（更新：48px 折叠轨断言改为「收起即消失」，删除折叠轨图标测试）

**Interfaces:**
- Consumes: Task 1 的 `SIDEBAR_VIEWS` / `SIDEBAR_WIDTH_DEFAULT` / `sidebarWidths` / `setSidebarWidth`；Task 2 的 `Sidebar` 新 props
- Produces: 无（叶子组件）

- [ ] **Step 1: 更新测试（先失败）**

对 `ViewSidebar.test.tsx` 做三处修改：

1. `beforeEach` 增加宽度重置（zustand setState 是 merge，跨用例隔离）：

```ts
beforeEach(() => {
  useUiStore.setState({
    activeView: 'im',
    sidebarCollapsed: false,
    sidebarWidths: { im: 260, files: 260, tasks: 260 },
  });
});
```

2. 将「折叠态 48px 仅显示当前视图图标…」用例（68–84 行）**整体替换**为：

```ts
it('收起时完全消失（不再渲染 48px 图标轨），内容不渲染', () => {
  useUiStore.setState({ sidebarCollapsed: true });
  const { container } = render(<ViewSidebar />);
  expect(container.firstChild).toBeNull();
  expect(screen.queryByTestId('room-list-stub')).not.toBeInTheDocument();
});

it('宽度从 store 透传到 Sidebar（视图独立宽度）', () => {
  useUiStore.setState({ sidebarWidths: { im: 320, files: 260, tasks: 260 } });
  render(<ViewSidebar />);
  expect(screen.getByTestId('view-sidebar').style.width).toBe('320px');

  // 切到 files 视图：宽度独立
  useUiStore.setState({ activeView: 'files' });
  const view = render(<ViewSidebar />);
  expect(view.getByTestId('view-sidebar').style.width).toBe('260px');
});
```

3. **删除**「折叠态图标跟随视图：files → Folder / tasks → SquareKanban」用例（86–94 行，折叠轨已废弃）。

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/ViewSidebar.test.tsx`
Expected: FAIL（收起用例——现在渲染的是 48px 折叠轨非 null；宽度用例——`sidebarWidths` 透传未实现）

- [ ] **Step 3: 实现 ViewSidebar**

全量替换组件主体（头部 import 增删同步调整）：

```tsx
// renderer/src/components/layout/ViewSidebar.tsx
//
// 统一侧边栏：按 activeView 分发侧边栏内容。
//   im → RoomList；files → FileTree（onSelectFile 内部直连 editor.store + ipc）；
//   tasks → TaskSidebarPanel；agents/marketplace/settings → null（主区全宽）。
// v2.2：收起 = 完全消失（return null，废弃 48px 图标轨）；宽度从 ui.store.sidebarWidths
// 按视图独立透传；拖拽提交绑 setSidebarWidth。Ctrl/Cmd+B 监听仍在 MainLayout。
import { useCallback } from 'react';
import { useUiStore, SIDEBAR_VIEWS, SIDEBAR_WIDTH_DEFAULT, type SidebarViewKey } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { ipc } from '../../ipc/client';
import { RoomList } from '../im/RoomList';
import { SessionSidebarHeader } from '../im/SessionSidebarHeader';
import { FileTree } from '../files/FileTree';
import { TaskSidebarPanel } from '../task-board/TaskSidebarPanel';
import { Sidebar } from './Sidebar';

/** 有侧边栏的三个视图的文案（VIEW_META 同时承担「哪些视图有侧边栏」判定） */
const VIEW_LABELS: Partial<Record<string, string>> = {
  im: '会话',
  files: '文件',
  tasks: '看板',
};

export function ViewSidebar() {
  const activeView = useUiStore((s) => s.activeView);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  // 非侧边栏视图取默认值兜底（下方 label 判定后不会用到）
  const width = useUiStore((s) =>
    (SIDEBAR_VIEWS as readonly string[]).includes(s.activeView)
      ? s.sidebarWidths[s.activeView as SidebarViewKey]
      : SIDEBAR_WIDTH_DEFAULT,
  );
  const workspace = useWorkspaceStore((s) => s.getActive());
  const openFile = useEditorStore((s) => s.openFile);

  // 与 MiddlePanel 原 files 分支逻辑一致：IPC 读文件 → 打开编辑器 tab
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const content = await ipc.file.read(workspace.id, filePath);
      openFile(filePath, content);
    },
    [workspace, openFile],
  );

  const label = VIEW_LABELS[activeView];
  // 无侧边栏视图（agents/marketplace/settings）或收起 → 完全消失
  if (!label || collapsed) return null;
  const viewKey = activeView as SidebarViewKey;

  return (
    <Sidebar
      label={label}
      width={width}
      onWidthCommit={(w) => setSidebarWidth(viewKey, w)}
      onCollapse={toggleSidebar}
    >
      {activeView === 'im' && (
        // 会话区：头部双常驻入口（⚡/👥，spec §6.2）+ 列表（图标语义派生）
        <>
          <SessionSidebarHeader />
          <RoomList />
        </>
      )}
      {activeView === 'files' && <FileTree onSelectFile={handleSelectFile} />}
      {activeView === 'tasks' && <TaskSidebarPanel />}
    </Sidebar>
  );
}
```

注意：旧实现的 `MessageSquare, Folder, SquareKanban` lucide 图标与 `VIEW_META` 结构随折叠轨一并移除（图标职责已归活动栏）。

- [ ] **Step 4: 运行确认通过（含 Sidebar 测试无回归）**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/ViewSidebar.test.tsx src/components/layout/Sidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/layout/ViewSidebar.tsx renderer/src/components/layout/ViewSidebar.test.tsx
git commit -m "feat: ViewSidebar 完全收起与按视图独立宽度接线"
```

---

### Task 4: SidebarRestoreButton — 顶行内联恢复按钮 + 三视图插入

**Files:**
- Create: `renderer/src/components/layout/SidebarRestoreButton.tsx`
- Test: `renderer/src/components/layout/SidebarRestoreButton.test.tsx`
- Modify: `renderer/src/components/editor/CodeEditor.tsx`（tablist 首位 + 空态顶行）
- Modify: `renderer/src/components/layout/MiddlePanel.tsx:69`（im 会话头部首位）
- Modify: `renderer/src/components/task-board/TaskBoardView.tsx:80`（状态栏首位）

**Interfaces:**
- Consumes: Task 1 的 `SIDEBAR_VIEWS` / `sidebarCollapsed` / `toggleSidebar` / `activeView`
- Produces: `<SidebarRestoreButton />`（无 props，自读 store）

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/layout/SidebarRestoreButton.test.tsx
//
// 恢复按钮（方案 A 顶行内联停靠）测试：仅「收起 + 侧边栏视图」渲染，点击恢复。
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarRestoreButton } from './SidebarRestoreButton';
import { useUiStore } from '../../stores/ui.store';

describe('SidebarRestoreButton', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
  });

  it('未收起时不渲染', () => {
    const { container } = render(<SidebarRestoreButton />);
    expect(container.firstChild).toBeNull();
  });

  it.each(['agents', 'marketplace', 'settings'] as const)(
    '收起但 %s 视图（无侧边栏）不渲染',
    (view) => {
      useUiStore.setState({ activeView: view, sidebarCollapsed: true });
      const { container } = render(<SidebarRestoreButton />);
      expect(container.firstChild).toBeNull();
    },
  );

  it.each(['im', 'files', 'tasks'] as const)('收起 + %s 视图渲染，点击恢复', (view) => {
    useUiStore.setState({ activeView: view, sidebarCollapsed: true });
    render(<SidebarRestoreButton />);
    fireEvent.click(screen.getByLabelText('展开侧边栏'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/SidebarRestoreButton.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现组件**

```tsx
// renderer/src/components/layout/SidebarRestoreButton.tsx
//
// 收起恢复按钮（v2.2 方案 A 顶行内联停靠，spec D3）：仅当侧边栏收起且当前
// 视图有侧边栏时渲染，作为各视图主区顶行第一个元素参与 flex 布局（文件视图
// = tab 行首位，tab 依次右移，零遮挡）。自读 ui.store，无 props。
import { PanelLeftOpen } from 'lucide-react';
import { SIDEBAR_VIEWS, useUiStore } from '../../stores/ui.store';

export function SidebarRestoreButton() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeView = useUiStore((s) => s.activeView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  if (!collapsed || !(SIDEBAR_VIEWS as readonly string[]).includes(activeView)) return null;

  return (
    <button
      type="button"
      aria-label="展开侧边栏"
      title="展开侧边栏（Ctrl/Cmd+B）"
      data-testid="sidebar-restore-btn"
      onClick={toggleSidebar}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-3 hover:text-primary"
    >
      <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/SidebarRestoreButton.test.tsx`
Expected: PASS

- [ ] **Step 5: 三处插入（每处一行 JSX + 一行 import）**

**5a. `CodeEditor.tsx`**——import 区加：

```ts
import { SidebarRestoreButton } from '../layout/SidebarRestoreButton';
```

空态分支（`tabs.length === 0`）改为（补顶行，保证空态也有恢复入口，spec §6）：

```tsx
  // 无 tab 时显示空状态（v2.2：顶部补恢复按钮行，收起时侧边栏入口不丢失）
  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex h-[30px] shrink-0 items-center border-b border-subtle bg-surface-1 px-1.5">
          <SidebarRestoreButton />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={File} title="双击文件打开编辑器" />
        </div>
      </div>
    );
  }
```

tab 栏容器（`role="tablist"` 的 div）**第一个子元素**插入：

```tsx
      <div role="tablist" className="flex bg-surface-1 border-b border-subtle overflow-x-auto">
        {/* 收起时恢复按钮停靠 tab 行首位（参与 flex 布局，tab 右移不遮挡，spec D3） */}
        <SidebarRestoreButton />
        {tabs.map((tab) => {
```

**5b. `MiddlePanel.tsx`**——im 分支会话头部首位（69 行 div 内第一个子元素）：

```tsx
          {/* 会话头部：会话名 + 工具上限徽标（收起时首位停靠恢复按钮） */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-subtle bg-surface-1">
            <SidebarRestoreButton />
            <span className="text-sm text-primary truncate flex-1">
```

（import 区相应加 `import { SidebarRestoreButton } from './SidebarRestoreButton';`）

**5c. `TaskBoardView.tsx`**——顶部状态栏改为「标题组 + 并发」两组，避免 `justify-between` 三元素把标题挤到中间：

```tsx
      {/* 顶部状态栏：标题 + 并发/排队（收起时首位停靠恢复按钮） */}
      <div className="flex items-center justify-between p-3 border-b border-subtle shrink-0">
        <div className="flex items-center gap-1.5">
          <SidebarRestoreButton />
          <h2 className="text-lg font-medium">任务看板</h2>
        </div>
        <div className="text-xs text-tertiary">
          并发: {concurrency.active}/{concurrency.max}　排队: {concurrency.queued}
        </div>
      </div>
```

（import 区相应加 `import { SidebarRestoreButton } from '../layout/SidebarRestoreButton';`）

- [ ] **Step 6: 三处插入的类型与编译验证**

Run: `cd renderer && npx pnpm@9.0.0 typecheck`
Expected: 无错误退出（exit 0）

- [ ] **Step 7: 提交**

```bash
git add renderer/src/components/layout/SidebarRestoreButton.tsx renderer/src/components/layout/SidebarRestoreButton.test.tsx renderer/src/components/editor/CodeEditor.tsx renderer/src/components/layout/MiddlePanel.tsx renderer/src/components/task-board/TaskBoardView.tsx
git commit -m "feat: 侧边栏恢复按钮顶行内联停靠（会话/文件/看板三视图）"
```

---

### Task 5: ActivityBar — 收起时点击当前视图恢复

**Files:**
- Modify: `renderer/src/components/layout/ActivityBar.tsx`
- Test: `renderer/src/components/layout/ActivityBar.test.tsx`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SIDEBAR_VIEWS` / `sidebarCollapsed` / `toggleSidebar`
- Produces: 无

- [ ] **Step 1: 追加失败测试**

在 `ActivityBar.test.tsx` 的 describe 末尾追加：

```ts
  it('收起时点击当前侧边栏视图图标 → 恢复侧边栏（视图不变）', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: true });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('会话'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().activeView).toBe('im');
  });

  it('收起时点击其它侧边栏视图 → 正常切换视图，保持收起', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: true });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('文件'));
    expect(useUiStore.getState().activeView).toBe('files');
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('未收起时点击当前视图 → no-op（不切换不恢复）', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('会话'));
    expect(useUiStore.getState().activeView).toBe('im');
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/ActivityBar.test.tsx`
Expected: FAIL（第一个新用例——现状点击当前视图为 no-op，collapsed 保持 true）

- [ ] **Step 3: 实现**

`ActivityBar` 组件替换为（import 区加 `SIDEBAR_VIEWS`）：

```tsx
export function ActivityBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  // 收起状态下点击「当前侧边栏视图」图标 → 恢复侧边栏（v2.2 恢复入口之三）；
  // 其余情况正常切换视图
  const handleSelect = (view: ViewKey): void => {
    if (
      view === activeView &&
      useUiStore.getState().sidebarCollapsed &&
      (SIDEBAR_VIEWS as readonly string[]).includes(view)
    ) {
      toggleSidebar();
      return;
    }
    setActiveView(view);
  };

  return (
    <nav
      className="shrink-0 border-r border-subtle bg-surface-1 flex flex-col items-center py-2.5 gap-1"
      style={{ width: 48 }}
      aria-label="活动栏"
    >
      {MAIN_ITEMS.map((item) => (
        <ActivityButton
          key={item.key}
          item={item}
          active={activeView === item.key}
          onSelect={handleSelect}
        />
      ))}
      <div className="flex-1" />
      <ActivityButton
        item={SETTINGS_ITEM}
        active={activeView === SETTINGS_ITEM.key}
        onSelect={handleSelect}
      />
    </nav>
  );
}
```

（`ActivityButton` 与 `MAIN_ITEMS` 等其余部分不动。）

- [ ] **Step 4: 运行确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/ActivityBar.test.tsx`
Expected: PASS（原 4 用例 + 新 3 用例）

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/layout/ActivityBar.tsx renderer/src/components/layout/ActivityBar.test.tsx
git commit -m "feat: 活动栏点击当前视图恢复收起的侧边栏"
```

---

### Task 6: 收官验证

**Files:**
- 无新改动（验证型任务；若验证暴露问题，回到对应 Task 修复后重跑）

**Interfaces:**
- Consumes: Task 1–5 全部
- Produces: 验收结论

- [ ] **Step 1: renderer 全套测试**

Run: `npx pnpm@9.0.0 --filter momo-studio-renderer test`
Expected: 全绿零失败（既有 548+ 基线 + 本次新增约 20 用例；若有失败，区分本次改动 vs 预存——只修本次引入的）

- [ ] **Step 2: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: electron + renderer 双 clean（electron 未改动，防意外波及）

- [ ] **Step 3: 对照 spec 验收标准逐条核对**

对照 `docs/specs/2026-09-06-sidebar-resize-collapse-design.md` §8 的 7 条：
1. 三视图拖拽调宽 200–480 / 越界钳制提示 / 双击重置 → Task 2 测试覆盖
2. Ctrl/Cmd+B 或头部按钮收起后完全消失 → Task 3 测试 + MainLayout 既有监听（无改动）
3. 收起后三视图顶行恢复按钮（含文件空态）→ Task 4 测试 + 插入
4. 活动栏点击当前视图恢复 → Task 5 测试
5. 独立宽度 + 收起状态重启保持 → Task 1 持久化测试
6. 文件 tab 不被遮挡 → 方案 A 按钮参与 flex 布局（tablist 首子元素）+ typecheck
7. typecheck 双 clean + renderer 全绿 → 本任务 Step 1/2

- [ ] **Step 4: 提交（如有遗留文件）**

```bash
git status --short   # 确认无未提交的本功能文件
```

---

## Self-Review 记录

- **Spec 覆盖**：§5.1→Task 1；§5.2 表格 8 项→Task 2/3/4/5（MainLayout 明确无改动）；§5.3 拖拽→Task 2；§5.4 视觉→各任务代码内嵌 token；§5.5 头部行→Task 2；§6 边界 6 项→Task 1（localStorage 回退）/Task 2（pointercancel、拖拽中收起卸载）/Task 4（文件空态）；§7 测试 5 文件→Tasks 1–5；§8 验收→Task 6。无缺口。
- **占位符扫描**：无 TBD/TODO/「适当处理」；所有代码步骤含完整代码。
- **类型一致性**：`SidebarViewKey` / `SIDEBAR_VIEWS` / `SIDEBAR_WIDTH_*` / `setSidebarWidth` 在 Task 1 定义、Task 2–5 消费签名一致；`Sidebar` props（`label/width/onWidthCommit/onCollapse/children`）Task 2 定义、Task 3 消费一致；`(SIDEBAR_VIEWS as readonly string[]).includes(...)` 收窄模式四处统一（非 `as any`，符合 ESLint）。
