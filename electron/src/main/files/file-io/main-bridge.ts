// electron/src/main/files/file-io/main-bridge.ts
//
// 主进程侧 file-io 请求处理（spec §5.4）。runtime-spawner 的 messageHandler
// 分支调用；respond 由 spawn 闭包提供（通道关闭防御在调用方）。
//
// I1（安全，2026-11-11 终审）：代理读写在非沙箱主进程执行，子进程侧输入
// （含插件工具直发消息）不可信——opts.workspaceDir 提供时对每个 path / paths
// 做工作空间囚禁校验（isInsideDir），越界即 EBADREQ 拒绝且不触碰服务。
// M1（安全，2026-11-13 审查跟进）：字符串囚禁之上叠加 symlink 防线——工作
// 空间内的符号链接可让「文本在内、realpath 在外」的路径过检，再由未沙箱
// worker 穿透读写策略外目标（macOS/Linux confined 模式构成写域/敏感目录
// 遮蔽旁路）。复用 WorkspaceFS.assertInWorkspace 的锚点上溯语义：目标最近
// 存在祖先 realpath 后必须仍落在工作空间 realpath 内；realpath 异常
// （symlink 环等病态构造）按越界拒绝（fail-closed）。
import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../../platform/paths';
import { logger } from '../../logger';
import { getFileIoService } from './index';
import type { FileIoService } from './file-io-service';

type Respond = (payload: Record<string, unknown>) => void;

export interface FileIoBridgeOpts {
  /** 工作空间目录（提供即启用主进程侧路径囚禁；缺省保持遗留行为） */
  workspaceDir?: string;
}

const MSG_PATH_ESCAPE = '路径越界：文件读写请求超出工作空间';

/**
 * symlink 防线（M1）：target 的最近存在祖先（支持尚不存在的写目标）realpath
 * 后必须等于工作空间 realpath 根或位于其下。存在性判定用 lstat 语义——
 * stat 会跟随链接：悬链（dangling，stat ENOENT）会被跳过上溯到根而放行，
 * 写入经 worker 的 writeFileSync 会穿透悬链在链接目标处创建文件；symlink
 * 环同理（stat ELOOP 失败）。lstat 下锚点即链接本身，realpath 抛错（悬链
 * ENOENT / 环 ELOOP）按越界拒（fail-closed）。
 */
function insideViaRealpath(workspaceRealRoot: string, target: string): boolean {
  const existsViaLstat = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  let anchor = path.resolve(target);
  while (anchor !== path.dirname(anchor) && !existsViaLstat(anchor)) {
    anchor = path.dirname(anchor);
  }
  try {
    const realAnchor = fs.realpathSync(anchor);
    return realAnchor === workspaceRealRoot || realAnchor.startsWith(workspaceRealRoot + path.sep);
  } catch {
    return false;
  }
}

export async function handleFileIoRequestMsg(
  msg: unknown,
  respond: Respond,
  svc: Pick<FileIoService, 'readFile' | 'writeFile' | 'readFiles'> = getFileIoService(),
  opts?: FileIoBridgeOpts,
): Promise<boolean> {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as {
    type?: string;
    requestId?: unknown;
    op?: unknown;
    path?: unknown;
    paths?: unknown;
    dataBase64?: unknown;
  };
  if (m.type !== 'file-io:req' || typeof m.requestId !== 'string') return false;
  const requestId = m.requestId;
  const workspaceDir = opts?.workspaceDir;
  // 越界即拒：校验失败不触碰 svc（拒绝动作本身零副作用）；isInsideDir 两侧
  // path.resolve 归一 + 分隔符边界前缀比对（兄弟前缀碰撞不误伤）；字符串
  // 命中后再过 symlink 防线（M1，见文件头注）——工作空间根 realpath 每请求
  // 至多解析一次，失败按 fail-closed 拒绝。
  let workspaceRealRoot: string | null | undefined;
  const denyIfOutside = (pathsToCheck: string[]): boolean => {
    if (workspaceDir === undefined) return false;
    const offender = pathsToCheck.find((p) => {
      if (!isInsideDir(workspaceDir, p, { win32: PATH_SEMANTICS_WIN32 })) return true;
      if (workspaceRealRoot === undefined) {
        try {
          workspaceRealRoot = fs.realpathSync(path.resolve(workspaceDir));
        } catch {
          workspaceRealRoot = null;
        }
      }
      if (workspaceRealRoot === null) return true;
      return !insideViaRealpath(workspaceRealRoot, p);
    });
    if (offender === undefined) return false;
    logger.warn('file-io 桥拒绝越界路径请求', { workspaceDir, offender });
    respond({
      type: 'file-io:resp',
      requestId,
      ok: false,
      error: { code: 'EBADREQ', message: MSG_PATH_ESCAPE },
    });
    return true;
  };
  try {
    if (m.op === 'read' && typeof m.path === 'string') {
      if (denyIfOutside([m.path])) return true;
      const buf = await svc.readFile(m.path);
      respond({ type: 'file-io:resp', requestId, ok: true, dataBase64: buf.toString('base64') });
    } else if (m.op === 'write' && typeof m.path === 'string' && typeof m.dataBase64 === 'string') {
      if (denyIfOutside([m.path])) return true;
      await svc.writeFile(m.path, Buffer.from(m.dataBase64, 'base64'));
      respond({ type: 'file-io:resp', requestId, ok: true });
    } else if (m.op === 'readMany' && Array.isArray(m.paths)) {
      const paths = m.paths.map((p) => String(p));
      if (denyIfOutside(paths)) return true;
      const bufs = await svc.readFiles(paths);
      respond({
        type: 'file-io:resp',
        requestId,
        ok: true,
        items: bufs.map((b) => ({ ok: true, dataBase64: b.toString('base64') })),
      });
    } else {
      respond({
        type: 'file-io:resp',
        requestId,
        ok: false,
        error: { code: 'EBADREQ', message: '非法 file-io 请求' },
      });
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    respond({
      type: 'file-io:resp',
      requestId,
      ok: false,
      error: {
        code: typeof e.code === 'string' ? e.code : 'EUNKNOWN',
        message: typeof e.message === 'string' ? e.message : String(err),
      },
    });
  }
  return true;
}
