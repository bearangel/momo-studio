// electron/tests/files/asset-read-ipc.test.ts
//
// asset:readDataUrl IPC 测试：气泡缩略图读图通道（2026-09-26 多模态 spec §10）。
// momo-test-rules：真实 fs（不 mock fs）；workspace 定位经 setAssetReadDeps 注入
// （与 asset-ipc.setAssetDeps 同款）；vi.mock 锁 ipcMain 注册与 getWorkspace 解耦。
// 覆盖：
//   - 与 saveImage 往返：读回 data URL 前缀匹配 mime + base64 解码字节相等（png/jpg）
//   - 路径白名单 regex 拒绝：../ 穿越 / 非前缀目录 / 绝对路径 / 短 hash / 大写 hex /
//     大写 ext / 多余尾段
//   - 缺文件 → 中文错误
//   - 8MB 读上限 → 中文错误
//   - 符号链接逃逸（assets 目录级 + 文件级）→ WorkspaceFS 拒绝
//   - 未知 workspace → 中文错误
//   - IPC 通道注册 + handler 委托
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// vi.mock 提升到所有 import 之前；被工厂引用的 mock helper 必须 vi.hoisted。
const { ipcHandlers, getWorkspaceMock } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    ipcHandlers,
    getWorkspaceMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: getWorkspaceMock,
}));

import * as assetModule from '../../src/main/files/asset-ipc';
import * as assetReadModule from '../../src/main/files/asset-read-ipc';

const tmpRoot = path.join(os.tmpdir(), `ap-asset-read-${process.pid}-${Date.now()}`);

/** 1×1 透明 PNG 标准字节序列（67 字节）——与 asset-ipc.test.ts 同源 */
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x64, 0x60, 0x60, 0x00,
  0x00, 0x00, 0x04, 0x00, 0x01, 0x0e, 0x8b, 0x8c, 0x16, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 合法形状的 assets 相对路径（由 saveImage 真实产出，非手拼） */
function hashPath(data: Buffer, ext: 'png' | 'jpg'): string {
  const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 12);
  return `.momo/assets/${hash}.${ext}`;
}

let wsId: string;
let workspaceDir: string;

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  workspaceDir = path.join(tmpRoot, 'ws1');
  fs.mkdirSync(workspaceDir, { recursive: true });
  wsId = 'ws-asset-read-test';
  // 注入两侧 workspace 解析器：saveImage 与 readDataUrl 各自独立 deps（同款模式）
  assetModule.setAssetDeps({
    workspaceDir: (id) => (id === wsId ? workspaceDir : null),
  });
  assetReadModule.setAssetReadDeps({
    workspaceDir: (id) => (id === wsId ? workspaceDir : null),
  });
});

afterAll(() => {
  assetModule.setAssetDeps({});
  assetReadModule.setAssetReadDeps({});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const assetsDir = path.join(workspaceDir, '.momo', 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

describe('asset:readDataUrl 往返（与 saveImage 对拍）', () => {
  it('png：saveImage 落盘 → readDataUrl 读回 data URL，前缀匹配 mime + 字节相等', async () => {
    const saved = await assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'png');

    const dataUrl = await assetReadModule.readDataUrl(wsId, saved.path);

    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const b64 = dataUrl.slice('data:image/png;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(PNG_1X1)).toBe(true);
  });

  it('jpg：mime 映射为 image/jpeg', async () => {
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...PNG_1X1]);
    const saved = await assetModule.saveImage(wsId, new Uint8Array(jpgBytes), 'jpg');

    const dataUrl = await assetReadModule.readDataUrl(wsId, saved.path);

    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('asset:readDataUrl 路径白名单拒绝', () => {
  it.each([
    ['../ 穿越', '../ws2/.momo/assets/0123456789ab.png'],
    ['段内 ../ 穿越', '.momo/assets/../../0123456789ab.png'],
    ['非 assets 前缀目录', 'evil/0123456789ab.png'],
    ['无 .momo 前缀', 'assets/0123456789ab.png'],
    ['绝对路径', path.join(os.tmpdir(), '0123456789ab.png')],
    ['短 hash（非 12 位 hex）', '.momo/assets/short.png'],
    ['长 hash（13 位）', '.momo/assets/0123456789abc.png'],
    ['大写 hex（非 [0-9a-f]）', '.momo/assets/ABCDEF012345.png'],
    ['大写扩展名', '.momo/assets/0123456789ab.PNG'],
    ['白名单外扩展名', '.momo/assets/0123456789ab.gif'],
    ['多余尾段', '.momo/assets/0123456789ab.png/x'],
    ['纯目录', '.momo/assets'],
  ])('%s → 抛中文错误', async (_label, evilPath: string) => {
    await expect(assetReadModule.readDataUrl(wsId, evilPath)).rejects.toThrow(
      /readDataUrl|路径/,
    );
  });

  it('非字符串类型（运行期防御）→ 抛错', async () => {
    await expect(
      assetReadModule.readDataUrl(wsId, null as unknown as string),
    ).rejects.toThrow();
  });
});

describe('asset:readDataUrl 文件级错误', () => {
  it('路径合法但文件缺失 → 抛中文错误', async () => {
    await expect(
      assetReadModule.readDataUrl(wsId, '.momo/assets/0123456789ab.png'),
    ).rejects.toThrow(/不存在|无法读取|失败/);
  });

  it('文件超过 8MB 读上限 → 抛中文错误', async () => {
    // saveImage 会拒 9MB，所以直接手写一个合法命名的大文件（模拟被外部工具放大的存量资产）
    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const bigPath = hashPath(Buffer.alloc(9 * 1024 * 1024, 0x20), 'png');
    fs.writeFileSync(path.join(workspaceDir, bigPath), Buffer.alloc(9 * 1024 * 1024, 0x20));

    await expect(assetReadModule.readDataUrl(wsId, bigPath)).rejects.toThrow(/8\s?MB|上限/);
  });

  it('恰好 8MB 边界内 → 正常读回（上限是 >，不是 >=）', async () => {
    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    // 8MB 整：名字 hash 与内容无关（hash 由内容算出即可，直接用同一 buffer 算）
    const buf = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const rel = hashPath(buf, 'png');
    fs.writeFileSync(path.join(workspaceDir, rel), buf);

    const dataUrl = await assetReadModule.readDataUrl(wsId, rel);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('asset:readDataUrl 路径逃逸防御（WorkspaceFS 层）', () => {
  it('assets 目录被替换为指向 workspace 外的 symlink → WorkspaceFS 拒绝', async () => {
    const outsideDir = path.join(tmpRoot, 'attacker-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    // 在外面放一个「合法命名」文件，诱导读出去
    const rel = hashPath(PNG_1X1, 'png');
    fs.writeFileSync(path.join(outsideDir, path.basename(rel)), PNG_1X1);

    fs.mkdirSync(path.join(workspaceDir, '.momo'), { recursive: true });
    const symlinkPath = path.join(workspaceDir, '.momo', 'assets');
    fs.symlinkSync(outsideDir, symlinkPath);

    try {
      await expect(assetReadModule.readDataUrl(wsId, rel)).rejects.toThrow(); // 「符号链接逃逸」
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('单个文件是指向 workspace 外的 symlink → WorkspaceFS 拒绝', async () => {
    const outsideDir = path.join(tmpRoot, 'attacker-outside-2');
    fs.mkdirSync(outsideDir, { recursive: true });
    const rel = hashPath(PNG_1X1, 'png');
    fs.writeFileSync(path.join(outsideDir, 'payload.png'), PNG_1X1);

    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.symlinkSync(
      path.join(outsideDir, 'payload.png'),
      path.join(assetsDir, path.basename(rel)),
    );

    try {
      await expect(assetReadModule.readDataUrl(wsId, rel)).rejects.toThrow();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('asset:readDataUrl workspace 解析', () => {
  it('未知 workspace → 抛中文错误', async () => {
    await expect(
      assetReadModule.readDataUrl('no-such-ws', '.momo/assets/0123456789ab.png'),
    ).rejects.toThrow(/workspace 不存在/);
  });
});

describe('asset:readDataUrl IPC 注册', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    assetReadModule.registerAssetReadHandlers();
  });

  it('注册 asset:readDataUrl 通道', () => {
    expect(ipcHandlers.has('asset:readDataUrl')).toBe(true);
  });

  it('IPC handler 委托给 readDataUrl（往返 saveImage 产物）', async () => {
    const handler = ipcHandlers.get('asset:readDataUrl');
    if (!handler) throw new Error('asset:readDataUrl 未注册');
    const saved = await assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'png');
    const result = (await handler({}, wsId, saved.path)) as string;
    expect(result.startsWith('data:image/png;base64,')).toBe(true);
  });
});
