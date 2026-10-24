// electron/tests/marketplace/installer-origin.test.ts
//
// T8 回归锁：installPackage 下载源白名单（hub origin 信任集 + https 恒信）。
//
// 背景（spec M1 §6.2 / C2）：hub 是自建节点，origin 常为 http://host:port
// （明文），既有「downloadUrl 必须是 https」硬闸会把 hub 资源全部拒掉。
// 解法不是放开明文，而是引入**信任集**：studio 自身配置的 hubUrl 注册进
// installer 的模块级信任集，只有落在信任集 origin 下的地址才放行；https 恒放行
// （既有 marketplace 语义不变）。同一信任集同时约束 downloadFile() 的流式下载，
// 防止「installPackage 放行但流式下载再拒」的两段规则漂移。
//
// 覆盖：
//   1. 未注册 origin 的 http URL → installPackage 拒绝（不触网、不落缓存目录）
//   2. 未注册 origin 的 http URL → downloadFile 拒绝（同一规则）
//   3. 注册 origin 后同 http URL → installPackage 真安装成功（端到端放行）
//   4. https 恒放行（信任集为空也不受影响——既有 marketplace 语义不变）
//   5. origin 尾斜杠归一（注册 'http://h:1/' 放行 'http://h:1/resources/x'）
//   6. origin 边界（'http://h:1' 不放行 'http://h:1.evil.test/x'——前缀相似非同一源）
//   7. unregister 撤销：注册后撤销 → 旧 origin 的 http URL 复拒（归一一致，
//      F2——信任集必须可随忘记/换址收回，不能单调只增）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  installPackage,
  downloadFile,
  registerTrustedDownloadOrigin,
  unregisterTrustedDownloadOrigin,
  isTrustedDownloadUrl,
  __resetTrustedDownloadOriginsForTest,
} from '../../src/main/marketplace/installer';
import type { MarketplaceItem } from '../../src/main/marketplace/types';

const tmpRoot = path.join(os.tmpdir(), `ap-mp-origin-test-${Date.now()}`);
let fetchSpy: ReturnType<typeof vi.spyOn>;

function makeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'hub-skill',
    type: 'skill',
    slug: 'demo-skill',
    name: '演示技能',
    version: '1.0.0',
    author: 'tester',
    description: '一个测试用 skill',
    readme: '# 测试',
    tags: ['test'],
    category: 'dev',
    iconEmoji: '🧪',
    verificationStatus: 'unverified',
    downloadUrl: '',
    checksum: '',
    sizeBytes: 1,
    installCount: 0,
    ...overrides,
  };
}

/** 现场构造 tar.gz：files 写入相对路径 → 归档 → 返回归档绝对路径 */
function buildArchive(files: Record<string, string>): string {
  const srcDir = fs.mkdtempSync(path.join(tmpRoot, 'pkg-src-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(srcDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
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
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
  __resetTrustedDownloadOriginsForTest();
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  closeDb();
  __resetTrustedDownloadOriginsForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('T8: installPackage 下载源白名单（hub origin 信任集）', () => {
  it('未注册 origin 的 http URL → installPackage 拒绝（不触网、不落缓存目录）', async () => {
    const item = makeItem({ downloadUrl: 'http://127.0.0.1:9999/pkg.tar.gz' });
    await expect(installPackage(item)).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpRoot, 'cache'))).toBe(false);
  });

  it('未注册 origin 的 http URL → downloadFile 拒绝（与 installPackage 同规则）', async () => {
    const dest = path.join(tmpRoot, 'out.bin');
    await expect(downloadFile('http://127.0.0.1:9999/pkg.tar.gz', dest)).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('注册 origin 后同 http URL → installPackage 放行并安装成功', async () => {
    const archive = buildArchive({ 'SKILL.md': '# demo\n' });
    mockFetchFile(archive);
    registerTrustedDownloadOrigin('http://127.0.0.1:9999');

    const item = makeItem({ downloadUrl: 'http://127.0.0.1:9999/resources/demo-skill/1.0.0/download' });
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, 'SKILL.md'))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('https 恒放行（信任集为空也不受影响——既有 marketplace 语义不变）', async () => {
    const archive = buildArchive({ 'SKILL.md': '# demo\n' });
    mockFetchFile(archive);

    const item = makeItem({ downloadUrl: 'https://example.test/demo-skill.tar.gz' });
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, 'SKILL.md'))).toBe(true);
  });

  it('origin 尾斜杠归一：注册 "http://127.0.0.1:9999/" 放行不带尾斜杠的同源 URL', async () => {
    const archive = buildArchive({ 'SKILL.md': '# demo\n' });
    mockFetchFile(archive);
    registerTrustedDownloadOrigin('http://127.0.0.1:9999/');

    const item = makeItem({ downloadUrl: 'http://127.0.0.1:9999/resources/demo-skill/1.0.0/download' });
    const { cachePath } = await installPackage(item);

    expect(fs.existsSync(path.join(cachePath, 'SKILL.md'))).toBe(true);
  });

  it('origin 边界：前缀相似但非同一 origin 的 http URL 仍被拒', async () => {
    registerTrustedDownloadOrigin('http://127.0.0.1:9999');

    const item = makeItem({ downloadUrl: 'http://127.0.0.1:9999.evil.test/pkg.tar.gz' });
    await expect(installPackage(item)).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('unregister：注册后撤销 → 旧 origin 的 http URL 复拒（归一一致——尾斜杠差异不影响撤销）', () => {
    registerTrustedDownloadOrigin('http://127.0.0.1:9999');
    expect(isTrustedDownloadUrl('http://127.0.0.1:9999/pkg.tar.gz')).toBe(true);

    // 带尾斜杠撤销与不带尾斜杠注册落在同一归一键上
    unregisterTrustedDownloadOrigin('http://127.0.0.1:9999/');
    expect(isTrustedDownloadUrl('http://127.0.0.1:9999/pkg.tar.gz')).toBe(false);
  });
});
