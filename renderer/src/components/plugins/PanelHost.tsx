// renderer/src/components/plugins/PanelHost.tsx
//
// 面板宿主（P4，spec §6.1/§6.3）——侧栏槽内的沙箱 iframe 外壳。
//   - iframe sandbox="allow-scripts"（无 allow-same-origin——插件拿不到宿主
//     DOM / storage / origin 权限），src = momo-plugin://<id>/…（协议层锚定安装目录）
//   - PanelChannel 承载五消息（origin/source 双校验 + 限流三振）
//   - 三态：loading → live；加载失败 → 红字占位 + 重试；通道断开 → 重新连接
//   - 主题快照：ready 回包携 token 换算值；documentElement class 变化 → force 推 theme
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, PlugZap, RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { PanelChannel, type PanelThemeSnapshot } from '../../lib/plugin/panel-channel';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import type { PluginPanelInfo } from '../../ipc/types';
import { panelIconOf } from './panel-icons';

/** 快照携带的语义 token 子集（面板配色跟随宿主，spec §6.2 ready 回包） */
const THEME_TOKENS = [
  '--bg-canvas',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--border-subtle',
  '--border-strong',
  '--accent-500',
] as const;

/** RGB 通道三元组（'255 255 255'）→ 'rgb(255,255,255)'；其余原样透传 */
export function formatTokenValue(raw: string): string {
  const v = raw.trim();
  return /^\d+(\s+\d+){2}$/.test(v) ? `rgb(${v.replace(/\s+/g, ',')})` : v;
}

export function readThemeSnapshot(): PanelThemeSnapshot {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) tokens[name] = formatTokenValue(style.getPropertyValue(name));
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    tokens,
  };
}

type PanelView = 'loading' | 'live' | 'error' | 'disconnected';

interface PanelHostProps {
  panel: PluginPanelInfo;
  onExit: () => void;
}

export function PanelHost({ panel, onExit }: PanelHostProps) {
  const [view, setView] = useState<PanelView>('loading');
  const [attempt, setAttempt] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const channelRef = useRef<PanelChannel | null>(null);
  const Icon = useMemo(() => panelIconOf(panel.icon), [panel.icon]);

  // 原生 load/error 监听（ref callback 挂）：React onError/onLoad 在部分嵌入
  // 场景（jsdom / 某些 WebView）不触发 iframe 事件，原生监听双可靠
  const handleLoad = useCallback(() => {
    setView((v) => (v === 'disconnected' ? v : 'live'));
  }, []);

  const handleError = useCallback(() => setView('error'), []);

  const attachFrame = useCallback((el: HTMLIFrameElement | null) => {
    if (iframeRef.current) {
      iframeRef.current.removeEventListener('load', handleLoad);
      iframeRef.current.removeEventListener('error', handleError);
    }
    iframeRef.current = el;
    if (el) {
      el.addEventListener('load', handleLoad);
      el.addEventListener('error', handleError);
    }
  }, [handleLoad, handleError]);

  useEffect(() => {
    const channel = new PanelChannel({
      pluginId: panel.pluginId,
      iframeWindow: () => iframeRef.current?.contentWindow ?? null,
      handlers: {
        getTheme: readThemeSnapshot,
        getContext: () => {
          const ws = useWorkspaceStore.getState().getActive();
          return {
            workspaceId: ws?.id ?? '',
            workspaceName: ws?.name ?? '',
            sessionId: useSessionStore.getState().activeSessionId,
          };
        },
        subscribe: async (events) => ({ ok: events, rejected: [] }),
        callService: (method, params) =>
          ipc.plugin.callService(panel.pluginId, method, params),
        onDisconnect: () => setView('disconnected'),
      },
    });
    channel.start();
    channelRef.current = channel;

    const offPanelEvent = ipc.plugin.onPanelEvent(({ event, payload }) => {
      channel.pushEvent(event, payload);
    });
    const themeObserver = new MutationObserver(() => {
      channel.pushEvent('theme', readThemeSnapshot(), { force: true });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      channel.stop();
      channelRef.current = null;
      offPanelEvent();
      themeObserver.disconnect();
    };
  }, [panel.pluginId, attempt]);

  // Esc 退出面板模式（预览裁定）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const retry = (): void => {
    setView('loading');
    setAttempt((n) => n + 1);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-subtle px-3">
        <Icon size={16} strokeWidth={1.75} className="text-accent-500" aria-hidden />
        <span className="text-[13px] font-medium text-primary">{panel.title}</span>
        <span className="flex-1" />
        {view === 'disconnected' && (
          <span className="rounded bg-status-error-tint px-2 py-px text-[11px] text-status-error">
            通道已断开
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 bg-canvas">
        {view === 'error' ? (
          <PanelErrorState
            icon={<AlertTriangle size={15} strokeWidth={1.75} />}
            message="面板加载失败"
            sub="入口文件不存在或已损坏"
            actionLabel="重试"
            onAction={retry}
          />
        ) : view === 'disconnected' ? (
          <PanelErrorState
            icon={<PlugZap size={15} strokeWidth={1.75} />}
            message="通道已断开"
            sub="协议违规超限（消息频率 / 大小 / 白名单）。宿主不受影响。"
            actionLabel="重新连接"
            onAction={retry}
          />
        ) : (
          <iframe
            key={attempt}
            ref={attachFrame}
            src={panel.entryUrl}
            title={panel.title}
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-canvas"
          />
        )}
      </div>
    </div>
  );
}

interface PanelErrorStateProps {
  icon: React.ReactNode;
  message: string;
  sub: string;
  actionLabel: string;
  onAction: () => void;
}

function PanelErrorState({ icon, message, sub, actionLabel, onAction }: PanelErrorStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5" role="alert">
      <div className="flex items-center gap-1.5 text-[13px] text-status-error">
        {icon}
        {message}
      </div>
      <div className="text-xs text-tertiary">{sub}</div>
      <button type="button" onClick={onAction} className="rounded-md border border-strong bg-surface-2 px-3 py-1 text-xs text-primary transition-colors hover:bg-surface-3">
        {actionLabel}
      </button>
    </div>
  );
}
