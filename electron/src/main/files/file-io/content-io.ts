// electron/src/main/files/file-io/content-io.ts
//
// WorkspaceFS 内容通道实现（spec §5.3）。direct = 本地 fs + 密文硬失败；
// proxy = 委托 FileIoService（主进程直连）或 file-io-bridge（子进程）。
import fs from 'node:fs';
import path from 'node:path';
import { looksEncrypted } from './cipher-detect';
import { FileIoError, MSG_DIRECT_CIPHER, type ContentIo } from './types';

export class DirectContentIo implements ContentIo {
  constructor(private readonly strictCipherCheck: boolean) {}

  async readFile(absPath: string): Promise<Buffer> {
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(absPath);
    } catch (e) {
      throw new FileIoError('EREAD', `读取失败: ${absPath} — ${(e as Error).message}`);
    }
    if (this.strictCipherCheck && looksEncrypted(buf)) {
      throw new FileIoError('EENCRYPTED', `${MSG_DIRECT_CIPHER}（${absPath}）`);
    }
    return buf;
  }

  /** 批量读：顺序复用单文件逻辑（含 strict 密文硬失败语义），任一失败整批抛错 */
  async readFiles(absPaths: string[]): Promise<Buffer[]> {
    const out: Buffer[] = [];
    for (const p of absPaths) {
      out.push(await this.readFile(p));
    }
    return out;
  }

  async writeFile(absPath: string, data: Buffer): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, data);
    } catch (e) {
      throw new FileIoError('EWRITE', `写入失败: ${absPath} — ${(e as Error).message}`);
    }
  }
}

/** proxy 通道：委托给 FileIoService（主进程）或 BridgeContentIo（子进程）同构接口 */
export class ProxyContentIo implements ContentIo {
  constructor(
    private readonly io: {
      readFile(p: string): Promise<Buffer>;
      readFiles(p: string[]): Promise<Buffer[]>;
      writeFile(p: string, data: Buffer): Promise<void>;
    },
  ) {}

  readFile(p: string): Promise<Buffer> {
    return this.io.readFile(p);
  }

  readFiles(p: string[]): Promise<Buffer[]> {
    return this.io.readFiles(p);
  }

  writeFile(p: string, data: Buffer): Promise<void> {
    return this.io.writeFile(p, data);
  }
}
