// renderer/src/lib/version-compare.ts
//
// renderer 侧 semver 比较镜像（M2.3 T2）——**单源指针**：语义唯一真源在
// electron/src/main/resource/version-compare.ts（renderer 不能跨 workspace import
// 主进程模块，故镜像实现 + 同表断言锁：本文件测试与 electron 侧测试断言同一
// 输入输出表；hub v0.1.5 私有实现是第三份，三处同步义务见 electron 单源文件头）。
// 语义：数值段比较（防 '10'<'2' 字典序）/ 缺段按 0（1.0 == 1.0.0）/
// 预发布低于正式版 / 预发布标识符 semver 优先级 / 非法段按 0 / build 忽略。

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

/** semver 比较：a < b 负 / a > b 正 / 相等 0。语义契约见文件头（与 electron 单源逐条对齐）。 */
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

/** 全版本号列表 → 建议下一版本（semver 最高者 patch+1；空列表给 1.0.0）。
 *  M5.2：发布对话框版本冲突时的建议值（hub 已有版本不可复用）。 */
export function suggestNextVersion(versions: string[]): string {
  if (versions.length === 0) return '1.0.0';
  const max = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const core = max.split('+')[0]!.split('-')[0]!;
  const parts = core.split('.');
  const major = Number(parts[0]) || 0;
  const minor = Number(parts[1]) || 0;
  const patch = (Number(parts[2]) || 0) + 1;
  return `${major}.${minor}.${patch}`;
}
