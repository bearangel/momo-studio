// renderer/src/stores/settings.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './settings.store';

beforeEach(() => {
  useSettingsStore.setState({ activeCategory: 'model_provider' });
});

describe('settings.store', () => {
  it('初始 activeCategory 为 model_provider', () => {
    expect(useSettingsStore.getState().activeCategory).toBe('model_provider');
  });

  it('setCategory 切换到新增分类 default_model', () => {
    useSettingsStore.getState().setCategory('default_model');
    expect(useSettingsStore.getState().activeCategory).toBe('default_model');
  });

  it('setCategory 切换到新增分类 about', () => {
    useSettingsStore.getState().setCategory('about');
    expect(useSettingsStore.getState().activeCategory).toBe('about');
  });
});