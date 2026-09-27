// electron/src/main/files/asset-read-ipc.ts
//
// asset:readDataUrl IPC：把 workspace `.momo/assets/` 内的图片读成 data URL，
// 供 renderer 气泡缩略图展示（spec 2026-09-26 §10 / §11）。
//
// 安全边界（与 asset-ipc.ts 的 saveImage 同构，momo-boundary-rules）：
//   1. 路径白名单 regex：只放行 saveImage 产出的命名形状——`.momo/assets/` 前缀 +
//      sha1 前 12 位小写 hex + png|jpg 扩展名。regex 从 asset-ipc 的命名规则派生
//      （耦合点：hash 长度 = saveImage 的 digest('hex').slice(0, 12)；ext 白名单 =
//      asset-ipc 的 ALLOWED_EXTS；目录常量直接 import ASSETS_REL_DIR）。T4 改命名
//      规则时必须同步这里，否则读图通道与写图通道形状漂移。
//   2. 路径囚禁复用 WorkspaceFS.assertInWorkspace（字符串边界 + 符号链接 anchor
//      realpath 逃逸 + .git 保护）——regex 通过后仍要走，防 symlink plant。
//   3. 读上限 8MB（与 saveImage 写上限对齐）：stat 先查大小，超限中文抛错，
//      不把巨文件读进内存再拒。
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getWorkspace } from '../workspace/crud';
import { WorkspaceFS } from './workspace-fs';
import { ASSETS_REL_DIR } from './asset-ipc';

/** 单张图片读取上限（字节）——与 asset-ipc.saveImage 的 MAX_IMAGE_BYTES 对齐 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * 路径白名单：`^\.momo/assets/[0-9a-f]{12}\.(png|jpg)$`
 * 前缀段由 ASSETS_REL_DIR 运行时转义拼入（不再手写第二份目录字符串）；
 * `[0-9a-f]{12}` 对应 saveImage 的 `sha1().digest('hex').slice(0, 12)`；
 * `(png|jpg)` 对应 asset-ipc 的 ALLOWED_EXTS 白名单。
 */
const ASSET_PATH_RE = new RegExp(
  `^${ASSETS_REL_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f]{12}\\.(png|jpg)$`,
);

/** 扩展名 → MIME（jpg 的标准 MIME 是 image/jpeg） */
const MIME_BY_EXT: Record<'png' | 'jpg', string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
};

export interface AssetReadDeps {
  /** 注入即完全接管 workspace 目录解析（测试用；生产路径依赖 SQLite） */
  workspaceDir?: (workspaceId: string) => string | null;
}

let deps: AssetReadDeps = {};

/** 测试注入点：绕过 getWorkspace 的 DB 查询（与 asset-ipc.setAssetDeps 同款） */
export function setAssetReadDeps(d: AssetReadDeps): void {
  deps = d;
}

/** workspace 目录解析：注入优先，生产走 getWorkspace；未知 workspace 抛中文错（不静默） */
function workspaceDirOf(workspaceId: string): string {
  const injected = deps.workspaceDir?.(workspaceId);
  if (injected !== undefined && injected !== null) return injected;
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`asset:readDataUrl 失败：workspace 不存在 (id=${workspaceId})`);
  }
  return ws.directoryPath;
}

/**
 * 主入口：读 `<workspace>/<relPath>` 图片为 `data:<mime>;base64,...`。
 * 失败语义（spec §11）：路径不合规 / 越界 / 文件缺失 / 超 8MB / 未知 workspace
 * → 抛中文错误，渲染端降级「图片不可用」占位。
 */
export async function readDataUrl(workspaceId: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string') {
    throw new Error(`asset:readDataUrl 失败：path 必须是字符串，收到 ${relPath === null ? 'null' : typeof relPath}`);
  }

  const m = ASSET_PATH_RE.exec(relPath);
  if (!m) {
    throw new Error(`asset:readDataUrl 失败：路径不合规，只允许 ${ASSETS_REL_DIR}/<12位hex>.(png|jpg)，收到 "${relPath}"`);
  }
  const ext = m[1] as 'png' | 'jpg';

  const wsDir = path.resolve(workspaceDirOf(workspaceId));
  const wsFs = new WorkspaceFS(wsDir);
  const abs = wsFs.assertInWorkspace(relPath);

  let size: number;
  try {
    size = fs.statSync(abs).size;
  } catch {
    throw new Error(`asset:readDataUrl 失败：文件不存在或不可读: ${relPath}`);
  }
  if (size > MAX_READ_BYTES) {
    throw new Error(`asset:readDataUrl 失败：图片大小 ${size} 字节超过上限 ${MAX_READ_BYTES} 字节（8MB）`);
  }

  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(abs);
  } catch (err) {
    logger.warn('asset:readDataUrl 读盘失败', {
      workspaceId,
      path: relPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`asset:readDataUrl 失败：文件不存在或不可读: ${relPath}`);
  }

  return `data:${MIME_BY_EXT[ext]};base64,${bytes.toString('base64')}`;
}

/** IPC handler 注册：重复注册会被 Electron 拒绝，故只调一次（与 registerAssetHandlers 同址接线） */
export function registerAssetReadHandlers(): void {
  ipcMain.handle('asset:readDataUrl', async (_evt, workspaceId: string, relPath: string) => {
    return readDataUrl(workspaceId, relPath);
  });
  logger.info('Asset read IPC handlers 已注册');
}
