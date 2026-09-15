# 提示交互分级统一实施计划（NoticeTiers：阻断居中 / 告知堆叠 / 安全区避让）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两级提示体系落地——阻断性确认（信任授权/释放等待）居中显示，告知性提示（三死信 kind + 沙箱/升级/恢复卡）右下堆叠，全部按「安全区」（窗口减浏览器侧栏 rect）定位，构造上不可被原生视图遮挡。

**Architecture:** 新增侧栏 rect store（BrowserSidebar 既有 ResizeObserver 顺带写入）→ `useSafeArea` 推导 → `CenterPromptLayer`（Tier A 居中层）与 `NoticeStack`（Tier B 右下堆叠容器）两个锚点组件；六张卡迁移、三个死信 kind 补渲染。设计依据：`docs/specs/2026-09-15-unified-notice-tiers-design.md`。

**Tech Stack:** React + zustand + vitest（jsdom + fake timers），纯 renderer。

## Global Constraints

- **Node 20**：测试命令前 `nvm use 20`（workdir `renderer/`）。
- **UI 设计系统 v2.1**（ESLint 机械强制）：语义 token / lucide-react 16px stroke 1.75 / `components/ui/` 原子组件；禁标准色阶、inline 硬编码色、emoji 图标。
- **z 层级基准**：Tier A 层 `z-50`（与 ui/Dialog 同层——全应用顶层）；Tier B 堆叠 `z-40`（既有卡层级）。不发明其他数值。
- **契约（boundary-rules）**：`browser:notice` kind 集合与主进程生产者零改动；kind 路由表单点常量（`INFO_KINDS`）注释写明每 kind 唯一渲染归属，防双渲染。
- **组件更名一义一名**：`BrowserWaitReleaseBanner` → `BrowserWaitReleasePrompt`（形态从侧栏条幅变居中卡）。
- renderer 单测贴源 colocated；注释中文；TS strict 禁 any。
- Conventional Commits；不动版本号。

---

### Task 1: 安全区基建 + NoticeStack + 死信 toast（M1）

**Files:**
- Create: `renderer/src/stores/browser-sidebar-rect.store.ts`（store + useSafeArea）
- Create: `renderer/src/stores/browser-sidebar-rect.store.test.ts`
- Create: `renderer/src/components/notices/NoticeStack.tsx`
- Create: `renderer/src/components/notices/NoticeStack.test.tsx`
- Modify: `renderer/src/components/workspace/BrowserSidebar.tsx:124-156`（容器 ref + store 写入）

**Interfaces:**
- Produces（Task 2/3 消费）:
  - `useBrowserSidebarRectStore`（zustand：`rect: {x,y,width,height} | null`、`setRect`）
  - `useSafeArea(): { left, top, right, bottom }`（rect null 或宽 ≤40 → 全窗口；否则侧栏左侧区域）
  - `<NoticeStack>{children}</NoticeStack>`（右下锚定容器，children 为堆叠条目）

- [ ] **Step 1: 写失败测试（store）**

```ts
// renderer/src/stores/browser-sidebar-rect.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserSidebarRectStore, useSafeArea } from './browser-sidebar-rect.store';

beforeEach(() => useBrowserSidebarRectStore.getState().setRect(null));

describe('browser-sidebar-rect store + useSafeArea', () => {
  it('rect 缺省 null → 安全区为全窗口', () => {
    const s = useBrowserSidebarRectStore.getState();
    expect(s.rect).toBeNull();
  });

  it('setRect 写入 / 清 null 往返', () => {
    useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    expect(useBrowserSidebarRectStore.getState().rect).toEqual({ x: 800, y: 40, width: 224, height: 700 });
    useBrowserSidebarRectStore.getState().setRect(null);
    expect(useBrowserSidebarRectStore.getState().rect).toBeNull();
  });
});
```

（`useSafeArea` 的推导断言放 NoticeStack 测试经容器 style 数值间接锁——jsdom 下 renderHook 非 repo 惯例。）

- [ ] **Step 2: 实现store**

```ts
// renderer/src/stores/browser-sidebar-rect.store.ts
//
// 浏览器侧栏容器 rect——安全区（SafeArea）唯一真相源。
// 写入者唯一：BrowserSidebar 的 ResizeObserver 回调（与 setSidebarBounds 同一观察者，
// 零新增观察者）。消费者：CenterPromptLayer（Tier A 居中）/ NoticeStack（Tier B 右下）。
// 存在动机：原生 WebContentsView 按占位区 rect 在 OS 合成层盖住一切 renderer DOM，
// 按窗口裸坐标定位的提示可能被盖死（两次先例：拖拽手柄 bug 1、释放卡遮挡 bug）。
import { useEffect, useState } from 'react';
import { create } from 'zustand';

export interface SidebarRectLite {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserSidebarRectState {
  rect: SidebarRectLite | null;
  setRect: (rect: SidebarRectLite | null) => void;
}

export const useBrowserSidebarRectStore = create<BrowserSidebarRectState>((set) => ({
  rect: null,
  setRect: (rect) => set({ rect }),
}));

export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 安全区推导：rect null 或折叠竖条（≤40px，不构成遮挡）→ 全窗口；
 * 否则取侧栏左侧区域（侧栏右停靠）。窗口尺寸经 resize 订阅保持实时。
 */
export function useSafeArea(): SafeArea {
  const rect = useBrowserSidebarRectStore((s) => s.rect);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!rect || rect.width <= 40) return { left: 0, top: 0, right: vp.w, bottom: vp.h };
  return { left: 0, top: 0, right: rect.x, bottom: vp.h };
}
```

- [ ] **Step 3: 写失败测试（NoticeStack + 侧栏接线）**

`renderer/src/components/notices/NoticeStack.test.tsx`（mock 骨架照抄 BrowserSidebar.test.tsx 的 window.api 桩模式）：

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NoticeStack } from './NoticeStack';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';
import type { BrowserNotice } from '../../ipc/types';

const onBrowserNoticeMock = vi.fn();
(globalThis as unknown as { window: { api: unknown } }).window.api = {
  browser: {
    onBrowserNotice: onBrowserNoticeMock,
    onBrowserState: vi.fn().mockReturnValue(() => {}),
  },
};

function armNotice(): { push: (n: BrowserNotice) => void } {
  let captured: ((n: BrowserNotice) => void) | null = null;
  onBrowserNoticeMock.mockImplementation((cb: (n: BrowserNotice) => void) => {
    captured = cb;
    return () => {};
  });
  return { push: (n: BrowserNotice) => act(() => captured?.(n)) };
}

beforeEach(() => {
  onBrowserNoticeMock.mockReset();
  onBrowserNoticeMock.mockReturnValue(() => {});
  useBrowserSidebarRectStore.getState().setRect(null);
});

describe('NoticeStack（Tier B 右下堆叠 + 死信补渲染）', () => {
  it('死信三 kind → toast 条目渲染；Tier A 两 kind 不在堆叠出现（防双渲染）', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'crash-reloaded', text: '页面崩溃已重载', workspaceId: 'w1' });
    push({ kind: 'popup-blocked', text: '弹窗已拦截', workspaceId: 'w1' });
    push({ kind: 'navigation-error', text: '加载失败', workspaceId: 'w1' });
    push({ kind: 'trust-request', text: 'x', workspaceId: 'w1' });
    push({ kind: 'agent-waiting-release', text: 'y', workspaceId: 'w1' });
    expect(screen.getAllByTestId('notice-toast')).toHaveLength(3);
    expect(screen.queryByText('x')).toBeNull();
    expect(screen.queryByText('y')).toBeNull();
  });

  it('6 秒自动消散（fake timers）', async () => {
    vi.useFakeTimers();
    try {
      const { push } = armNotice();
      render(<NoticeStack />);
      push({ kind: 'crash-reloaded', text: '稍后消散', workspaceId: 'w1' });
      expect(screen.getByTestId('notice-toast')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(screen.queryByTestId('notice-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('手动关闭 × 移除条目', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'popup-blocked', text: '手动关', workspaceId: 'w1' });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('notice-toast')).toBeNull();
  });

  it('上限 4 条：超出丢最旧并显示「+N 条更早」计数行', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    for (let i = 1; i <= 6; i++) push({ kind: 'crash-reloaded', text: `t${i}`, workspaceId: 'w1' });
    expect(screen.getAllByTestId('notice-toast')).toHaveLength(4);
    expect(screen.getByTestId('notice-overflow').textContent).toContain('2');
    expect(screen.queryByText('t1')).toBeNull();
    expect(screen.queryByText('t2')).toBeNull();
    expect(screen.getByText('t3')).toBeInTheDocument();
  });

  it('定位避让：无侧栏 → right=16；侧栏 rect.x=800 → right=innerWidth-800+16', () => {
    const { push } = armNotice();
    render(<NoticeStack />);
    push({ kind: 'crash-reloaded', text: '定位', workspaceId: 'w1' });
    const stack = screen.getByTestId('notice-stack');
    expect(stack.style.right).toBe('16px');
    act(() => {
      useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    });
    expect(stack.style.right).toBe(`${window.innerWidth - 800 + 16}px`);
  });
});
```

- [ ] **Step 4: 实现 NoticeStack**

```tsx
// renderer/src/components/notices/NoticeStack.tsx
//
// Tier B 告知性提示堆叠（spec 2026-09-15 §4.3）：按安全区右下锚定（避让浏览器
// 侧栏——原生 WebContentsView 在 OS 合成层盖住一切 DOM），纵向堆叠、上限 4 条
// （超出丢最旧 + 计数行）、条目 6s 自动消散可手动关。
//
// kind 路由表（唯一渲染归属，防双渲染）：本组件只消费 INFO_KINDS 三 kind；
// trust-request → Tier A BrowserTrustNotice；agent-waiting-release → Tier A
// BrowserWaitReleasePrompt；未来新 kind 默认落此处（前向兼容）。
import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserNotice } from '../../ipc/types';
import { useSafeArea } from '../../stores/browser-sidebar-rect.store';

const NOTICE_TTL_MS = 6_000;
const MAX_VISIBLE = 4;

/** Tier B 消费的 kind 集（路由表见文件头注） */
const INFO_KINDS = new Set(['crash-reloaded', 'popup-blocked', 'navigation-error']);

interface ToastEntry {
  id: number;
  kind: string;
  text: string;
}

let nextToastId = 1;

export function NoticeStack({ children }: { children?: React.ReactNode }) {
  const safe = useSafeArea();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [overflowCount, setOverflowCount] = useState(0);

  useEffect(() => {
    const off = ipc.browser.onBrowserNotice((n: BrowserNotice) => {
      if (!INFO_KINDS.has(n.kind)) return;
      setToasts((prev) => {
        const appended = [...prev, { id: nextToastId++, kind: n.kind, text: n.text }];
        if (appended.length <= MAX_VISIBLE) return appended;
        setOverflowCount((c) => c + (appended.length - MAX_VISIBLE));
        return appended.slice(-MAX_VISIBLE);
      });
    });
    return off;
  }, []);

  // 自动消散：以队列首条为计时锚（6s 逐条滑出）
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => {
      setToasts((prev) => prev.slice(1));
    }, NOTICE_TTL_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  const dismiss = (id: number): void => {
    setToasts((prev) => prev.filter((e) => e.id !== id));
  };

  return (
    <div
      data-testid="notice-stack"
      className="pointer-events-none fixed bottom-4 z-40 flex w-[360px] flex-col gap-2"
      style={{ right: Math.max(16, window.innerWidth - safe.right + 16) }}
    >
      {overflowCount > 0 && (
        <div
          data-testid="notice-overflow"
          className="pointer-events-auto self-end rounded border border-subtle bg-surface-1 px-2 py-0.5 text-xs text-tertiary"
        >
          还有 {overflowCount} 条更早提示
        </div>
      )}
      {children}
      {toasts.map((e) => (
        <div
          key={e.id}
          data-testid="notice-toast"
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-subtle bg-surface-1 p-3 text-sm text-secondary shadow-lg"
        >
          <Info size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
          <p className="min-w-0 flex-1 break-words text-xs leading-4">{e.text}</p>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => dismiss(e.id)}
            className="shrink-0 text-tertiary hover:text-primary"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: BrowserSidebar 接线（store 写入）**

三处修改（`electron 侧契约不动`，仅 renderer 附加写入）：
① 外层容器 div（`data-testid="browser-sidebar"`）加 `ref={containerRef}`（`const containerRef = useRef<HTMLDivElement | null>(null);`）。
② 既有占位区上报 effect（:124-143）的 `report()` 内追加容器 rect 写 store：

```ts
    const report = (): void => {
      const r = el.getBoundingClientRect();
      const c = containerRef.current?.getBoundingClientRect();
      // 安全区真相源（spec 2026-09-15 §4.1）：与占位区上报同一观察者，零新增观察者
      useBrowserSidebarRectStore
        .getState()
        .setRect(c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null);
      void ipc.browser
        .setSidebarBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
        .catch(() => {});
    };
```

③ 该 effect 的 cleanup 与卸载 effect（:149-156）各补 `useBrowserSidebarRectStore.getState().setRect(null);`（折叠/卸载即安全区回全窗口）。

- [ ] **Step 6: 跑测试确认通过（含侧栏既有套件零回归）**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run src/stores/browser-sidebar-rect.store.test.ts src/components/notices/ src/components/workspace/BrowserSidebar.test.tsx`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add renderer/src/stores/browser-sidebar-rect.store.ts renderer/src/stores/browser-sidebar-rect.store.test.ts renderer/src/components/notices/ renderer/src/components/workspace/BrowserSidebar.tsx
git commit -m "feat: 安全区真相源与 NoticeStack——告知类提示右下堆叠 + 死信三 kind 补渲染"
```

---

### Task 2: CenterPromptLayer + 两卡居中迁移 + 侧栏还原（M2）

**Files:**
- Create: `renderer/src/components/notices/CenterPromptLayer.tsx` + `.test.tsx`
- Modify: `renderer/src/components/workspace/BrowserTrustNotice.tsx`（去 fixed → 居中卡 + 遮罩）
- Modify: `renderer/src/components/workspace/BrowserWaitReleaseBanner.tsx` → 重命名 `BrowserWaitReleasePrompt.tsx`（+ 测试文件重命名）
- Modify: `renderer/src/components/workspace/BrowserSidebar.tsx`（移除条幅挂载与 import）
- Modify: `renderer/src/App.tsx`（挂载收敛）

**Interfaces:**
- Consumes: Task 1 `useSafeArea`
- Produces: `<CenterPromptLayer>{children}</CenterPromptLayer>`（Tier A 居中层，z-50）

- [ ] **Step 1: 写 CenterPromptLayer 失败测试**

```tsx
// renderer/src/components/notices/CenterPromptLayer.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CenterPromptLayer } from './CenterPromptLayer';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';

beforeEach(() => useBrowserSidebarRectStore.getState().setRect(null));

describe('CenterPromptLayer（Tier A 居中层）', () => {
  it('渲染 children 于层内（pointer-events-none 层 + auto 卡）', () => {
    render(
      <CenterPromptLayer>
        <div data-testid="tier-a-child">卡</div>
      </CenterPromptLayer>,
    );
    const layer = screen.getByTestId('center-prompt-layer');
    expect(layer).toBeInTheDocument();
    expect(layer.className).toContain('pointer-events-none');
    expect(layer.contains(screen.getByTestId('tier-a-child'))).toBe(true);
    expect(screen.getByTestId('tier-a-child').parentElement!.className).toContain('pointer-events-auto');
  });

  it('居中锚避让侧栏：rect.x=800 → 锚点 left = 800/2（安全区中点）', () => {
    render(
      <CenterPromptLayer>
        <div>卡</div>
      </CenterPromptLayer>,
    );
    act(() => {
      useBrowserSidebarRectStore.getState().setRect({ x: 800, y: 40, width: 224, height: 700 });
    });
    const anchor = screen.getByTestId('center-prompt-anchor');
    expect(anchor.style.left).toBe('400px');
  });
});
```

- [ ] **Step 2: 实现 CenterPromptLayer**

```tsx
// renderer/src/components/notices/CenterPromptLayer.tsx
//
// Tier A 阻断性确认层（spec 2026-09-15 §4.2）：安全区几何居中渲染阻断类提示卡
// （信任授权 / 释放等待）。层 pointer-events-none 不挡其余 UI；子卡 pointer-events-auto。
// 遮罩由需要强注意力的卡自带（信任卡），而非层统一——释放卡不剥夺用户输入。
import type { ReactNode } from 'react';
import { useSafeArea } from '../../stores/browser-sidebar-rect.store';

export function CenterPromptLayer({ children }: { children?: ReactNode }) {
  const safe = useSafeArea();
  const cx = (safe.left + safe.right) / 2;
  const cy = (safe.top + safe.bottom) / 2;
  return (
    <div data-testid="center-prompt-layer" className="pointer-events-none fixed inset-0 z-50">
      <div
        data-testid="center-prompt-anchor"
        className="pointer-events-auto absolute flex w-[400px] -translate-x-1/2 -translate-y-1/2 flex-col gap-2"
        style={{ left: `${cx}px`, top: `${cy}px` }}
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 信任卡迁移（红→绿）**

`BrowserTrustNotice.tsx` 修改：
① 根节点由 `fixed right-4 bottom-4 ...` 卡改为「遮罩 + 卡」结构——遮罩 class **逐字复制 `ui/Dialog.tsx` 的遮罩层实现**（执行时读该文件取其实际 class 与结构；`onClick` 不关闭——决策必须显式，超时兜底已存在）：

```tsx
  return (
    <>
      {/* 遮罩：与 ui/Dialog 同款（class 从 Dialog.tsx 复制）；点击不消散——决策须显式 */}
      <div className="（Dialog.tsx 的遮罩 class 原样）" aria-hidden />
      <div data-testid="browser-trust-notice" className="（原卡片 class 去除 fixed 定位，保留卡面视觉）">
        {/* 标题/正文/错误行/三按钮结构逐字保留 */}
      </div>
    </>
  );
```

② 既有测试适配：BrowserTrustNotice.test.tsx 断言卡片存在/按钮行为的用例不动（getByTestId/getByRole 与位置无关）；若某用例断言了 fixed 定位类名则删该断言（行为锁保留）。新增一条：遮罩存在 + 点击遮罩后卡片仍在。

- [ ] **Step 4: 释放卡迁移（重命名 + 形态还原）**

① `git mv BrowserWaitReleaseBanner.tsx BrowserWaitReleasePrompt.tsx`（测试文件同）。
② 组件名与 testid 全量替换（`BrowserWaitReleaseBanner`→`BrowserWaitReleasePrompt`、`browser-wait-release-banner`→`browser-wait-release-notice`→统一为 `browser-wait-release-prompt`）。⚠️ 注意 sed 别把历史注释里的迁移说明改错——逐处核对。
③ 渲染形态由侧栏条幅改回居中卡（逻辑逐字不动：kind 过滤 / durationMs 计时 / state 卸载 / setError 生命周期 / busy + 失败错误行）：

```tsx
  return (
    <div
      data-testid="browser-wait-release-prompt"
      className="rounded-lg border border-subtle bg-surface-1 p-4 text-sm text-secondary shadow-xl"
    >
      <div className="flex items-start gap-2 mb-2">
        <MousePointerClick size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">agent 正在等待浏览器</h2>
          <p className="text-xs text-tertiary mt-0.5">{notice.text}</p>
        </div>
      </div>
      {error !== null && (
        <div className="mb-2 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-xs text-status-error">
          释放失败：{error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => void release()}>释放并继续</Button>
      </div>
    </div>
  );
```

④ 头注更新：位置契约从「侧栏 chrome 列内」改为「CenterPromptLayer 居中（安全区避让原生视图）」——保留遮挡机理警示。

- [ ] **Step 5: 侧栏还原 + App 挂载收敛**

① `BrowserSidebar.tsx`：移除 `BrowserWaitReleaseBanner` import 与 chrome 列挂载（连同 2026-09-15 加的遮挡注释块）；`BrowserSidebar.test.tsx`：订阅计数断言回 `toHaveBeenCalledTimes(1)`（标题注释同步还原）；删除 2026-09-15 新增的「BrowserSidebar × BrowserWaitReleaseBanner（遮挡修复回归锁）」describe 块（防线由 Task 1 的安全区数值锁接替——spec §6.7）。
② `App.tsx`：`<BrowserTrustNotice />` 替换为：

```tsx
      {/* 提示分级（spec 2026-09-15）：Tier A 阻断确认居中层（信任/释放自管显隐） */}
      <CenterPromptLayer>
        <BrowserTrustNotice />
        <BrowserWaitReleasePrompt />
      </CenterPromptLayer>
```

- [ ] **Step 6: 跑测试**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run src/components/notices/ src/components/workspace/ src/App.test.tsx`
Expected: PASS（信任卡 11 用例、释放卡 9 用例行为锁全绿，仅容器断言适配）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: 阻断类提示居中层——信任卡带遮罩、释放卡改居中卡，侧栏条幅还原"
```

---

### Task 3: 三卡迁入堆叠 + 收尾（M3）

**Files:**
- Modify: `renderer/src/components/settings/SandboxNotice.tsx`、`renderer/src/components/upgrade/UpgradeNotice.tsx`、`renderer/src/components/task/ResumeNotice.tsx`
- Modify: `renderer/src/App.tsx`（挂入 NoticeStack）
- Modify: `renderer/src/components/workspace/BrowserSidebar.test.tsx`（如被 App 挂载变化波及）
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 三卡去 fixed 化**

各卡根节点：`fixed right-4 bottom-4 z-40 w-[360px] ...` → 去掉 `fixed right-4 bottom-4 z-40`（保留宽度/卡面/阴影类）——定位职责移交 NoticeStack 容器。各卡头注「样式照抄 UpgradeNotice（fixed right-4 bottom-4 …）」类注释同步更正为「NoticeStack 条目形态（spec 2026-09-15）」。各卡既有测试（显隐/IPC/按钮行为）应零改动全绿（断言与位置无关；若有类名断言则仅删定位类断言）。

- [ ] **Step 2: App 挂入**

```tsx
      {/* Tier B 告知堆叠（安全区右下）：三自管卡 + 死信 toast（NoticeStack 内部订阅） */}
      <NoticeStack>
        <SandboxNotice />
        <ResumeNotice />
        <UpgradeNotice />
      </NoticeStack>
```

（`{upgradeExportDir && ...}` 的 UpgradeNotice 既有条件渲染逻辑保持——以上为形态示意，执行时以该卡现有条件表达式为准迁入 children。）

- [ ] **Step 3: 全量验证**

Run: `nvm use 20 && npx pnpm@9.0.0 vitest run`（workdir renderer/，全量）；仓库根 `npx pnpm@9.0.0 typecheck`。
Expected: 全绿 + 0 error。

- [ ] **Step 4: CHANGELOG（研发账本追加）**

```markdown
### 提示交互分级统一 `2026-09-15`
- feat: 阻断类确认居中（信任授权带遮罩 / 释放等待无遮罩，安全区动态避让浏览器侧栏）+ 告知类右下堆叠（NoticeStack，上限 4 + 6s 消散）
- feat: 死信补渲染——crash 重载/popup 拦截/导航失败三 kind 首次可见；沙箱/升级/恢复三卡迁入堆叠，四卡同位叠放旧债清偿
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 沙箱/升级/恢复卡迁入 NoticeStack，提示分级体系收官"
```

---

## 计划自查记录

- **Spec 覆盖**：§4.1 store/写入点→Task1；§4.3 NoticeStack/死信/路由→Task1；§4.2 居中双卡/侧栏还原→Task2；三卡迁移→Task3；§6 矩阵 1-3/5→Task1、4/7→Task2、6→Task3。
- **占位符**：Task2 Step3 遮罩 class 标注「从 ui/Dialog.tsx 逐字复制」——指向仓库真实文件（复用既有实现而非发明新值），执行者读取后填入；其余代码完整。
- **类型一致性**：`useSafeArea(): {left,top,right,bottom}`、`useBrowserSidebarRectStore`、`<NoticeStack>{children}</NoticeStack>`、`<CenterPromptLayer>{children}</CenterPromptLayer>`、testid `notice-stack`/`notice-toast`/`notice-overflow`/`center-prompt-layer`/`center-prompt-anchor`/`browser-wait-release-prompt`——Task1/2/3 交叉一致。
- **已知取舍**：jsdom 断言容器 style 数值（`right`/`left`）作为防遮挡回归锁——jsdom 不做真实布局，但定位是纯 style 计算（safeArea → style），数值锁即几何锁。
