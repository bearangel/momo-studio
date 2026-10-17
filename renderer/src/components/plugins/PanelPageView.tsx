// renderer/src/components/plugins/PanelPageView.tsx
//
// 插件主区页面（工作空间维度 v1.1 spec §6）：page 面板的全宽宿主。
// 复用 PanelHost（iframe 沙箱 + PanelChannel 五消息协议全量）；退出 = deactivate + 回会话视图。
// 悬空防御：activeKey 失效（禁用/卸载）或指向 sidebar 面板时不渲染——MiddlePanel 兜底态接管。
import { useUiStore } from '../../stores/ui.store';
import { usePluginPanelsStore, panelKeyOf } from '../../stores/plugin-panels.store';
import { PanelHost } from './PanelHost';

export function PanelPageView() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const panels = usePluginPanelsStore((s) => s.panels);
  const activeKey = usePluginPanelsStore((s) => s.activeKey);
  const deactivate = usePluginPanelsStore((s) => s.deactivate);
  const panel = activeKey === null ? null : (panels.find((p) => panelKeyOf(p) === activeKey) ?? null);
  if (!panel || panel.placement !== 'page') return null;
  const exit = (): void => {
    deactivate();
    setActiveView('im');
  };
  return (
    <div className="h-full w-full bg-canvas">
      <PanelHost panel={panel} onExit={exit} />
    </div>
  );
}
