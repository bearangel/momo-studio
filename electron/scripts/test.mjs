// electron/scripts/test.mjs
//
// ABI 统一（2026-11-13）：electron 测试跑在 Electron 二进制的 node 模式
// （ELECTRON_RUN_AS_NODE=1），better-sqlite3/keytar 与 GUI/打包共用 Electron ABI
// （149）——不再 Node/Electron 来回 rebuild。跨平台包装：Windows cmd 不支持
// 内联 env，经 node 设置后 spawn。用法：node scripts/test.mjs [vitest 参数…]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // electron 包导出二进制路径字符串
const vitestMain = path.resolve(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');

const r = spawnSync(electronBin, [vitestMain, 'run', ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
