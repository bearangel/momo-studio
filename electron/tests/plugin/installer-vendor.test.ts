// electron/tests/plugin/installer-vendor.test.ts
//
// 引擎整合 T4 RED（spec §4.2）：vendor 引擎包安装链——
// sha256 校验 / 条目数守卫 / 平台探针（解压后 engine/bin 必须存在，防平台装错）/
// 解压落位 installed/<id>/<version>/engine/；无 vendor 声明的插件行为不变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import { installPluginZip } from '../../src/main/plugin/installer';
import { resolvePluginInstalledDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pvendor-'));
const tarWork = path.join(tmpRoot, 'tarwork');

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.mkdirSync(tarWork, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 现场造引擎 tarball（bundle 布局：顶层 bin/ + lib/），返回 {buffer, sha256} */
function makeEngineTarball(files: Record<string, string>): { buffer: Buffer; sha256: string } {
  const src = path.join(tarWork, `src-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), content);
  }
  const tgz = path.join(tarWork, `engine-${Math.random().toString(36).slice(2)}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', src, '.']);
  const buffer = fs.readFileSync(tgz);
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

const ENGINE_FILES = {
  'bin/codegraph': '#!/bin/sh\nexec lib/node dist/bin/codegraph.js "$@"\n',
  'lib/dist/bin/codegraph.js': 'console.log("engine");\n',
};

interface VendorOpts {
  sha256?: string;
  maxEntries?: number;
  omitProbeFiles?: boolean;
}

function makeVendorZip(opts: VendorOpts = {}): Buffer {
  const { buffer, sha256 } = makeEngineTarball(
    opts.omitProbeFiles ? { 'lib/dist/bin/codegraph.js': 'x' } : ENGINE_FILES,
  );
  const manifest = {
    id: 'cg',
    name: 'Codegraph',
    version: '2.0.0',
    description: '图谱',
    components: { mcp: './mcp/mcp.json' },
    vendor: {
      archives: [
        {
          file: 'vendor/engine.tar.gz',
          sha256: opts.sha256 ?? sha256,
          maxEntries: opts.maxEntries ?? 20000,
        },
      ],
      probe: 'engine/bin/codegraph',
    },
  };
  const zip = new AdmZip();
  zip.addFile('momo-plugin.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('mcp/mcp.json', Buffer.from(JSON.stringify({ servers: {} })));
  zip.addFile('vendor/engine.tar.gz', buffer);
  return zip.toBuffer();
}

describe('installPluginZip vendor 引擎包', () => {
  it('① 合法 tarball → 解压落位 engine/ + 探针命中 + 安装成功', async () => {
    const rec = await installPluginZip(makeVendorZip(), '2.1.0');
    expect(rec.id).toBe('cg');
    const dir = resolvePluginInstalledDir('cg', '2.0.0');
    expect(fs.existsSync(path.join(dir, 'engine', 'bin', 'codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'vendor', 'engine.tar.gz'))).toBe(true);
  });

  it('② sha256 不符 → 拒装且不落 engine/', async () => {
    await expect(
      installPluginZip(makeVendorZip({ sha256: '0'.repeat(64) }), '2.1.0'),
    ).rejects.toThrow(/校验失败|sha256/i);
    expect(fs.existsSync(path.join(resolvePluginInstalledDir('cg', '2.0.0'), 'engine'))).toBe(false);
  });

  it('③ tarball 条目数超 maxEntries → 拒装', async () => {
    await expect(installPluginZip(makeVendorZip({ maxEntries: 1 }), '2.1.0')).rejects.toThrow(
      /条目|entries/i,
    );
  });

  it('④ 平台装错模拟（tarball 无 bin/，探针落空）→ 拒装', async () => {
    await expect(
      installPluginZip(makeVendorZip({ omitProbeFiles: true }), '2.1.0'),
    ).rejects.toThrow(/探针|probe|平台/i);
  });

  it('⑥ I1 回归锁：tar 成员名守卫——../ 与绝对路径成员拒装（穿越防线延伸到 tar 内）', async () => {
    const { assertSafeTarMembers } = await import('../../src/main/plugin/installer');
    // 合法 bundle 布局成员
    expect(() => assertSafeTarMembers(['bin/codegraph', 'lib/dist/x.js', 'lib/'])).not.toThrow();
    // 穿越成员（GNU tar 默认剥前导 / 但放行 ../——Linux 主力环境成立）
    expect(() => assertSafeTarMembers(['../evil.txt'])).toThrow(/穿越|安全/);
    expect(() => assertSafeTarMembers(['bin/../../evil'])).toThrow(/穿越|安全/);
    expect(() => assertSafeTarMembers(['/abs/evil'])).toThrow(/穿越|安全/);
  });

  it('⑦ I3 回归锁：probe 路径 win32 感知——补 .exe 候选', async () => {
    const { probeCandidates } = await import('../../src/main/plugin/installer');
    expect(probeCandidates('engine/bin/codegraph', 'darwin')).toEqual(['engine/bin/codegraph']);
    expect(probeCandidates('engine/bin/codegraph', 'win32')).toEqual([
      'engine/bin/codegraph.exe',
      'engine/bin/codegraph',
    ]);
  });

  it('⑤ 无 vendor 声明 → 行为与现状一致（正常安装，无 engine 目录）', async () => {
    const zip = new AdmZip();
    zip.addFile(
      'momo-plugin.json',
      Buffer.from(
        JSON.stringify({
          id: 'plain',
          name: 'Plain',
          version: '1.0.0',
          description: 'd',
          components: { mcp: './mcp/mcp.json' },
        }),
      ),
    );
    zip.addFile('mcp/mcp.json', Buffer.from(JSON.stringify({ servers: {} })));
    const rec = await installPluginZip(zip.toBuffer(), '2.1.0');
    expect(rec.id).toBe('plain');
    expect(fs.existsSync(path.join(resolvePluginInstalledDir('plain', '1.0.0'), 'engine'))).toBe(false);
  });
});
