// renderer/src/lib/open-provider-settings.ts
//
// 直达 设置 → 模型服务 分类（D1b 未配置横幅 / D5 空供应商指引共用入口）。
// 先落分类再切视图：SettingsView 挂载即渲染目标分类，避免「先切视图再改分类」
// 闪一下旧分类。副作用链：setCategory('model_provider') + setActiveView('settings')
// ——后者会令 MiddlePanel 卸载 marketplace/agents 分支，宿主弹窗随之关闭。
import { useSettingsStore } from '../stores/settings.store';
import { useUiStore } from '../stores/ui.store';

export function openProviderSettings(): void {
  useSettingsStore.getState().setCategory('model_provider');
  useUiStore.getState().setActiveView('settings');
}
