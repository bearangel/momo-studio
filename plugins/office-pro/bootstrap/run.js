#!/usr/bin/env node
// run_js 沙箱入口（spec 2026-11-03 §5.2；ELECTRON_RUN_AS_NODE 下运行）。
// argv: [exe, run.js, workspaceDir, scriptPath, vendorRoot]
// 职责：① vendor 库解析白名单注入 ② fs 写守卫（win32 主要补偿 + 全平台纵深）
//       ③ CJS 脚本执行（async 包裹 → 顶层 await 可用）
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const [, , workspaceDir, scriptPath, vendorRoot] = process.argv;
if (!workspaceDir || !scriptPath || !vendorRoot) {
  console.error('bootstrap 参数缺失：期望 argv = [exe, run.js, workspaceDir, scriptPath, vendorRoot]');
  process.exit(2);
}

// ① vendor 库解析：白名单裸名 → vendor 入口文件（不设 NODE_PATH，防宿主串味）。
//    npm 库返回目录会让 Module.load 直接 EISDIR（其目录→入口解析发生在
//    _resolveFilename 内部），故经 package.json main 定位到入口文件。
const VENDOR_LIBS = {
  pptxgenjs: 'node_modules/pptxgenjs',
  exceljs: 'node_modules/exceljs',
  docx: 'node_modules/docx',
  pdfkit: 'node_modules/pdfkit',
  'adm-zip': 'node_modules/adm-zip',
  'momo-chart': 'momo-libs/momo-chart/index.js',
  'momo-pptx-zip': 'momo-libs/momo-pptx-zip/index.js',
  'momo-validate': 'momo-libs/momo-validate/index.js',
};
function vendorEntry(name) {
  const p = path.join(vendorRoot, VENDOR_LIBS[name]);
  if (name.startsWith('momo-')) return p;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf-8'));
    return path.join(p, typeof pkg.main === 'string' && pkg.main ? pkg.main : 'index.js');
  } catch (_e) {
    return path.join(p, 'index.js');
  }
}
const vendorMissing = Object.keys(VENDOR_LIBS).filter((name) => {
  const p = path.join(vendorRoot, VENDOR_LIBS[name]);
  return !fs.existsSync(name.startsWith('momo-') ? p : path.join(p, 'package.json'));
});
if (vendorMissing.length > 0) {
  console.error(`vendor 库缺失: ${vendorMissing.join(', ')}——请先运行 plugins/office-pro/scripts/build.sh 安装依赖`);
  process.exit(3);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(VENDOR_LIBS, request)) {
    return vendorEntry(request);
  }
  return origResolve.call(this, request, ...rest);
};

// ② fs 写守卫：写目标仅允许 workspace 与 tmpdir（读不限）。
//    前缀按 realpath 归一（macOS /var→/private/var、/tmp→/private/tmp 符号链接，
//    path.resolve 相对路径走 getcwd 真实路径，词法前缀会误拒）；目标不存在时
//    realpath 失败则回退词法比较。
function realPath(p) {
  try { return fs.realpathSync(p); } catch (_e) { return p; }
}
const WRITE_PREFIXES = [path.resolve(workspaceDir), os.tmpdir()].map((p) => realPath(p) + path.sep);
function assertWritable(target) {
  const abs = path.resolve(String(target));
  if (WRITE_PREFIXES.some((pre) => abs.startsWith(pre))) return;
  const real = realPath(abs);
  if (real !== abs && WRITE_PREFIXES.some((pre) => real.startsWith(pre))) return;
  throw new Error(`沙箱写守卫拒绝（仅 workspace/tmp 可写）: ${abs}`);
}
const FS_SYNC_FIRST = ['writeFileSync', 'appendFileSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'truncateSync'];
const FS_SYNC_DST = ['renameSync', 'copyFileSync'];
for (const name of FS_SYNC_FIRST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guarded(p, ...args) { assertWritable(p); return orig.call(fs, p, ...args); };
}
for (const name of FS_SYNC_DST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guarded(src, dst, ...args) { assertWritable(dst); return orig.call(fs, src, dst, ...args); };
}
const fsp = fs.promises;
const FS_ASYNC_FIRST = ['writeFile', 'appendFile', 'unlink', 'mkdir', 'rm', 'truncate'];
const FS_ASYNC_DST = ['rename', 'copyFile'];
for (const name of FS_ASYNC_FIRST) {
  const orig = fsp[name];
  fsp[name] = function guarded(p, ...args) { assertWritable(p); return orig.apply(fsp, [p, ...args]); };
}
for (const name of FS_ASYNC_DST) {
  const orig = fsp[name];
  fsp[name] = function guarded(src, dst, ...args) { assertWritable(dst); return orig.apply(fsp, [src, dst, ...args]); };
}

// ③ 执行脚本：new Function 绑定 CJS 语义 + async 包裹（顶层 await 可用）
(async () => {
  const code = fs.readFileSync(scriptPath, 'utf-8');
  const moduleObj = { exports: {} };
  const runner = new Function(
    'require', 'module', 'exports', '__filename', '__dirname',
    `"use strict";\nreturn (async () => {\n${code}\n})();`,
  );
  await runner(require, moduleObj, moduleObj.exports, scriptPath, path.dirname(scriptPath));
  process.exit(0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
