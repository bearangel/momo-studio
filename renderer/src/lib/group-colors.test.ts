// renderer/src/lib/group-colors.test.ts
//
// 组色系统定值锁（预览 A rev2 三轮批准 + T6b 遗留补锁）：
// - 12 个色板字面量逐字面量锁定（浅 6 + 暗 6）——镜像纪律三处同步的 renderer 侧锚点
// - tint alpha：浅 .13 / 暗 .20
// - 圆点/色板换色：浅色板 hex → 暗主题查提亮档表；未命中（自定义色）原值直用
import { describe, it, expect } from 'vitest';
import {
  GROUP_COLOR_PALETTE,
  GROUP_COLOR_PALETTE_DARK,
  groupTintColor,
  groupDotColor,
} from './group-colors';

describe('GROUP_COLOR_PALETTE —— 浅色板 6 槽位字面量锁（T6b 补锁）', () => {
  it('六槽位逐字面量锁定（electron repo.ts 镜像，改一处必同步三处）', () => {
    expect([...GROUP_COLOR_PALETTE]).toEqual([
      '#5E6AD2', '#23835C', '#B7791F', '#D33F49', '#6E56CF', '#3E8F8C',
    ]);
  });

  it('六槽位逐一断言（防 toEqual 结构等价下的单槽漂移）', () => {
    expect(GROUP_COLOR_PALETTE[0]).toBe('#5E6AD2');
    expect(GROUP_COLOR_PALETTE[1]).toBe('#23835C');
    expect(GROUP_COLOR_PALETTE[2]).toBe('#B7791F');
    expect(GROUP_COLOR_PALETTE[3]).toBe('#D33F49');
    expect(GROUP_COLOR_PALETTE[4]).toBe('#6E56CF');
    expect(GROUP_COLOR_PALETTE[5]).toBe('#3E8F8C');
  });
});

describe('GROUP_COLOR_PALETTE_DARK —— 暗主题提亮档 6 槽位字面量锁', () => {
  it('六槽位逐字面量锁定（预览 A rev2）', () => {
    expect([...GROUP_COLOR_PALETTE_DARK]).toEqual([
      '#8A93E0', '#4BB782', '#F2C94C', '#EB5757', '#9E8CF5', '#56B3B0',
    ]);
  });

  it('六槽位逐一断言（防单槽漂移）', () => {
    expect(GROUP_COLOR_PALETTE_DARK[0]).toBe('#8A93E0');
    expect(GROUP_COLOR_PALETTE_DARK[1]).toBe('#4BB782');
    expect(GROUP_COLOR_PALETTE_DARK[2]).toBe('#F2C94C');
    expect(GROUP_COLOR_PALETTE_DARK[3]).toBe('#EB5757');
    expect(GROUP_COLOR_PALETTE_DARK[4]).toBe('#9E8CF5');
    expect(GROUP_COLOR_PALETTE_DARK[5]).toBe('#56B3B0');
  });
});

describe('groupTintColor —— 组头整行底色', () => {
  it('浅主题 alpha 0.13（#5E6AD2 → 94,106,210）', () => {
    expect(groupTintColor('#5E6AD2', 'light')).toBe('rgba(94, 106, 210, 0.13)');
  });

  it('暗主题 alpha 0.20（同 hex 提 alpha）', () => {
    expect(groupTintColor('#5E6AD2', 'dark')).toBe('rgba(94, 106, 210, 0.2)');
  });

  it('全部 6 色板槽位两主题均产出对应 alpha（防单点侥幸）', () => {
    for (const hex of GROUP_COLOR_PALETTE) {
      expect(groupTintColor(hex, 'light')).toMatch(/, 0\.13\)$/);
      expect(groupTintColor(hex, 'dark')).toMatch(/, 0\.2\)$/);
    }
  });

  it('自定义 hex 同式计算（两主题同值直用，仅 alpha 随主题）', () => {
    expect(groupTintColor('#12AB34', 'light')).toBe('rgba(18, 171, 52, 0.13)');
    expect(groupTintColor('#12AB34', 'dark')).toBe('rgba(18, 171, 52, 0.2)');
  });

  it('非法 hex 防御返回 transparent（错误路径）', () => {
    expect(groupTintColor('not-a-color', 'light')).toBe('transparent');
    expect(groupTintColor('', 'dark')).toBe('transparent');
  });
});

describe('groupDotColor —— 圆点 / swatch 展示色', () => {
  it('浅色板 hex 在暗主题逐槽查提亮档表', () => {
    expect(groupDotColor('#5E6AD2', 'dark')).toBe('#8A93E0');
    expect(groupDotColor('#23835C', 'dark')).toBe('#4BB782');
    expect(groupDotColor('#B7791F', 'dark')).toBe('#F2C94C');
    expect(groupDotColor('#D33F49', 'dark')).toBe('#EB5757');
    expect(groupDotColor('#6E56CF', 'dark')).toBe('#9E8CF5');
    expect(groupDotColor('#3E8F8C', 'dark')).toBe('#56B3B0');
  });

  it('浅主题原值直用（含色板色）', () => {
    expect(groupDotColor('#5E6AD2', 'light')).toBe('#5E6AD2');
    expect(groupDotColor('#123456', 'light')).toBe('#123456');
  });

  it('自定义 hex 未命中查表 → 两主题均原值直用', () => {
    expect(groupDotColor('#123456', 'dark')).toBe('#123456');
    expect(groupDotColor('#ABCDEF', 'light')).toBe('#ABCDEF');
  });
});
