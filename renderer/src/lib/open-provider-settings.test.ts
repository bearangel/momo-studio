// renderer/src/lib/open-provider-settings.test.ts
//
// D1b/D5 共用入口契约锁：点「去配置/去设置」必须同时落 settings 分类与视图切换。
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../stores/settings.store';
import { useUiStore } from '../stores/ui.store';
import { openProviderSettings } from './open-provider-settings';

beforeEach(() => {
  useUiStore.setState({ activeView: 'im' });
  useSettingsStore.setState({ activeCategory: 'memory' });
});

describe('openProviderSettings', () => {
  it('切到设置视图并定位「模型服务」分类', () => {
    openProviderSettings();
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(useSettingsStore.getState().activeCategory).toBe('model_provider');
  });

  it('重复调用幂等（已在设置页时仅改分类）', () => {
    useUiStore.setState({ activeView: 'settings' });
    openProviderSettings();
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(useSettingsStore.getState().activeCategory).toBe('model_provider');
  });
});
