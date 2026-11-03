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
// exports['.'] 条件映射里取 CJS require 入口：字符串直用；对象按
// node.require → require → default 顺序（Node CJS 解析同款优先级）。
function exportsRequireEntry(exp) {
  if (typeof exp === 'string') return exp;
  if (!exp || typeof exp !== 'object') return null;
  const node = exp.node;
  if (typeof node === 'string') return node;
  if (node && typeof node.require === 'string') return node.require;
  if (typeof exp.require === 'string') return exp.require;
  if (typeof exp.default === 'string') return exp.default;
  return null;
}
function vendorEntry(name) {
  const p = path.join(vendorRoot, VENDOR_LIBS[name]);
  if (name.startsWith('momo-')) return p;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf-8'));
    if (typeof pkg.main === 'string' && pkg.main) return path.join(p, pkg.main);
    // main 缺失时回退 exports['.']（真包首次接验：pdfkit@0.17 仅声明 exports 无 main，
    // 旧逻辑回退 index.js 必 ENOENT）。
    const viaExports = exportsRequireEntry(pkg.exports && pkg.exports['.']);
    if (viaExports) return path.join(p, viaExports);
    return path.join(p, 'index.js');
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

// fd 族：openSync / promises.open 按 flags 判写意图——只读（'r' / 'rs'）放行，
// 其余字符串一律视为写（fail-closed，非法串由 Node 自身 EINVAL 兜底）；
// 对象形态（个别调用方传 {flags:'w'}）递归读 .flags。
function isWriteFlags(flags) {
  if (typeof flags === 'string') return flags !== 'r' && flags !== 'rs';
  if (flags && typeof flags === 'object') return isWriteFlags(flags.flags);
  return false;
}
// fd 写授权集：0/1/2（stdio）+ 经守卫 open 拿到的可写 fd。writeSync(fd) 这类
// 按 fd 写入无路径可查——白名单外一律拒绝（防借既有/伪造 fd 写任意目标，
// 终审 B1）。只读 fd 的写入由 OS 语义兜底（POSIX EBADF；测试已锁）。
const allowedWriteFds = new Set([0, 1, 2]);
const origOpenSync = fs.openSync;
fs.openSync = function guardedOpenSync(p, flags, ...args) {
  const write = isWriteFlags(flags);
  if (write) assertWritable(p);
  const fd = origOpenSync.call(fs, p, flags, ...args);
  if (write) allowedWriteFds.add(fd);
  return fd;
};
const origOpenAsync = fsp.open;
fsp.open = async function guardedOpen(p, flags, ...args) {
  const write = isWriteFlags(flags);
  if (write) assertWritable(p);
  const fh = await origOpenAsync.apply(fsp, [p, flags, ...args]);
  // 写意图 open 的 FileHandle.fd 同样登记（终审复审 #1：否则 fh.fd 经
  // fs.writeSync 写会被 fd 白名单误杀，与 openSync 路径行为不一致）
  if (write && typeof fh?.fd === 'number') allowedWriteFds.add(fh.fd);
  return fh;
};
for (const name of ['writeSync', 'write', 'writevSync', 'writev']) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guardedFdWrite(fd, ...args) {
    if (!allowedWriteFds.has(fd)) {
      throw new Error(`沙箱写守卫拒绝（fd 未授权写入）: fd=${String(fd)}`);
    }
    return orig.call(fs, fd, ...args);
  };
}

// 流族：createWriteStream 落点检查。对象形态取 opts.path（Node 必填），
// 字符串/Buffer 形态直接交 assertWritable（内部 String() 归一）。
const origCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function guardedCreateWriteStream(p, ...args) {
  const target = p && typeof p === 'object' && !Buffer.isBuffer(p) && 'path' in p ? p.path : p;
  assertWritable(target);
  const ws = origCreateWriteStream.call(fs, p, ...args);
  // 流内部写入走 fd（fs.write 已按 fd 白名单守卫）：open 事件后登记 fd。
  // open 前 ws.fd 为 null，不存在「未登记即写」的窗口（终审复审 #2 已核对）。
  ws.once('open', (fd) => allowedWriteFds.add(fd));
  return ws;
};

// callback 形态（终审 B1）：fs.writeFile(path, data, cb) 等回调 API 与 sync/promises
// 同语义守卫——路径在首参，rename/copyFile 查目标（第 2 参）。
const FS_CB_FIRST = ['writeFile', 'appendFile', 'unlink', 'mkdir', 'rm', 'rmdir', 'truncate'];
const FS_CB_DST = ['rename', 'copyFile'];
for (const name of FS_CB_FIRST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guardedCb(p, ...args) { assertWritable(p); return orig.call(fs, p, ...args); };
}
for (const name of FS_CB_DST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guardedCb(src, dst, ...args) { assertWritable(dst); return orig.call(fs, src, dst, ...args); };
}

// 链接族：只查新建链接的落点（各 API 第 2 参）——symlink 的 target 指向
// 沙箱外是合法用途（引用既有文件），链接本身必须落在沙箱内。
const origSymlinkSync = fs.symlinkSync;
fs.symlinkSync = function guardedSymlinkSync(target, p, ...args) {
  assertWritable(p);
  return origSymlinkSync.call(fs, target, p, ...args);
};
const origLinkSync = fs.linkSync;
fs.linkSync = function guardedLinkSync(existing, p, ...args) {
  assertWritable(p);
  return origLinkSync.call(fs, existing, p, ...args);
};
const origSymlinkAsync = fsp.symlink;
fsp.symlink = function guardedSymlink(target, p, ...args) {
  assertWritable(p);
  return origSymlinkAsync.apply(fsp, [target, p, ...args]);
};
const origLinkAsync = fsp.link;
fsp.link = function guardedLink(existing, p, ...args) {
  assertWritable(p);
  return origLinkAsync.apply(fsp, [existing, p, ...args]);
};

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
