// electron/src/main/files/workspace-fs.ts
import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/** 文件名搜索命中项（file:searchNames 返回行） */
export interface SearchHit {
  /** 相对 workspace 根的全路径（含目录前缀，'/' 分隔） */
  path: string;
  isDirectory: boolean;
}

/** searchNames 默认结果上限（spec §5.1） */
const SEARCH_LIMIT_DEFAULT = 200;
/** searchNames 遍历条目总数上限（防病态深目录拖死主进程，spec §5.1） */
const SEARCH_TRAVERSAL_CAP_DEFAULT = 10_000;

/**
 * 应用层文件系统沙箱。强制所有路径在 workspace 目录内。
 * 这是 OS 级沙箱（namespace / sandbox-exec）之外的应用层防线（M3 会加 OS 级）。
 */
export class WorkspaceFS {
  /** 写授权扩展根（spec 2026-10-03 hard-gate §6）：realpath 归一去重；默认空 = 既有行为 */
  private extraRootDirs: string[] = [];

  constructor(private rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** 设置写授权扩展根（子进程工具侧 covered 后注入三层合成目录） */
  setExtraRootDirs(dirs: string[]): void {
    const norm = dirs.map((d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return path.resolve(d);
      }
    });
    this.extraRootDirs = [...new Set(norm)];
  }

  /** 验证路径在 workspace 或任一 extra 根内，返回绝对路径 */
  assertInWorkspace(relativeOrAbsolutePath: string): string {
    const abs = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.rootDir, relativeOrAbsolutePath);

    const normalized = path.normalize(abs);

    // 规范形态（终审 Important#1 / Ruling 8）：对 normalized 做最近存在祖先上溯
    // （与逃逸检查的 anchor walk 同一逻辑），realpathSync 解析锚点后拼接剩余后缀
    // 段。setExtraRootDirs 的根是 realpath 产物，而 LLM 重试常以别名前缀原始形态
    // （macOS /tmp → /private/tmp）到达——词法 isInsideDir 前缀失配会让 covered
    // 后的重执行再越界、ping-pong 烧完轮次。上溯到文件系统根仍不存在则退化保持
    // normalized；realpath 异常（权限等极端态）同样退化——行为回落修复前。
    let canonAnchor = normalized;
    while (canonAnchor !== path.dirname(canonAnchor) && !fs.existsSync(canonAnchor)) {
      canonAnchor = path.dirname(canonAnchor);
    }
    let canonical = normalized;
    if (fs.existsSync(canonAnchor)) {
      try {
        canonical = path.join(fs.realpathSync(canonAnchor), normalized.slice(canonAnchor.length));
      } catch {
        // 退化保持 normalized
      }
    }

    // 1) 逐根判定（spec hard-gate §6）：workspace 根 + extra 根，字符串形态或
    //    规范形态命中任一即进入该根的后续检查。symlink 逃逸记录首个错误但不
    //    立即抛——其他根仍可能合法容纳（如 extra 根恰为 symlink 目标所在）；
    //    全部根失败才抛逃逸。
    let escapeErr: Error | null = null;
    for (const root of [this.rootDir, ...this.extraRootDirs]) {
      const viaString = isInsideDir(root, normalized, { win32: PATH_SEMANTICS_WIN32 });
      const viaCanonical = isInsideDir(root, canonical, { win32: PATH_SEMANTICS_WIN32 });
      if (!viaString && !viaCanonical) continue;

      // 2) 符号链接逃逸检查（相对该根；逐级上溯支持尚未创建的文件路径）——仅
      //    字符串形态命中时执行，语义与文案不变；规范形态命中时跳过：canonical
      //    本身就是 realpath 解析产物（锚点已解析到根内），构造上无逃逸面。
      if (viaString) {
        let anchor = normalized;
        while (anchor !== root && !fs.existsSync(anchor)) {
          anchor = path.dirname(anchor);
        }
        if (anchor !== root) {
          const realRoot = fs.realpathSync(root);
          const realAnchor = fs.realpathSync(anchor);
          if (realAnchor !== realRoot && !realAnchor.startsWith(realRoot + path.sep)) {
            escapeErr ??= new Error(`符号链接逃逸: ${relativeOrAbsolutePath}`);
            continue;
          }
        }
      }

      // 3) .git 保护仅 workspace 根（spec hard-gate §6：授权目录与 bash 授权后
      //    行为对齐）。段精确匹配语义照旧（.github 等前缀 dotfile 不误伤）；rel
      //    取「命中的那个形态」——两形态都命中时查字符串形态（其在 workspace
      //    内即受保护），仅规范形态命中时以 canonical 的 rel 判定。
      if (root === this.rootDir) {
        const rel = path.relative(root, viaString ? normalized : canonical).toLowerCase();
        if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) {
          throw new Error(`禁止操作 .git 目录: ${relativeOrAbsolutePath}`);
        }
      }

      // 返回值不变：仍返回 normalized（后续 fs 调用原生解析 symlink；不改
      // readTracker / journal 的键形态，调用方零涟漪）
      return normalized;
    }
    if (escapeErr !== null) throw escapeErr;
    throw new Error(`路径越界: ${relativeOrAbsolutePath} 不在 workspace 内`);
  }

  async readFile(relativePath: string): Promise<Buffer> {
    const abs = this.assertInWorkspace(relativePath);
    return fs.promises.readFile(abs);
  }

  async writeFile(relativePath: string, content: string | Buffer): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    // 确保父目录存在
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(abs, content);
  }

  async listDir(relativePath: string): Promise<DirEntry[]> {
    const abs = this.assertInWorkspace(relativePath);
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.toLowerCase().startsWith('.git'))
      .map((e) => {
        const fullPath = path.join(abs, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          isDirectory: e.isDirectory(),
          size: stat.size,
        };
      });
  }

  /**
   * 递归文件名搜索（spec §5.1）：从 workspace 根遍历，条目名（basename）
   * 大小写不敏感子串匹配；.git* 前缀与 node_modules 条目排除（与 listDir
   * 一致）；符号链接目录不进入（Dirent.isDirectory 对 symlink 为 false，
   * 天然防环）。双上限：结果 limit + 遍历总数 traversalCap。
   */
  async searchNames(
    query: string,
    limit: number = SEARCH_LIMIT_DEFAULT,
    traversalCap: number = SEARCH_TRAVERSAL_CAP_DEFAULT,
  ): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const hits: SearchHit[] = [];
    let visited = 0;
    const walk = async (relDir: string): Promise<void> => {
      const abs = relDir === '.' ? this.rootDir : this.assertInWorkspace(relDir);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (hits.length >= limit || visited >= traversalCap) return;
        const lower = e.name.toLowerCase();
        if (lower.startsWith('.git') || lower === 'node_modules') continue;
        // 相对路径统一 '/' 分隔（与 file.store 路径拼接约定一致，跨平台稳定）
        const rel = relDir === '.' ? e.name : `${relDir}/${e.name}`;
        visited++;
        if (lower.includes(q)) {
          hits.push({ path: rel, isDirectory: e.isDirectory() });
        }
        if (e.isDirectory()) {
          await walk(rel);
        }
      }
    };
    await walk('.');
    return hits;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const abs = this.assertInWorkspace(relativePath);
      return fs.existsSync(abs);
    } catch {
      return false;
    }
  }

  /** 创建空文件（touch）。父目录自动创建。 */
  async createFile(relativePath: string): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(abs, '');
  }

  /** 递归创建目录（mkdir -p）。 */
  async createDir(relativePath: string): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    await fs.promises.mkdir(abs, { recursive: true });
  }

  /** 删除文件或目录（目录递归）。 */
  async deletePath(relativePath: string): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    await fs.promises.rm(abs, { recursive: true, force: false });
  }

  /** 重命名/移动。源和目标都经 assertInWorkspace 校验。 */
  async rename(srcRelativePath: string, dstRelativePath: string): Promise<void> {
    const srcAbs = this.assertInWorkspace(srcRelativePath);
    const dstAbs = this.assertInWorkspace(dstRelativePath);
    const dstDir = path.dirname(dstAbs);
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }
    await fs.promises.rename(srcAbs, dstAbs);
  }
}
