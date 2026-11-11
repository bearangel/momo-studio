// electron/src/main/files/workspace-fs.ts
import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import { DirectContentIo } from './file-io/content-io';
import type { ContentIo } from './file-io/types';

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

/**
 * 文件名搜索结果（file:searchNames 返回形状，2026-11-11 方案 C）。
 * truncated 只表达「遍历预算提前结束、结果可能不完整」；结果数达到 limit
 * 属正常截断（truncated=false），UI 侧用各自的结果上限提示表达。
 */
export interface SearchResponse {
  hits: SearchHit[];
  truncated: boolean;
}

/** searchNames 默认结果上限（spec §5.1） */
const SEARCH_LIMIT_DEFAULT = 200;
/**
 * searchNames 遍历时间预算（毫秒，2026-11-11 方案 C）。取代旧「条目数 10000」
 * 预算：DFS 顺序下单个大目录就能吃光条目预算（生产实证 ws2 `.momo-scratch`
 * 有 11,604 条 → 后续目录永不访问，搜索静默 0 命中）。时间预算直接对齐
 * 「防病态目录拖死主进程」的原始目标，且不随目录密度失真。
 */
const SEARCH_TIME_BUDGET_MS = 1500;
/** 条目数绝对兜底：防毫秒级 readdir 的超巨型目录绕过时间预算语义。
 *  取 100 万——本仓库实测 269,639 条遍历约 0.9s（< 时间预算），
 *  兜底不得先于时间预算把正常大仓库截断。 */
const SEARCH_TRAVERSAL_CAP_DEFAULT = 1_000_000;

// 模块级默认内容通道（主进程/子进程 boot 时设定；未设定 = direct 行为）：
let defaultContentIo: ContentIo | null = null;

/** 设置模块级默认内容通道（spec §5.3：主进程与 runtime 子进程各设一次） */
export function setDefaultContentIo(io: ContentIo | null): void {
  defaultContentIo = io;
}

/** 仅供测试：读取当前模块默认内容通道 */
export function getDefaultContentIoForTest(): ContentIo | null {
  return defaultContentIo;
}

/**
 * 应用层文件系统沙箱。强制所有路径在 workspace 目录内。
 * 这是 OS 级沙箱（namespace / sandbox-exec）之外的应用层防线（M3 会加 OS 级）。
 */
export class WorkspaceFS {
  /** 写授权扩展根（spec 2026-10-03 hard-gate §6）：realpath 归一去重；默认空 = 既有行为 */
  private extraRootDirs: string[] = [];
  private readonly rootDir: string;
  private readonly injectedContentIo: ContentIo | null;

  constructor(rootDir: string, opts?: { contentIo?: ContentIo }) {
    this.rootDir = path.resolve(rootDir);
    this.injectedContentIo = opts?.contentIo ?? null;
  }

  /** 内容读写通道解析：注入 > 模块默认 > direct(strict) */
  private contentIo(): ContentIo {
    return this.injectedContentIo ?? defaultContentIo ?? new DirectContentIo(true);
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
    return this.contentIo().readFile(abs);
  }

  /** 文件字节数（预览阈值判定用）：沙箱校验后只 stat，不读内容 */
  async statSize(relativePath: string): Promise<number> {
    const abs = this.assertInWorkspace(relativePath);
    const stat = await fs.promises.stat(abs);
    return stat.size;
  }

  async writeFile(relativePath: string, content: string | Buffer): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    // 确保父目录存在
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.contentIo().writeFile(
      abs,
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
    );
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
   * 递归文件名搜索（spec §5.1）：从 workspace 根遍历，**相对路径**（含目录
   * 前缀）大小写不敏感子串匹配——输入目录名即可命中其下文件、输入 `dir/`
   * 即展开该目录内容（2026-11-11 B 方案；旧实现只匹配 basename，输入目录名
   * 只命中目录本身，renderer 过滤目录后列表为空）。
   * .git* 前缀与 node_modules 条目排除（与 listDir 一致）；符号链接目录不进入
   * （Dirent.isDirectory 对 symlink 为 false，天然防环）。
   * 预算：时间 timeBudgetMs（默认 1500ms）+ 条目数 traversalCap 绝对兜底；任一
   * 触发即停止遍历并置 truncated=true。
   * 空 query = match-all 全量列举（2026-11-05：会话工具条「文件」按钮限定
   * 菜单的全量浏览数据源）。
   */
  async searchNames(
    query: string,
    limit: number = SEARCH_LIMIT_DEFAULT,
    timeBudgetMs: number = SEARCH_TIME_BUDGET_MS,
    traversalCap: number = SEARCH_TRAVERSAL_CAP_DEFAULT,
  ): Promise<SearchResponse> {
    const q = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    const startedAt = Date.now();
    let visited = 0;
    let budgetExhausted = false;

    /** 预算判定（条目兜底 + 时间预算）；命中即标记 truncated 的权威来源 */
    const budgetHit = (): boolean => {
      if (visited >= traversalCap || Date.now() - startedAt > timeBudgetMs) {
        budgetExhausted = true;
        return true;
      }
      return false;
    };

    const walk = async (relDir: string): Promise<void> => {
      const abs = relDir === '.' ? this.rootDir : this.assertInWorkspace(relDir);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        // 结果已满 / 预算已耗尽：逐层退出（父层 next iteration 由 budgetExhausted 拦截）
        if (hits.length >= limit || budgetExhausted) return;
        if (budgetHit()) return;
        const lower = e.name.toLowerCase();
        if (lower.startsWith('.git') || lower === 'node_modules') continue;
        // 相对路径统一 '/' 分隔（与 file.store 路径拼接约定一致，跨平台稳定）
        const rel = relDir === '.' ? e.name : `${relDir}/${e.name}`;
        visited++;
        if (rel.toLowerCase().includes(q)) {
          hits.push({ path: rel, isDirectory: e.isDirectory() });
        }
        if (e.isDirectory()) {
          await walk(rel);
        }
      }
    };
    await walk('.');
    // 排序（2026-11-11 B 方案）：basename 命中优先 → 目录优先 → 路径自然序。
    // basename 优先保证「输入目录名」时目录与同名文件先出，不让远处纯路径命中
    // 占据列表头部；目录优先让钻入路径（展开子项）符合浏览直觉。
    const basenameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    hits.sort((a, b) => {
      const aBase = basenameOf(a.path).includes(q) ? 0 : 1;
      const bBase = basenameOf(b.path).includes(q) ? 0 : 1;
      if (aBase !== bBase) return aBase - bBase;
      if (a.isDirectory !== b.isDirectory) return Number(b.isDirectory) - Number(a.isDirectory);
      return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
    });
    return { hits, truncated: budgetExhausted };
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
    await this.contentIo().writeFile(abs, Buffer.alloc(0));
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
