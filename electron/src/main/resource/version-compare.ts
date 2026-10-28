// electron/src/main/resource/version-compare.ts
//
// studio 侧 semver 比较单源（M2.3 T2 契约区，裁定书 p1-0 §4.2/§5）——资源域
// 全部版本比较消费（hub-install 已装判定等）。
//
// ⚠️ 单源义务（双仓三份，改任一侧必须同 commit 改其余两份）：
//   1. 本文件（studio 主进程单源）
//   2. renderer/src/lib/version-compare.ts（renderer 镜像——跨 workspace 不能
//      import 主进程模块，语义一致性靠同表断言锁）
//   3. momo-hub packages/hub/src/resources.ts compareVersions（hub v0.1.5 私有
//      实现——跨仓零依赖，一致性由 studio 契约测试锁：
//      electron/tests/resource/version-compare.test.ts ↔ hub
//      packages/hub/tests/resources-latest-semver.test.ts ⑥ 同输入同输出表）
//
// 语义（宽松容忍策略，对齐 S1 VERSION_PATTERN 宽超集的现实数据）：
//   - 数值段比较（防 '10'<'2' 字典序陷阱）
//   - 缺段按 0（1.0 == 1.0.0 == 1）
//   - 预发布低于正式版（1.0.0-alpha < 1.0.0），标识符按 semver 优先级
//   - 非法段按 0 不抛错（'1.x.0' == '1.0.0'）
//   - build metadata 忽略（1.0.0+build.1 == 1.0.0）

/** 拆出 build metadata（+）与预发布（-）：比较只看主段与预发布标识。 */
function splitVersion(v: string): { main: string[]; pre: string | null } {
  const noBuild = v.split('+', 1)[0] ?? '';
  const dash = noBuild.indexOf('-');
  return dash >= 0
    ? { main: noBuild.slice(0, dash).split('.'), pre: noBuild.slice(dash + 1) }
    : { main: noBuild.split('.'), pre: null };
}

/** 数值段解析：缺段/非纯数字段按 0（宽松容忍，不抛）。 */
function numericSegment(seg: string | undefined): number {
  if (seg === undefined || !/^[0-9]+$/.test(seg)) return 0;
  return Number(seg);
}

/** 预发布标识符比较（semver 优先级规则）：逐标识符——纯数值者数值比较且低于
 *  字母标识符，字母标识符 ASCII 字典序；前缀全等者短的低。 */
function comparePrerelease(a: string, b: string): number {
  const idsA = a.split('.');
  const idsB = b.split('.');
  const len = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < len; i++) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^[0-9]+$/.test(x);
    const ny = /^[0-9]+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** semver 比较：a < b 负 / a > b 正 / 相等 0。语义契约见文件头。 */
export function compareVersions(a: string, b: string): number {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.main.length, vb.main.length);
  for (let i = 0; i < len; i++) {
    const sa = numericSegment(va.main[i]);
    const sb = numericSegment(vb.main[i]);
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  // 主段全等：无预发布 > 有预发布（semver 优先级）
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return comparePrerelease(va.pre, vb.pre);
}
