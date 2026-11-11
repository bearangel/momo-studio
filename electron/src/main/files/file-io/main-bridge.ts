// electron/src/main/files/file-io/main-bridge.ts
//
// 主进程侧 file-io 请求处理（spec §5.4）。runtime-spawner 的 messageHandler
// 分支调用；respond 由 spawn 闭包提供（通道关闭防御在调用方）。
import { getFileIoService } from './index';
import type { FileIoService } from './file-io-service';

type Respond = (payload: Record<string, unknown>) => void;

export async function handleFileIoRequestMsg(
  msg: unknown,
  respond: Respond,
  svc: Pick<FileIoService, 'readFile' | 'writeFile' | 'readFiles'> = getFileIoService(),
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
  try {
    if (m.op === 'read' && typeof m.path === 'string') {
      const buf = await svc.readFile(m.path);
      respond({ type: 'file-io:resp', requestId, ok: true, dataBase64: buf.toString('base64') });
    } else if (m.op === 'write' && typeof m.path === 'string' && typeof m.dataBase64 === 'string') {
      await svc.writeFile(m.path, Buffer.from(m.dataBase64, 'base64'));
      respond({ type: 'file-io:resp', requestId, ok: true });
    } else if (m.op === 'readMany' && Array.isArray(m.paths)) {
      const bufs = await svc.readFiles(m.paths.map((p) => String(p)));
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
