// renderer/src/components/plugins/panel-icons.test.ts
// 面板图标白名单映射：mail 必须映射 Mail（email 插件活动栏图标，2026-11-05 用户反馈）
import { describe, expect, it } from 'vitest';
import { Mail, Puzzle } from 'lucide-react';
import { panelIconOf } from './panel-icons';

describe('panelIconOf', () => {
  it('lucide:mail → Mail（不再回落 Puzzle）', () => {
    expect(panelIconOf('lucide:mail')).toBe(Mail);
  });
  it('未知名仍回落 Puzzle', () => {
    expect(panelIconOf('lucide:nonexistent')).toBe(Puzzle);
  });
});
