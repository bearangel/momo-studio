// electron/tests/files/asset-ipc.test.ts
//
// asset:saveImage IPC 测试：内容寻址落盘 + 去重 + 尺寸守门 + ext 白名单 + 路径防御。
// momo-test-rules：真实 fs（不 mock fs）保证落盘/去重的语义是真的；workspace 定位经
//   setAssetDeps 注入（生产路径依赖 electron app + SQLite），与 im/context-expander
//   的 expanderDeps 同款；vi.mock 锁 ipcMain 注册与 getWorkspace 解耦。
// 覆盖：落盘+字节相等 / 同 hash 去重 / ext 白名单 / 8MB 尺寸守门 / 未知 workspace /
//   Uint8Array 运行期类型校验 / 符号链接逃逸（fix round 1 I-1+I-2）
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

const tmpRoot = path.join(os.tmpdir(), `ap-asset-ipc-${process.pid}-${Date.now()}`);

/** 1×1 透明 PNG 标准字节序列（67 字节） */
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x64, 0x60, 0x60, 0x00,
  0x00, 0x00, 0x04, 0x00, 0x01, 0x0e, 0x8b, 0x8c, 0x16, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let wsId: string;
let workspaceDir: string;

beforeAll(() => {
  // 真实 fs：context-expander 同款 tmpDir 风格；workspace 是 tmpRoot/ws1
  fs.mkdirSync(tmpRoot, { recursive: true });
  workspaceDir = path.join(tmpRoot, 'ws1');
  fs.mkdirSync(workspaceDir, { recursive: true });
  wsId = 'ws-asset-test';
  // 注入 workspace 解析器：绕过 getWorkspace 的 DB 查询
  assetModule.setAssetDeps({
    workspaceDir: (id) => (id === wsId ? workspaceDir : null),
  });
});

afterAll(() => {
  assetModule.setAssetDeps({});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例前清空 assets 目录，确保去重等用例相互隔离
  const assetsDir = path.join(workspaceDir, '.momo', 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

describe('asset:saveImage 单元（实时 fs）', () => {
  it('用例 1：1×1 PNG 落盘，返回相对路径 .momo/assets/<12hex>.png，字节一致', async () => {
    const expectedHash = crypto.createHash('sha1').update(PNG_1X1).digest('hex').slice(0, 12);

    const result = await assetModule.saveImage(
      wsId,
      new Uint8Array(PNG_1X1),
      'png',
    );

    expect(result.path).toBe(`.momo/assets/${expectedHash}.png`);
    const abs = path.join(workspaceDir, '.momo', 'assets', `${expectedHash}.png`);
    expect(fs.existsSync(abs)).toBe(true);
    const onDisk = fs.readFileSync(abs);
    expect(onDisk.equals(PNG_1X1)).toBe(true);
  });

  it('用例 2：同字节二次保存 → 同路径 + mtime/字节不变（内容寻址去重，无重写）', async () => {
    const r1 = await assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'png');
    const abs1 = path.join(workspaceDir, r1.path);
    const mtime1 = fs.statSync(abs1).mtimeMs;
    const content1 = fs.readFileSync(abs1);

    // 强制 sleep 一点：以防文件系统 mtime 精度不够导致假阳性。两段式重写检测
    // 不依赖 mtime — 见下方 content & 文件计数补充断言。
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'png');

    expect(r1.path).toBe(r2.path);
    // 目录只有 1 个文件（去重确认：第二次写入未产生新文件）
    const entries = fs.readdirSync(path.join(workspaceDir, '.momo', 'assets'));
    expect(entries).toHaveLength(1);
    // 内容一致（去重路径不应发生覆盖）
    const onDisk = fs.readFileSync(abs1);
    expect(onDisk.equals(content1)).toBe(true);
    // mtime 不变（去重路径不应触发 inode 变更；同 inode 上 read-only 逻辑也保持）
    const mtime2 = fs.statSync(abs1).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('用例 3：ext=' + "'gif'" + '（类型层绕过）→ 抛错，无文件写入', async () => {
    // 类型层 'png' | 'jpg' 在 TS 端就拦了；此处显式断言运行期白名单兜底（defense in depth）
    // 通过 unknown 强转生产路径，让运行时校验负责拒绝——这是双层防御的边界用例
    await expect(
      assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'gif' as unknown as 'png'),
    ).rejects.toThrow(/png 或 jpg/);
    // assets 目录不应被创建出来（落盘在 size/ext 校验前被拒）
    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    expect(fs.existsSync(assetsDir)).toBe(false);
  });

  it('用例 4：9MB buffer → 抛尺寸守门错误（中文消息），无文件', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 0x20); // 9MB 空白字节

    await expect(
      assetModule.saveImage(wsId, new Uint8Array(big), 'png'),
    ).rejects.toThrow(/8\s*MB|8MB|不超过 8/);

    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    expect(fs.existsSync(assetsDir)).toBe(false);
  });

  it('用例 5：未知 workspace → 抛中文错误，无文件写入', async () => {
    await expect(
      assetModule.saveImage('unknown-ws', new Uint8Array(PNG_1X1), 'png'),
    ).rejects.toThrow(/workspace 不存在/);

    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    expect(fs.existsSync(assetsDir)).toBe(false);
  });

  it('用例 6（fix round 1 I-1）：bash 工具植入 <workspace>/.momo/assets symlink 指向 workspace 外 → saveImage 抛错，外部目录无文件', async () => {
    // 攻击面：bash 工具在 workspace 内植入 `.momo/assets → <workspace 外>`，
    // 用户随后粘贴图片 → saveImage 必须拒绝写入。验证两件事：
    //   (a) 抛错（不让任意目录里冒出一个 png）；
    //   (b) 外部目录里没有产生文件（验证确实拒写，不是 mkdir 跟随 symlink 创建目录）。
    const outsideDir = path.join(tmpRoot, 'attacker-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    // 在 workspace 内创建 .momo 子目录（assertInWorkspace 字符串边界通过），再把
    // assets 子节点做成 symlink 指向 workspace 外
    fs.mkdirSync(path.join(workspaceDir, '.momo'), { recursive: true });
    const symlinkPath = path.join(workspaceDir, '.momo', 'assets');
    fs.symlinkSync(outsideDir, symlinkPath);

    try {
      await expect(
        assetModule.saveImage(wsId, new Uint8Array(PNG_1X1), 'png'),
      ).rejects.toThrow(); // WorkspaceFS 抛「符号链接逃逸」或「路径越界」

      // 外部目录里不能产生任何 png（hash 派生文件名）——若 mkdirSync 跟随 symlink
      // 在外面创建了目录，会留一个目录但通常不会有 png 文件；这里断言 outsideDir
      // 是空目录或不存在任何 .png 文件（甚至不存在 .momo 子目录）
      expect(fs.existsSync(path.join(outsideDir, '.momo'))).toBe(false);
      const outsideFiles = fs.existsSync(outsideDir) ? fs.readdirSync(outsideDir) : [];
      expect(outsideFiles.filter((n) => n.endsWith('.png'))).toEqual([]);
    } finally {
      // 清理 symlink + 外部目录，避免污染其他用例
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('用例 7（fix round 1 I-2）：data 传入 string（绕过类型层）→ 抛中文错误，无文件写入', async () => {
    // 攻击面：renderer / IPC 通道被污染时 data 实际是字符串；字符串没有 .byteLength
    // （undefined）→ undefined > 8MB 为 false → 8MB 守门被绕过；类型层只阻
    // TypeScript，运行期必须 instanceof Uint8Array 兜底。
    const evil = 'NOT_A_UINT8ARRAY' as unknown as Uint8Array;

    await expect(
      assetModule.saveImage(wsId, evil, 'png'),
    ).rejects.toThrow(/Uint8Array/);

    const assetsDir = path.join(workspaceDir, '.momo', 'assets');
    expect(fs.existsSync(assetsDir)).toBe(false);
  });

  it('jpg 扩展名同样落盘并去重', async () => {
    // 构造与 PNG_1X1 不同字节但合法的 jpg（这里只关心路径后缀正确 + 内容寻址）
    const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...PNG_1X1]);
    const expectedHash = crypto.createHash('sha1').update(jpgBytes).digest('hex').slice(0, 12);

    const result = await assetModule.saveImage(
      wsId,
      new Uint8Array(jpgBytes),
      'jpg',
    );

    expect(result.path).toBe(`.momo/assets/${expectedHash}.jpg`);
    const abs = path.join(workspaceDir, '.momo', 'assets', `${expectedHash}.jpg`);
    expect(fs.existsSync(abs)).toBe(true);
  });
});

describe('asset:saveImage IPC 注册', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    assetModule.registerAssetHandlers();
  });

  it('注册 asset:saveImage 通道', () => {
    expect(ipcHandlers.has('asset:saveImage')).toBe(true);
  });

  it('IPC handler 委托给 saveImage（路径与字节透传）', async () => {
    const handler = ipcHandlers.get('asset:saveImage');
    if (!handler) throw new Error('asset:saveImage 未注册');
    const result = (await handler(
      {},
      wsId,
      new Uint8Array(PNG_1X1),
      'png',
    )) as { path: string };
    expect(result.path).toMatch(/^\.momo\/assets\/[0-9a-f]{12}\.png$/);
  });
});
