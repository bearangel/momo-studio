// renderer/src/components/workspace/BrowserSidebar.tsx
//
// v2.7 McpBrowser 侧栏 chrome（spec §3.5）：tabs / 地址栏 / 探活下拉 / 接管徽标 /
// 折叠钮 + 视图占位 div（页面内容属 main——WebContentsView 按占位区 rect 叠加）。
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

export function BrowserSidebar({ workspaceId }: Props) {
  const [state, setState] = useState<BrowserState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  // 折叠初始态用户操作标记：读取返回前用户已手动切换 → 晚到的落库值不覆盖
  const collapsedUserTouchedRef = useRef(false);

  // 折叠初始态跨重启闭环（T9）：挂载 / 切 ws 读 getSettings，collapsed 落库值
  // 即初始态。width 暂不接——侧栏宽度当前是静态 w-[380px]（接入需先把静态宽
  // 改为受控值，留待后续）；读取失败保持默认展开（体验性增强不阻塞骨架）。
  useEffect(() => {
    collapsedUserTouchedRef.current = false;
    let cancelled = false;
    ipc.browser
      .getSettings(workspaceId)
      .then((s) => {
        if (!cancelled && !collapsedUserTouchedRef.current) setCollapsed(s.sidebarCollapsed);
      })
      .catch(() => {
        // 静默：默认展开兜底，后续用户操作照常走 toggleCollapsed
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
        if (!cancelled) setState(s);
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
    });
    return unsubscribe;
  }, [workspaceId]);

  // 占位区上报（bounds 锁）：ResizeObserver + window resize →
  // getBoundingClientRect → setSidebarBounds（main 换算 DPR 后 view.setBounds）。
  // 折叠态不上报：manager 折叠即销毁视图，上报零尺寸无意义；展开时占位区重挂、
  // 本 effect 重跑首帧上报恢复（manager 侧另有 lastRect 缓存兜底，见 T2）。
  useEffect(() => {
    if (collapsed) return;
    const el = placeholderRef.current;
    if (!el) return;
    const report = (): void => {
      const r = el.getBoundingClientRect();
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
    };
  }, [collapsed]);

  // 卸载（im→files/agents 活动视图切换）上报零尺寸 rect：main 对当前视图立即
  // setBounds(0) 隐藏（tabs/接管/状态保留——manager 状态不动），重挂载时占位区
  // effect 首帧上报自然恢复。空依赖 = 仅真卸载触发；workspaceId 变化（侧栏仍在
  // 位、布局不变）不零报——main 侧 ws 切换按 lastRect 缓存恢复新 ws 视图。
  useEffect(
    () => () => {
      void ipc.browser.setSidebarBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {
        // 卸载竞态（app 关闭中 IPC 已断）——静默即可
      });
    },
    [],
  );

  const toggleCollapsed = (): void => {
    collapsedUserTouchedRef.current = true;
    const next = !collapsed;
    setCollapsed(next);
    // IPC：main 视图销毁/重建 + per-workspace 落库；本地先行（折叠是纯 UI 态，
    // 落库失败不回滚——重启后以展开默认兜底）
    void ipc.browser.setSidebarCollapsed(workspaceId, next).catch(() => {});
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

  // ---- 折叠态：只剩竖条展开钮（I2：折叠销毁视图省内存，展开按清单重建）----
  if (collapsed) {
    return (
      <div
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
      data-testid="browser-sidebar"
      className="flex w-[380px] shrink-0 flex-col border-l border-subtle bg-surface-1"
    >
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
  );
}
