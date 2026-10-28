// electron/tests/resource/version-compare.test.ts
//
// M2.3 T2 双仓契约锁（裁定书 p1-0 §4.2 / §5 T2 第 1 行）：
// studio 侧 compareVersions 单源（electron/src/main/resource/version-compare.ts）
// 与 hub v0.1.5 私有实现（momo-hub packages/hub/src/resources.ts compareVersions）
// 语义逐条对齐——双仓不共享代码（跨仓零依赖），一致性靠本断言表锁死：
// hub 侧同款用例见 momo-hub/packages/hub/tests/resources-latest-semver.test.ts
// describe('compareVersions')。**改任一侧语义必须双仓同 commit 改两份表。**
//
// 语义契约（宽松容忍策略——对齐 S1 VERSION_PATTERN 宽超集的现实数据）：
//   数值段比较（防 '10'<'2' 字典序陷阱）/ 缺段按 0（1.0 == 1.0.0 == 1）/
//   预发布低于正式版（1.0.0-alpha < 1.0.0）/ 预发布标识符 semver 优先级 /
//   非法段按 0 不抛错（'1.x.0' == '1.0.0'）/ build metadata 忽略。

import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/main/resource/version-compare';

// 同输入同输出断言表（与 hub resources-latest-semver.test.ts ⑥ 逐条对齐——
// 每行在 hub 侧有同名断言；新增行必须先在 hub 侧落同款）。
describe('compareVersions — 双仓契约锁（hub v0.1.5 对齐表）', () => {
  it('数值段比较（非字典序）', () => {
    expect(compareVersions('10.0.0', '2.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('缺段容忍：缺段按 0（1.0 == 1.0.0 == 1）', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('预发布低于正式版：1.0.0-alpha < 1.0.0', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
  });

  it('预发布标识符比较：数值比较 / 数值 < 字母 / 前缀短的低', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0); // 数值标识符 < 字母标识符
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  it('非法段按 0：1.x.0 == 1.0.0；空段 == 0；v 前缀段按 0', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
    expect(compareVersions('1..0', '1.0.0')).toBe(0);
    expect(compareVersions('v2.0.0', '2.0.0')).toBeLessThan(0); // 非法首段 'v2' 按 0 → (0,0,0) < (2,0,0)
    expect(compareVersions('v2.0.0', 'x.0.0')).toBe(0); // 双侧非法段同按 0 → 相等
  });

  it('build metadata 忽略：1.0.0+build.1 == 1.0.0', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0')).toBe(0);
  });
});

// 边界专项（momu-test-rules 第 3 条：错误路径与空输入必须有专项用例）：
// studio 侧消费面（hub-install 已装判定 / ResourceCard 角标）可能遇到空串
// （installedVersion 缺席兜底、目录脏数据）——不抛错、按全 0 段处理。
describe('compareVersions — 边界与空输入（studio 消费面专项）', () => {
  it('空串与任意合法版本比较不抛错（空串按 (0,0,0)）', () => {
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(compareVersions('', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '')).toBeGreaterThan(0);
    expect(compareVersions('', '')).toBe(0);
  });

  it('纯预发布串不抛错（主段全空按 0，预发布间仍可比）', () => {
    expect(compareVersions('-alpha', '-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '-beta')).toBeGreaterThan(0); // 有主段 > 无主段（预发布侧）
  });

  it('多个分隔符形态（---/+++ 混入）不抛错且可判定', () => {
    expect(compareVersions('1.0.0-a+b', '1.0.0-a')).toBe(0); // build 段忽略
    expect(compareVersions('1.0.0-a-b', '1.0.0-a.c')).toBeGreaterThan(0); // 标识符级 ASCII：'a-b' > 'a'（长串前缀相等者大），首个标识符即定序
  });
});
