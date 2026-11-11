// electron/tests/files/file-io/worker-path.test.ts
//
// C1 回归锁：打包态 worker 路径重写语义 + asarUnpack 构建配置守卫。
// 背景：__dirname 在打包产物内位于 app.asar，外部 node.exe 无法执行 asar 内
// 脚本——必须重写到 app.asar.unpacked，且构建配置必须解包 file-io 目录。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerPathForTesting } from '../../../src/main/files/file-io/file-io-service';

describe('resolveWorkerPathForTesting（C1：asar 内 worker 路径重写）', () => {
  it('打包态：app.asar 路径重写为 app.asar.unpacked 并拼接 io-worker.js', () => {
    const base = path.join(
      '/Applications/Momo Studio.app/Contents/Resources',
      'app.asar',
      'dist',
      'main',
      'files',
      'file-io',
    );
    expect(resolveWorkerPathForTesting(base, true)).toBe(
      path.join(
        '/Applications/Momo Studio.app/Contents/Resources',
        'app.asar.unpacked',
        'dist',
        'main',
        'files',
        'file-io',
        'io-worker.js',
      ),
    );
  });

  it('打包态 + win32 反斜杠形态：同样重写（分隔符无关）', () => {
    const base =
      'C:\\Users\\u\\AppData\\Local\\Programs\\momo-studio\\resources\\app.asar\\dist\\main\\files\\file-io';
    const out = resolveWorkerPathForTesting(base, true);
    expect(
      out.startsWith(
        'C:\\Users\\u\\AppData\\Local\\Programs\\momo-studio\\resources\\app.asar.unpacked\\',
      ),
    ).toBe(true);
    expect(out.endsWith('io-worker.js')).toBe(true);
  });

  it('非打包态：路径原样拼接 io-worker.js（dev / vitest 零变化）', () => {
    const base = path.join('/opt/momo/electron/dist/main/files/file-io');
    expect(resolveWorkerPathForTesting(base, false)).toBe(path.join(base, 'io-worker.js'));
  });

  it('路径不含 app.asar：即使打包态也 no-op', () => {
    const base = path.join('/somewhere/dist/main/files/file-io');
    expect(resolveWorkerPathForTesting(base, true)).toBe(path.join(base, 'io-worker.js'));
  });
});

describe('asarUnpack 构建守卫（C1：防静默移除回归锁）', () => {
  it('electron/package.json 的 build.asarUnpack 含 file-io 解包 glob', () => {
    const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      build?: { asarUnpack?: string[] };
    };
    expect(pkg.build?.asarUnpack).toContain('dist/main/files/file-io/**');
  });
});
