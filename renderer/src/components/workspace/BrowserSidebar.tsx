// renderer/src/components/workspace/BrowserSidebar.tsx
//
// v2.7 McpBrowser 侧栏 chrome（spec §3.5）：tabs / 地址栏 / 探活下拉 / 接管徽标 /
// 折叠钮 / 左缘宽度拖拽手柄 / 视图占位 div（页面内容属 main——WebContentsView 按占位区
// rect 叠加）。
//
// 状态源：挂载 getState 全量 + onBrowserState 推送增量（本组件不含业务状态机）。
//
// 鼠标接管路径（DoD 17）：04ecea7 起改用 Electron 原生 overlay view（view-factory.ts：
// 全透明 WebContentsView 挂栈顶拦截 mousedown → onOverlayHit → manager.userTakeover），
// 不再依赖 renderer DOM 接管层——OS 合成层序 native overlay → browser view →
// renderer DOM，DOM 层永远收不到 mousedown（v2.7 review fix C2 移除原接管 div）。
// 键盘接管仍由 main 进程 before-input-event 监听统一承担。
import { useEffect, useRef, useState } from 'react';
import { Globe, PanelRightClose, PanelRightOpen, ShieldCheck, ShieldOff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserState } from '../../ipc/types';
import { useBrowserSidebarRectStore } from '../../stores/browser-sidebar-rect.store';
import { useBrowserVisibilityStore } from '../../stores/browser-visibility.store';
import { useSessionStore } from '../../stores/session.store';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { AddressBar } from './AddressBar';
import { DevServerDropdown } from './DevServerDropdown';
import { TabsBar } from './TabsBar';
import { TakeoverIndicator } from './TakeoverIndicator';

interface Props {
  workspaceId: string;
}

// ---- 侧栏宽度域（280..720，默认 380）——与 main 侧 browser:updateSettings 的数值校验对齐 ----
const SIDEBAR_WIDTH_DEFAULT = 380;
const SIDEBAR_WIDTH_MIN = 280;
const SIDEBAR_WIDTH_MAX = 720;

/** 宽度钳制（拖拽 / 键盘 / 落库值还原三路共用）：越界收边界、四舍五入、非有限值回默认 */
const clampSidebarWidth = (w: number): number => {
  if (!Number.isFinite(w)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));
};

export function BrowserSidebar({ workspaceId }: Props) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [width, setWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  // 安全区真相源：容器 rect 经下方 report() 写 browser-sidebar-rect store
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 宽度还原竞速守卫：读取返回前用户已拖拽/键盘调宽 → 晚到的落库值不覆盖
  const widthUserTouchedRef = useRef(false);
  // 拖拽手势上下文：起点 clientX / 起始宽度；lastX 记录最新位置供 up 时提交（防 state 闭包过期）
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);
  const lastXRef = useRef(0);

  // 可见性（归属制 spec §9.1）：per-session 记忆，新会话缺省收起——
  // renderer 是可见性真相源，销毁/隐藏语义在 main（setSidebarVisible）
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const visible = useBrowserVisibilityStore((s) => s.isVisible(activeSessionId));

  // 宽度初始态跨重启闭环：挂载 / 切 ws 读 getSettings，sidebarWidth 落库值即
  // 初始态。读取失败保持默认宽度（体验性增强不阻塞骨架）。
  useEffect(() => {
    widthUserTouchedRef.current = false;
    let cancelled = false;
    ipc.browser
      .getSettings(workspaceId)
      .then((s) => {
        if (cancelled) return;
        // 落库宽度越界 / 非有限值同样钳制回有效域（防御旧库脏值撑破布局）
        if (!widthUserTouchedRef.current) {
          setWidth(clampSidebarWidth(s.sidebarWidth));
        }
      })
      .catch(() => {
        // 静默：默认宽度兜底，后续用户操作照常走拖拽 / 键盘
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 挂载 / 切 workspace 拉全量。失败不阻塞 chrome 骨架——订阅推送兜底
  //（boot 早期 / ws 未激活时 getState 可能拒绝，占位区与地址栏仍可用）。
  useEffect(() => {
    let cancelled = false;
        ipc.browser
      .getState(workspaceId)
      .then((s) => {
        if (cancelled) return;
        setState(s);
      })
      .catch(() => {
        // 静默：空态引导文案在位，后续 onBrowserState 推送自会填充
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // 统一状态推送订阅（卸载清理订阅）。非本 workspace 的推送忽略——
  // manager 只保证单活跃 ws，防御异 ws 快照覆盖当前显示。
  useEffect(() => {
    const unsubscribe = ipc.browser.onBrowserState((next) => {
      if (next.workspaceId !== workspaceId) return;
      setState(next);
      // 活跃会话的 agent 导航 → 本会话自动展开（spec §7.3）。handler 内一律
      // getState() 取活跃会话——订阅 effect 依赖 [workspaceId]，闭包里的
      // activeSessionId 是首渲染的过期值（P0-7 同构陷阱）
      const sid = useSessionStore.getState().activeSessionId;
      if (next.expandHint && sid !== null) {
        useBrowserVisibilityStore.getState().setVisible(sid, true);
      }
    });
    return unsubscribe;
  }, [workspaceId]);

  // 会话删除后的可见性条目清理（spec §9.1）：sessions 引用变化即重算存活集
  useEffect(() => {
    useBrowserVisibilityStore.getState().purgeStale(sessions.map((s) => s.id));
  }, [sessions]);

  // 可见性上报单点（M-1）：挂载 / 切 ws / visible 变化时主动重报——main 的
  // viewsHidden 不跨 ws 激活往返保持（重激活恒 false），renderer 是可见性真相源，
  // 不重报则隐藏中的 ws 切走再切回会以 lastRect 浮出。main 侧幂等（同值早退）。
  // toggleCollapsed 只写 store，IPC 上报全收敛到本 effect。
  useEffect(() => {
    void ipc.browser.setSidebarVisible(workspaceId, visible).catch(() => {
      // boot 早期 / 通道未就绪时静默——下一次 visible 变化自会重报
    });
  }, [workspaceId, visible]);

  // 占位区上报（bounds 锁）：ResizeObserver + window resize →
  // getBoundingClientRect → setSidebarBounds（main 换算 DPR 后 view.setBounds）。
  // 隐藏态除过渡帧一次性零报外不再上报：manager 隐藏即 bounds 置零（视图存活），
  // 无占位区则无真实 rect；展开时占位区重挂、本 effect 重跑首帧上报恢复
  //（manager 侧另有 lastRect 缓存兜底，见 T2）。
  useEffect(() => {
    if (!visible) {
      // 隐藏过渡帧：一次性零报（main 对全部视图 bounds 置零已由 setSidebarVisible
      // 承担，此报维持「renderer 无占位区则无真实 rect」的几何一致性）+ 安全区回全窗口
      void ipc.browser.setSidebarBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {});
      useBrowserSidebarRectStore.getState().setRect(null);
      return;
    }
    const el = placeholderRef.current;
    if (!el) return;
    const report = (): void => {
      const r = el.getBoundingClientRect();
      const c = containerRef.current?.getBoundingClientRect();
      // 安全区真相源（spec 2026-09-15 §4.1）：与占位区上报同一观察者，零新增观察者
      useBrowserSidebarRectStore
        .getState()
        .setRect(c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null);
      // 上报失败无 UI 可呈现——main 有 lastRect 缓存，下一次 resize 自会重报
      void ipc.browser
        .setSidebarBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
        .catch(() => {});
    };
    report(); // 首帧（挂载 / 展开）
    const observer = new ResizeObserver(report);
    observer.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      // 隐藏 / 卸载即安全区回全窗口
      useBrowserSidebarRectStore.getState().setRect(null);
    };
  }, [visible]);

  // 卸载（im→files/agents 活动视图切换）上报零尺寸 rect：main 对当前视图立即
  // setBounds(0) 隐藏（tabs/接管/状态保留——manager 状态不动），重挂载时占位区
  // effect 首帧上报自然恢复。空依赖 = 仅真卸载触发；workspaceId 变化（侧栏仍在
  // 位、布局不变）不零报——main 侧 ws 切换按 lastRect 缓存恢复新 ws 视图。
  useEffect(
    () => () => {
      void ipc.browser.setSidebarBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {
        // 卸载竞态（app 关闭中 IPC 已断）——静默即可
      });
      // 隐藏态挂载（report effect 早退未写 rect）/ 真卸载——安全区一律回全窗口
      useBrowserSidebarRectStore.getState().setRect(null);
    },
    [],
  );

  const toggleCollapsed = (): void => {
    if (activeSessionId === null) return; // rail 钮仅会话视图出现，防御
    // 只写 per-session store：隐藏/显示对 main 的上报（bounds 置零/恢复，
    // agent 后台操作不受影响，spec §6.3）由上方 M-1 可见性上报 effect 收敛承担
    useBrowserVisibilityStore.getState().setVisible(activeSessionId, !visible);
  };

  // 宽度落库单点（拖拽释放 / 键盘逐键共用）：写失败静默——本次会话宽度仍生效，
  // 重启回退旧值（体验性增强，与折叠态同一容错位）
  const persistWidth = (w: number): void => {
    void ipc.browser.updateSettings(workspaceId, { sidebarWidth: w }).catch(() => {});
  };

  // 拖拽 move/up 监听挂 window（同 layout/Sidebar.tsx 先例）：真实 DOM 中
  // setPointerCapture 后事件仍冒泡到 window，jsdom 无 capture API（try/catch
  // guard），两环境语义一致——指针移出手柄仍可跟踪。手柄在右侧停靠侧栏的左缘：
  // clientX 减小（向左拖）= 加宽，与 Sidebar.tsx（左停靠/右缘手柄）的 +Δx 相反。
  // 拖拽中仅本地 setWidth（占位区 ResizeObserver 自会上报新 bounds，main 据此
  // 调整 WebContentsView），释放时单次落库（无每帧 IPC）。
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    widthUserTouchedRef.current = true;
    setDragging(true);
    dragStartRef.current = { x: e.clientX, width };
    lastXRef.current = e.clientX;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom: setPointerCapture not implemented */
    }
    const onMove = (ev: PointerEvent): void => {
      if (!dragStartRef.current) return;
      lastXRef.current = ev.clientX;
      setWidth(clampSidebarWidth(dragStartRef.current.width + dragStartRef.current.x - ev.clientX));
    };
    // up / cancel 同路径：按最新位置一次提交（refs 取值，不吃过期 state 闭包）
    const finish = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const start = dragStartRef.current;
      dragStartRef.current = null;
      setDragging(false);
      if (start) {
        const final = clampSidebarWidth(start.width + start.x - lastXRef.current);
        setWidth(final);
        persistWidth(final);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  // 键盘调宽（role=separator 可聚焦）：手柄在侧栏左缘，ArrowLeft 沿拖拽语义加宽、
  // ArrowRight 收窄；Home/End 直达边界。单次按键 = 单次写（无连发节流需求）。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = width + 16;
        break;
      case 'ArrowRight':
        next = width - 16;
        break;
      case 'Home':
        next = SIDEBAR_WIDTH_MIN;
        break;
      case 'End':
        next = SIDEBAR_WIDTH_MAX;
        break;
      default:
        return;
    }
    e.preventDefault();
    widthUserTouchedRef.current = true;
    const final = clampSidebarWidth(next);
    setWidth(final);
    persistWidth(final);
  };

  // 地址栏 / 探活下拉共用的导航入口（userNavigate 隐式接管，§3.2）
  const navigate = (url: string): Promise<void> =>
    ipc.browser.userNavigate(workspaceId, url).then(() => undefined);

  const release = (): void => {
    // 释放失败无额外处理：状态推送未变 → 徽标仍在，用户可再点
    void ipc.browser.releaseTakeover(workspaceId).catch(() => {});
  };

  const openTab = (): void => {
    // brief 契约：openTab（不带 url → manager 以 about:blank 引导）→ switchTab 到
    // 新 tab 下标（manager open 已自动切 current，此跳幂等——保持两段式行为一致）
    void ipc.browser
      .openTab(workspaceId)
      .then((tabs) => {
        const last = tabs[tabs.length - 1];
        return last ? ipc.browser.switchTab(workspaceId, last.index) : undefined;
      })
      .catch((e: unknown) => {
        // IPC 故障兜底（user 态 tabs 操作已放行——G4 调用方甄别，manager 传 'user' 源）
        console.warn('[BrowserSidebar] openTab 失败', e);
      });
  };

  const switchTab = (index: number): void => {
    void ipc.browser.switchTab(workspaceId, index).catch((e: unknown) => {
      console.warn('[BrowserSidebar] switchTab 失败', e);
    });
  };

  const closeTab = (index: number): void => {
    void ipc.browser.closeTab(workspaceId, index).catch((e: unknown) => {
      console.warn('[BrowserSidebar] closeTab 失败', e);
    });
  };

  // ---- 隐藏态：只剩竖条展开钮（I2 语义承接：隐藏省渲染；视图本身存活，agent 后台操作不受影响）----
  if (!visible) {
    return (
      <div
        ref={containerRef}
        data-testid="browser-sidebar"
        className="flex w-10 shrink-0 flex-col items-center border-l border-subtle bg-surface-1 py-2"
      >
        <IconButton aria-label="展开浏览器侧栏" onClick={toggleCollapsed}>
          <PanelRightOpen size={16} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
    );
  }

  const tabs = state?.tabs ?? [];

  return (
    <div
      ref={containerRef}
      data-testid="browser-sidebar"
      className={`flex shrink-0 ${dragging ? 'select-none' : ''}`}
      style={{ width }}
    >
      {/* 左缘宽度拖拽手柄：静态 flex 子项（w-1 兄弟列，先于 chrome 列）。原生
          WebContentsView 按 placeholder rect 叠加在 OS 合成层（高于一切 renderer
          内容，z-index 无解）——手柄此前绝对定位在容器左缘，其命中区落在占位区
          rect 起点之内，页面一显示即被盖住（bug 1）。兄弟列结构让占位区 rect 从
          手柄右侧起算（+4px），视图永不覆盖手柄。bg-subtle 即侧栏左缘视觉线
          （原外层 border-l 语义移入此处，无双线）。宽度是数值而非颜色——inline
          style 是设计系统许可的动态宽度模式（动态 Tailwind 任意值 class 不生成
          CSS）。拖拽/悬停强调走 accent token（同 layout/Sidebar）。 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整浏览器侧栏宽度"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="browser-sidebar-resizer"
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={`w-1 self-stretch cursor-col-resize touch-none transition-colors ${
          dragging ? 'bg-accent-500' : 'bg-subtle hover:bg-accent-500 focus-visible:bg-accent-500'
        }`}
      />
      {/* chrome 列（flex-1 纵列）：既有 chrome 行 + 视图占位区 */}
      <div className="flex min-w-0 flex-1 flex-col bg-surface-1">
        {/* chrome 行 1：tabs + 接管徽标 + 信任徽标 + 折叠钮 */}
        <div className="flex items-center gap-1.5 border-b border-subtle px-2 py-1.5">
          <TabsBar
            tabs={tabs}
            current={state?.current ?? 0}
            onSelect={switchTab}
            onClose={closeTab}
            onOpen={openTab}
          />
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <TakeoverIndicator takeover={state?.takeover ?? 'agent'} onRelease={release} />
            {state ? (
              <Badge tone={state.trusted ? 'success' : 'neutral'}>
                {state.trusted ? (
                  <ShieldCheck size={16} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ShieldOff size={16} strokeWidth={1.75} aria-hidden />
                )}
                {state.trusted ? '工具已放行' : '工具受限'}
              </Badge>
            ) : null}
            <IconButton aria-label="折叠浏览器侧栏" onClick={toggleCollapsed}>
              <PanelRightClose size={16} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </div>
        </div>
        {/* chrome 行 2：探活下拉 + 地址栏 */}
        <div className="flex items-center gap-1.5 border-b border-subtle px-2 py-1.5">
          <DevServerDropdown
            onPick={(url) => {
              void navigate(url);
            }}
          />
          <AddressBar url={state?.url ?? ''} onNavigate={navigate} />
        </div>
        {/* 视图占位区：main 的 WebContentsView 按上报 rect 叠加于此。
            接管层不再走 renderer DOM（v2.7 review fix C2）——OS 合成层序 native overlay →
            browser view → renderer DOM，DOM 层永远收不到 mousedown；接管唯一入口是 view-factory
            showOverlay 挂的全透明 WebContentsView（onOverlayHit → manager.userTakeover）。 */}
        <div ref={placeholderRef} data-testid="browser-placeholder" className="relative min-h-0 flex-1">
          {tabs.length === 0 ? (
            <EmptyState
              icon={Globe}
              title="浏览器待命"
              description="地址栏输入 URL 直接打开，或让 agent 调用浏览器工具浏览页面"
              role="status"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
