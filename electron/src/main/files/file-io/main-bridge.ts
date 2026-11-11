// electron/src/main/files/file-io/main-bridge.ts
//
// 主进程侧 file-io 请求处理（spec §5.4）。runtime-spawner 的 messageHandler
// 分支调用；respond 由 spawn 闭包提供（通道关闭防御在调用方）。
//
// I1（安全，2026-11-11 终审）：代理读写在非沙箱主进程执行，子进程侧输入
// （含插件工具直发消息）不可信——opts.workspaceDir 提供时对每个 path / paths
// 做工作空间囚禁校验（isInsideDir），越界即 EBADREQ 拒绝且不触碰服务。
import { isInsideDir } from '../../platform/paths';
import { logger } from '../../logger';
import { getFileIoService } from './index';
import type { FileIoService } from './file-io-service';

type Respond = (payload: Record<string, unknown>) => void;

export interface FileIoBridgeOpts {
  /** 工作空间目录（提供即启用主进程侧路径囚禁；缺省保持遗留行为） */
  workspaceDir?: string;
}

const MSG_PATH_ESCAPE = '路径越界：文件读写请求超出工作空间';

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
  // path.resolve 归一 + 分隔符边界前缀比对（兄弟前缀碰撞不误伤）
  const denyIfOutside = (pathsToCheck: string[]): boolean => {
    if (workspaceDir === undefined) return false;
    const offender = pathsToCheck.find((p) => !isInsideDir(workspaceDir, p));
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
