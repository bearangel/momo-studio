// electron/src/main/agent/tools/shared/cipher-gate.ts
//
// 工具层密文安全闸（spec 2026-11-11 补遗·B 方案全量收口，2026-11-12）。
// grep/edit_file/apply_patch/office 的失败模式是「密文当文本用」——假阴性
// 搜索、oldString 永不命中、垃圾解析——因此工具层在通道（strictCipherCheck）
// 之上再叠一层自检：读到 E-SafeNet 容器即拒绝，独立于通道设置。
// 快照类读取（journal before）走优雅降级：密文 → null 快照，主操作照常。
import { looksEncrypted } from '../../../files/file-io/cipher-detect';
import { FileIoError } from '../../../files/file-io/types';
import type { WorkspaceFS } from '../../../files/workspace-fs';

/** 拒绝型闸门文案（路径用调用方的展示形态——相对路径对 LLM 更可执行） */
export const CIPHER_REFUSE_MSG = (displayPath: string): string =>
  `文件已加密（E-SafeNet 容器），当前 IO 通道读到密文：${displayPath}`;

/** 通道读后自检：密文即抛 EENCRYPTED（宁报错不毁文件 / 不假阴性） */
export function assertNotCipher(buf: Buffer, displayPath: string): void {
  if (looksEncrypted(buf)) {
    throw new FileIoError('EENCRYPTED', CIPHER_REFUSE_MSG(displayPath));
  }
}

/**
 * 快照类读取（journal before / mv 内容快照）：经内容通道读取，密文 → null
 * （优雅降级，主操作照常）；EENCRYPTED 以外的读错误原样抛（保持既有失败
 * 语义——只有密文是「可识别的降级态」，权限/IO 错误仍应硬失败）。
 */
export async function readJournalSnapshot(
  wsFs: WorkspaceFS,
  relOrAbs: string,
): Promise<Buffer | null> {
  let buf: Buffer;
  try {
    buf = await wsFs.readFile(relOrAbs);
  } catch (err) {
    if (err instanceof FileIoError && err.code === 'EENCRYPTED') return null;
    throw err;
  }
  return looksEncrypted(buf) ? null : buf;
}
