// electron/src/main/files/asset-ipc.ts
//
// asset:saveImage IPC：把 renderer 降采样后的图片字节内容寻址写到 workspace
// 的 `.momo/assets/`。spec 2026-09-26 §5：sha1 前 12 + 白名单 ext；同字节 re-paste
// 不重写（内容寻址去重）；未知 workspace / 越界 / 超尺寸 / 符号链接逃逸统一抛中文错
// （不静默降级）。
//
// 安全边界（momo-boundary-rules + I6/I-fix 路径防御）：
//   - 文件名由「sha1 + 白名单 ext」派生，绝不用用户提供的路径片段
//   - 路径囚禁复用 WorkspaceFS.assertInWorkspace——它本身已含字符串边界 + 符号链接
//     逃逸 + .git 保护三层。我们只验证，不重复实现。重复实现 = 与 WorkspaceFS
//     的「anchor realpath」语义漂移，留下 symlink plant 攻击窗口（fix round 1）。
//   - 落盘顺序：tmp 文件写入 → rename；持久断电不留半截
//   - size 守门前置：避免把畸形/恶意大包推完 IO 才拒
//   - data 运行时类型校验：instanceof Uint8Array（Buffer extends Uint8Array，天然兼容）；
//     否则字符串走 byteLength=undefined → 8MB 守门被绕过，可写任意字节（fix round 1 I-2）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getWorkspace } from '../workspace/crud';
import { WorkspaceFS } from './workspace-fs';

/** 单张降采样图片字节上限（spec §5）——降采样后约 300KB；8MB 即 renderer 降采样被绕过 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 落盘目录相对路径（spec §5：`<workspace>/.momo/assets/`）；导出供 asset-read-ipc 白名单 regex 复用（命名耦合单点） */
export const ASSETS_REL_DIR = '.momo/assets';

/** 扩展名白名单（spec §5：renderer 降采样后只产 png/jpg；运行期再校验一次 defense in depth） */
const ALLOWED_EXTS = new Set(['png', 'jpg']);

export type AssetImageExt = 'png' | 'jpg';

export interface AssetDeps {
  /** 注入即完全接管 workspace 目录解析（测试用；生产路径依赖 SQLite） */
  workspaceDir?: (workspaceId: string) => string | null;
}

let deps: AssetDeps = {};
/** 测试注入点：绕过 getWorkspace 的 DB 查询（与 im/context-expander.setExpanderDeps 同款） */
export function setAssetDeps(d: AssetDeps): void {
  deps = d;
}

/** runtime ext 白名单校验（类型层已限 union，运行期再兜一道） */
function ensureExt(ext: string): AssetImageExt {
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`asset:saveImage 失败：扩展名必须是 png 或 jpg，收到 "${ext}"`);
  }
  return ext as AssetImageExt;
}

/**
 * workspace 目录解析：注入优先，生产走 getWorkspace（momo-test-rules 铁律 5）。
 * 这里与 context-expander 不同——asset:saveImage 不能「静默降级」，未知 workspace
 * 必须抛错（spec §11 错误矩阵：asset 失败 → 渲染端不插 pill + 错误 toast，输入不受影响）。
 */
function workspaceDirOf(workspaceId: string): string {
  const injected = deps.workspaceDir?.(workspaceId);
  if (injected !== undefined && injected !== null) return injected;
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`asset:saveImage 失败：workspace 不存在 (id=${workspaceId})`);
  }
  return ws.directoryPath;
}

/**
 * 主入口：保存图片到 `<workspace>/.momo/assets/<sha1[0:12]>.<ext>` 并返回相对路径。
 * 同 hash 已存在直接复用（fs.existsSync 短路），不重写不覆盖；持久断电防半截：tmp + rename。
 *
 * 关键顺序（fix round 1 I-1）：workspace + 路径推导 → WorkspaceFS 验证 → mkdir。
 * 验证在 mkdir 之前——否则 bash 等工具在 workspace 内植入
 * `.momo/assets` symlink 后（攻击面见 I-1），mkdirSync 跟随符号链接在 workspace
 * 外创建目录，反而开新攻击面。
 */
export async function saveImage(
  workspaceId: string,
  data: Uint8Array,
  ext: AssetImageExt,
): Promise<{ path: string }> {
  // 0) data 运行时类型校验：字符串 / 数字 / 对象等的 .byteLength === undefined，
  //    与 8MB 比较返回 false 守门失效——必须先拒。Buffer 继承 Uint8Array 也命中。
  if (!(data instanceof Uint8Array)) {
    throw new Error(
      `asset:saveImage 失败：data 必须是 Uint8Array，收到 ${data === null ? 'null' : typeof data}`,
    );
  }

  const safeExt = ensureExt(ext);

  // 1) 尺寸守门（前置：在做 hash + IO 之前拒，节省 CPU / IO）
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `asset:saveImage 失败：图片大小 ${data.byteLength} 字节超过上限 ${MAX_IMAGE_BYTES} 字节（8MB）`,
    );
  }

  // 2) workspace 解析
  const wsDirRaw = workspaceDirOf(workspaceId);
  const wsDir = path.resolve(wsDirRaw);

  // 3) 内容寻址：sha1 前 12 hex 作为文件名主体
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
  const filename = `${hash}.${safeExt}`;

  // 4) 路径推导（相对 workspace 根——assertInWorkspace 接受相对路径）
  const targetRel = `${ASSETS_REL_DIR}/${filename}`;
  const tmpRel = `${targetRel}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  // 5) 路径囚禁：复用 WorkspaceFS.assertInWorkspace（字符串边界 + 符号链接
  //    anchor-realpath 逃逸 + .git 保护——三层一起）。**在 mkdir 之前**：避免跟随
  //    被植入的 symlink 在 workspace 外创建目录。tmp 也要校验——防止落入 escape 路径。
  const wsFs = new WorkspaceFS(wsDir);
  wsFs.assertInWorkspace(targetRel);
  wsFs.assertInWorkspace(tmpRel);

  // 6) assets dir 确保存在（验证通过后才允许创建）
  const assetsAbs = path.join(wsDir, ASSETS_REL_DIR);
  fs.mkdirSync(assetsAbs, { recursive: true });

  // 7) 同 hash 已存在 → 短路返回（不重写；mtime/字节不被覆盖——内容寻址语义）
  const targetAbs = path.join(assetsAbs, filename);
  if (fs.existsSync(targetAbs)) {
    return { path: targetRel };
  }

  // 8) 原子写：tmp-<pid>-<rand> → rename(target)。崩溃场景下不会留半截（rename 原子）。
  const tmpAbs = path.join(assetsAbs, path.basename(tmpRel));
  try {
    // 把 Uint8Array 写入 tmp：Buffer 写法直接 share 底层 ArrayBuffer
    await fs.promises.writeFile(tmpAbs, Buffer.from(data));
    // sync rename 在同一目录内是原子的（POSIX rename(2) / win32 MoveFileEx 等义）
    fs.renameSync(tmpAbs, targetAbs);
  } catch (err) {
    // tmp 半截清掉；target 不应存在
    try {
      if (fs.existsSync(tmpAbs)) fs.rmSync(tmpAbs);
    } catch {
      // 静默：清理失败不应掩盖原始错误
    }
    logger.warn('asset:saveImage 写盘失败', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.info('asset:saveImage 已写入', {
    workspaceId,
    path: targetRel,
    bytes: data.byteLength,
  });

  // 9) 返回相对路径（'/' 分隔，与 file: 系列 IPC 路径契约一致——spec §5）
  return { path: targetRel };
}

/** IPC handler 注册：重复注册会被 Electron 拒绝，故只调一次 */
export function registerAssetHandlers(): void {
  ipcMain.handle(
    'asset:saveImage',
    async (_evt, workspaceId: string, data: Uint8Array, ext: 'png' | 'jpg') => {
      return saveImage(workspaceId, data, ext);
    },
  );
  logger.info('Asset IPC handlers 已注册');
}
