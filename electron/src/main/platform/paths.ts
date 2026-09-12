// electron/src/main/platform/paths.ts
// 平台路径语义共享 helper（v2.10 Windows 全平台化 T1）。
//
// 现状：五处模块各自内联手工边界判定（`resolve(c) === r || c.startsWith(r + path.sep)`）
// 与手工 posix 化（`relative(...).split(path.sep).join('/')`），win32 语义（大小写
// 不敏感 / 反斜杠 / UNC / 异盘）各自为政。本模块收敛为单一实现，T2 起逐模块替换采用。
import path from 'node:path';

/** isInsideDir 显式平台开关（win32 测试与已确知平台的调用方注入用） */
export interface InsideDirOpts {
  /**
   * 强制按 win32 语义比对（大小写不敏感前缀）。缺省取 process.platform === 'win32'。
   * 注意：win32 单测经 vi.mock('node:path') 注入 win32 path 对象后，process.platform
   * 仍是 linux——mock 环境下必须经本参数显式进入 win32 分支（tests/platform/
   * paths.win32.test.ts 文件头注释是配套模板说明）。
   */
  win32?: boolean;
}

/**
 * 判定 child 是否位于 root 目录内（child === root 自身也算在内）。
 *
 * - 两侧 path.resolve 归一：消 '..' / '.' / 冗余分隔符 / win32 混合斜杠形态
 * - win32 态（opts?.win32 ?? process.platform === 'win32'）：两侧 toLowerCase 后
 *   前缀比对——Windows 文件系统（NTFS 默认）大小写不敏感，'C:\WS' 应容纳 'c:\ws\x'
 * - 前缀比对带 path.sep 边界：root='/ws' 时兄弟前缀碰撞 '/wsfoo.txt' 不误伤；
 *   而目录内点前缀文件名 '/ws/..foo.txt' 正常命中
 * - posix 态严格比对
 * - 纯字符串运算不触 fs（与 WorkspaceFS 的 realpath 符号链接防线正交——本函数
 *   只管字符串边界语义）
 * - 非法输入（非串 / 空串）返回 false：IPC 与 JSON 边界可能送来未受信输入
 */
export function isInsideDir(root: string, child: string, opts?: InsideDirOpts): boolean {
  if (typeof root !== 'string' || typeof child !== 'string') return false;
  if (root === '' || child === '') return false;
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);
  if (opts?.win32 ?? process.platform === 'win32') {
    // 相等判定同样走小写：win32 下 'C:\ws' 与 'c:\wS' 是同一目录（NTFS 大小写不敏感）
    const r = resolvedRoot.toLowerCase();
    const c = resolvedChild.toLowerCase();
    return c === r || c.startsWith(r + path.sep);
  }
  return resolvedChild === resolvedRoot || resolvedChild.startsWith(resolvedRoot + path.sep);
}

/**
 * root 下 absPath 的相对路径，分隔符统一为 '/'（跨平台稳定展示 / 键控形态，
 * 与 git-tools 既有 '/' 化输出同形）。
 *
 * 不以裸 split(path.sep) 实现，用 replaceAll 全局字面替换。差异点：split 按分隔符
 * 切段——连续分隔符会产生空段、win32 盘符 'C:' 也是一个独立段，join('/') 后复原
 * 只是碰巧依赖「段重组还原原串」；replaceAll 逐字符字面替换不依赖该巧合，对任何
 * 输入形态行为一致（path.relative 输出本就归一无连续分隔符，两者在此等价——
 * 取语义更稳的实现）。
 */
export function toPosixRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).replaceAll(path.sep, '/');
}
