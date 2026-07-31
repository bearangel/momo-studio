// electron/src/main/files/workspace-fs.ts
import fs from 'node:fs';
import path from 'node:path';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * 应用层文件系统沙箱。强制所有路径在 workspace 目录内。
 * 这是 OS 级沙箱（namespace / sandbox-exec）之外的应用层防线（M3 会加 OS 级）。
 */
export class WorkspaceFS {
  constructor(private rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** 验证路径在 workspace 内，返回绝对路径 */
  assertInWorkspace(relativeOrAbsolutePath: string): string {
    const abs = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.rootDir, relativeOrAbsolutePath);

    const normalized = path.normalize(abs);
    const realRoot = fs.realpathSync(this.rootDir);

    // 1) 字符串边界检查：path.normalize 已消除 "../" 穿越，
    //    所以仅需确认 normalized 落在 rootDir 之内即可拦截路径穿越与外部绝对路径。
    const insideWorkspace =
      normalized === this.rootDir || normalized.startsWith(this.rootDir + path.sep);
    if (!insideWorkspace) {
      throw new Error(`路径越界: ${relativeOrAbsolutePath} 不在 workspace 内`);
    }

    // 2) 符号链接逃逸检查：normalized 落在 rootDir 字符串边界内，但中间某段可能是
    //    指向 rootDir 之外的符号链接。向上找到真实存在的最近祖先并 realpathSync，
    //    若该祖先解析后已脱离 realRoot 则判定为逃逸。逐级向上而非直接
    //    realpathSync(normalized)，是为了支持尚未创建的文件路径。
    let anchor = normalized;
    while (anchor !== this.rootDir && !fs.existsSync(anchor)) {
      anchor = path.dirname(anchor);
    }
    if (anchor !== this.rootDir) {
      const realAnchor = fs.realpathSync(anchor);
      if (realAnchor !== realRoot && !realAnchor.startsWith(realRoot + path.sep)) {
        throw new Error(`符号链接逃逸: ${relativeOrAbsolutePath}`);
      }
    }

    // 3) 不允许操作 .git/（.gitignore 除外），保护版本库元数据
    const rel = path.relative(this.rootDir, normalized);
    if (rel.startsWith('.git') && rel !== '.gitignore') {
      throw new Error(`禁止操作 .git 目录: ${relativeOrAbsolutePath}`);
    }

    return normalized;
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
      .filter((e) => !e.name.startsWith('.git'))
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
