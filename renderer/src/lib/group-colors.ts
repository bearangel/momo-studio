// renderer/src/lib/group-colors.ts
//
// 会话分组组色系统（spec 2026-10-22 §4 + 预览 A rev2 三轮批准定值）。
//
// ⚠️ 镜像纪律：GROUP_COLOR_PALETTE 与 electron/src/main/storage/sessions/repo.ts
// 的同名常量逐字面量一致（renderer 不 import electron 包）。改一处必同步三处：
// 迁移 068 存量回填 CASE 分支 / electron 常量 / 本镜像——两侧测试 12 个字面量全锁。

export const GROUP_COLOR_PALETTE = [
  '#5E6AD2', '#23835C', '#B7791F', '#D33F49', '#6E56CF', '#3E8F8C',
] as const;

/** 暗主题提亮档（预览 A rev2）：与 GROUP_COLOR_PALETTE 槽位一一对应（查表换色） */
export const GROUP_COLOR_PALETTE_DARK = [
  '#8A93E0', '#4BB782', '#F2C94C', '#EB5757', '#9E8CF5', '#56B3B0',
] as const;

export type GroupColorTheme = 'light' | 'dark';

const HEX_RE = /^#([0-9A-Fa-f]{6})$/;

/**
 * 组头整行 tint 底色：浅主题 alpha 0.13 / 暗主题 0.20（预览 A 定值）。
 * 自定义 hex 同式计算（色值两主题直用，仅 alpha 随主题）；非法输入防御返回 transparent。
 */
export function groupTintColor(hex: string, theme: GroupColorTheme): string {
  const m = HEX_RE.exec(hex);
  if (!m) return 'transparent';
  const v = m[1]!;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${theme === 'dark' ? 0.2 : 0.13})`;
}

/**
 * 组色圆点 / 面板 swatch 展示色：浅色板 hex 在暗主题查提亮档表；
 * 未命中（自定义色）原值直用；浅主题恒原值。
 */
export function groupDotColor(hex: string, theme: GroupColorTheme): string {
  if (theme === 'light') return hex;
  const idx = (GROUP_COLOR_PALETTE as readonly string[]).indexOf(hex);
  return idx === -1 ? hex : (GROUP_COLOR_PALETTE_DARK[idx] ?? hex);
}

/**
 * 分组整体卡片边框色（2026-10-22 右键菜单改造预览批准）：展开态组头+组内会话
 * 包在同一 1px 边框内。浅主题原色 alpha 0.45；暗主题先查提亮档表再 alpha 0.5
 * （与圆点同套换色逻辑）；非法输入防御返回 transparent。
 */
export function groupBorderColor(hex: string, theme: GroupColorTheme): string {
  const src = groupDotColor(hex, theme);
  const m = HEX_RE.exec(src);
  if (!m) return 'transparent';
  const v = m[1]!;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${theme === 'dark' ? 0.5 : 0.45})`;
}
