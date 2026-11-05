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
 * 这里与 context-expander 不同——asset 通道不能「静默降级」，未知 workspace
 * 必须抛错（spec §11 错误矩阵：asset 失败 → 渲染端不插 pill + 错误提示，输入不受影响）。
 */
function workspaceDirOf(workspaceId: string, channel = 'asset:saveImage'): string {
  const injected = deps.workspaceDir?.(workspaceId);
  if (injected !== undefined && injected !== null) return injected;
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    throw new Error(`${channel} 失败：workspace 不存在 (id=${workspaceId})`);
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
  ipcMain.handle(
    'asset:importFile',
    async (_evt, workspaceId: string, data: Uint8Array, name: string) => {
      return importFile(workspaceId, data, name);
    },
  );
  logger.info('Asset IPC handlers 已注册');
}

/** 外部文件导入落盘目录（相对 workspace 根，2026-11-05 预览方案 A）：顶层 imports/——agent 文件工具可读、@ 搜索可命中（与 .momo/assets 的隐藏语义刻意区分） */
export const IMPORTS_REL_DIR = 'imports';

/** 单个导入文件字节上限：覆盖常见文档/表格/PDF；与 renderer MentionInput IMPORT_MAX_BYTES 同值（注释互指，改必两处） */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/**
 * 导入文件名清洗：basename 剥路径 + 控制字符剔除 + 长度截断（保扩展名）。
 * 文件名是用户心智与 agent 引用锚点，故不做内容寻址（与 saveImage 的差异点）；
 * 真正的越界防线是 assertInWorkspace，这里是入口消毒 + 友好报错。
 */
function sanitizeImportName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(`asset:importFile 失败：文件名必须是字符串，收到 ${raw === null ? 'null' : typeof raw}`);
  }
  let base = path.basename(raw).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (base === '' || base === '.' || base === '..') {
    throw new Error(`asset:importFile 失败：文件名非法，收到 "${raw}"`);
  }
  // basename 已剥 '/'（win32 也剥 '\\'）；残余分隔符（跨平台形态）直接拒——
  // POSIX 上字面反斜杠虽是合法文件名字符，但几乎必是注入尝试，拒之无副作用
  if (base.includes('/') || base.includes('\\')) {
    throw new Error('asset:importFile 失败：文件名不能包含路径分隔符');
  }
  // 文件系统单名上限 255 字节，CJK 多字节——按 120 字符截断保余量（保留扩展名）
  if (base.length > 120) {
    const ext = path.extname(base);
    base = `${base.slice(0, 120 - ext.length)}${ext}`;
  }
  return base;
}

/**
 * 主入口（2026-11-05 预览方案 A）：把外部文件字节复制到
 * `<workspace>/imports/<文件名>`，返回相对路径。重名自动加 " (N)" 后缀。
 * 安全范式与 saveImage 同层：类型守门 → 尺寸守门 → workspace 解析 →
 * assertInWorkspace（mkdir 之前）→ tmp + rename 原子写。
 */
export async function importFile(
  workspaceId: string,
  data: Uint8Array,
  name: unknown,
): Promise<{ path: string }> {
  if (!(data instanceof Uint8Array)) {
    throw new Error(
      `asset:importFile 失败：data 必须是 Uint8Array，收到 ${data === null ? 'null' : typeof data}`,
    );
  }
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(
      `asset:importFile 失败：文件大小 ${data.byteLength} 字节超过上限 ${MAX_IMPORT_BYTES} 字节（64MB）`,
    );
  }
  const base = sanitizeImportName(name);

  const wsDir = path.resolve(workspaceDirOf(workspaceId, 'asset:importFile'));
  const wsFs = new WorkspaceFS(wsDir);
  wsFs.assertInWorkspace(`${IMPORTS_REL_DIR}/${base}`);

  const importsAbs = path.join(wsDir, IMPORTS_REL_DIR);
  fs.mkdirSync(importsAbs, { recursive: true });

  // 重名加后缀：`需求文档 v2.md` → `需求文档 v2 (1).md`。后缀形由已清洗的
  // base 派生（无新分隔符），无需重复 assertInWorkspace
  let finalName = base;
  for (let n = 1; fs.existsSync(path.join(importsAbs, finalName)); n++) {
    if (n > 999) throw new Error(`asset:importFile 失败：同名文件过多（${base}）`);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    finalName = `${stem} (${n})${ext}`;
  }

  const targetRel = `${IMPORTS_REL_DIR}/${finalName}`;
  const tmpRel = `${targetRel}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  wsFs.assertInWorkspace(tmpRel);

  const targetAbs = path.join(importsAbs, finalName);
  const tmpAbs = path.join(importsAbs, path.basename(tmpRel));
  try {
    await fs.promises.writeFile(tmpAbs, Buffer.from(data));
    fs.renameSync(tmpAbs, targetAbs);
  } catch (err) {
    try {
      if (fs.existsSync(tmpAbs)) fs.rmSync(tmpAbs);
    } catch {
      // 静默：清理失败不应掩盖原始错误
    }
    logger.warn('asset:importFile 写盘失败', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.info('asset:importFile 已写入', {
    workspaceId,
    path: targetRel,
    bytes: data.byteLength,
  });
  return { path: targetRel };
}
