// electron/tests/files/file-io/file-io-service.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileIoService, findNodePath } from '../../../src/main/files/file-io/file-io-service';
import type { ResolvedFileIoSettings } from '../../../src/main/files/file-io/file-io-settings';
import { MSG_DIRECT_CIPHER } from '../../../src/main/files/file-io/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-worker.js');
const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

const DIRECT: ResolvedFileIoSettings = { mode: 'direct', nodePath: null, strictCipherCheck: true };
const PROXY: ResolvedFileIoSettings = { mode: 'proxy', nodePath: null, strictCipherCheck: true };

let dir: string;
const services: FileIoService[] = [];
function mkProxySvc(extra?: Partial<ConstructorParameters<typeof FileIoService>[0]>) {
  const svc = new FileIoService({
    settings: PROXY,
    workerPath: FIXTURE,
    nodePathOverride: process.execPath,
    ...extra,
  });
  services.push(svc);
  return svc;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-fileio-'));
});
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('direct 模式', () => {
  it('读明文正常', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello');
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    expect((await svc.readFile(p)).toString('utf8')).toBe('hello');
    expect(svc.effectiveMode()).toBe('direct');
  });

  it('读到密文 → EENCRYPTED 硬失败（中性文案）', async () => {
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    await expect(svc.readFile(p)).rejects.toMatchObject({ code: 'EENCRYPTED' });
    await expect(svc.readFile(p)).rejects.toThrow(MSG_DIRECT_CIPHER);
  });

  it('strictCipherCheck=false 时原样返回（逃生口）', async () => {
    const p = path.join(dir, 'Enc2.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    const svc = new FileIoService({
      settings: { ...DIRECT, strictCipherCheck: false },
    });
    services.push(svc);
    expect((await svc.readFile(p)).equals(CIPHER_HEAD)).toBe(true);
  });

  it('写文件自动建父目录', async () => {
    const p = path.join(dir, 'x', 'y', 'B.java');
    const svc = new FileIoService({ settings: DIRECT });
    services.push(svc);
    await svc.writeFile(p, Buffer.from('class B {}'));
    expect(fs.readFileSync(p, 'utf8')).toBe('class B {}');
  });
});

describe('proxy 模式（真实子进程 + fake worker）', () => {
  it('读 / 写 / 批量读 roundtrip', async () => {
    const svc = mkProxySvc();
    const p1 = path.join(dir, 'One.java');
    await svc.writeFile(p1, Buffer.from('class One {}'));
    expect((await svc.readFile(p1)).toString('utf8')).toBe('class One {}');

    const p2 = path.join(dir, 'Two.java');
    fs.writeFileSync(p2, 'class Two {}');
    const bufs = await svc.readFiles([p1, p2]);
    expect(bufs.map((b) => b.toString('utf8'))).toEqual(['class One {}', 'class Two {}']);
  });

  it('批量 120 文件（batch=50）按序完整返回', async () => {
    const svc = mkProxySvc({ batchSize: 50 });
    const paths = Array.from({ length: 120 }, (_, i) => {
      const p = path.join(dir, `f${String(i).padStart(3, '0')}.txt`);
      fs.writeFileSync(p, `content-${i}`);
      return p;
    });
    const bufs = await svc.readFiles(paths);
    expect(bufs).toHaveLength(120);
    bufs.forEach((b, i) => expect(b.toString('utf8')).toBe(`content-${i}`));
  });

  it('proxy 仍读到密文 → EENCRYPTED', async () => {
    const svc = mkProxySvc();
    const p = path.join(dir, 'Enc.java');
    fs.writeFileSync(p, CIPHER_HEAD);
    await expect(svc.readFile(p)).rejects.toMatchObject({ code: 'EENCRYPTED' });
  });

  it('spawn 的 env 完整继承 process.env（PATH 约束回归锁）', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const svc = new FileIoService({
      settings: PROXY,
      workerPath: FIXTURE,
      nodePathOverride: process.execPath,
      spawnImpl: (cmd, args, opts) => {
        capturedEnv = opts.env;
        return spawn(cmd, args, opts);
      },
    });
    services.push(svc);
    const p = path.join(dir, 'env.txt');
    fs.writeFileSync(p, 'x');
    await svc.readFile(p);
    expect(capturedEnv).toBe(process.env); // 引用相同——不经任何复制/sanitize
    expect(capturedEnv?.PATH ?? capturedEnv?.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('worker 被杀 → 在途请求 ECHILD，随后请求自愈重启成功', async () => {
    const svc = mkProxySvc();
    const normal = path.join(dir, 'ok.txt');
    fs.writeFileSync(normal, 'ok');
    await svc.readFile(normal); // 确保 worker 已启动
    const diePath = path.join(dir, 'die-now.txt');
    await expect(svc.readFile(diePath)).rejects.toMatchObject({ code: 'ECHILD' });
    // 自愈：下一次请求重新 spawn
    expect((await svc.readFile(normal)).toString('utf8')).toBe('ok');
  });

  it('spawn 同步失败 → ESPAWN，失败不缓存（下一请求自愈重试）', async () => {
    const normal = path.join(dir, 'ok.txt');
    fs.writeFileSync(normal, 'ok');
    let spawnCalls = 0;
    const svc = new FileIoService({
      settings: PROXY,
      workerPath: FIXTURE,
      nodePathOverride: process.execPath,
      spawnImpl: (cmd, args, opts) => {
        spawnCalls += 1;
        if (spawnCalls === 1) throw new Error('boom');
        return spawn(cmd, args, opts);
      },
    });
    services.push(svc);
    await expect(svc.readFile(normal)).rejects.toMatchObject({ code: 'ESPAWN' });
    // 回归锁：ensureWorker 不得把 rejected promise 缓存在 starting——
    // 否则失败被永久固化，applySettings 后也无法自愈
    expect((await svc.readFile(normal)).toString('utf8')).toBe('ok');
    expect(spawnCalls).toBe(2);
  });

  it('超时', async () => {
    const svc = mkProxySvc({ timeoutMs: 150 });
    const hang = path.join(dir, 'hang-now.txt');
    await expect(svc.readFile(hang)).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });
});

describe('node 解析', () => {
  it('显式 nodePath 无效 → ENONODE（不回退 PATH）', () => {
    expect(() => findNodePath(path.join(dir, 'nope', 'node'))).toThrowError(
      expect.objectContaining({ code: 'ENONODE' }),
    );
  });

  it('null → 找到可用 node（测试进程自身）', () => {
    expect(fs.existsSync(findNodePath(null))).toBe(true);
  });
});
