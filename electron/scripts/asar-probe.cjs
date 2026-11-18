// electron/scripts/asar-probe.cjs
//
// 在**打包产物自带运行时**内运行（ELECTRON_RUN_AS_NODE=1 momo-studio.exe asar-probe.cjs <asar>）：
// Electron 的 fs 补丁让这个进程能直接读 asar 内的文件，因此无需 @electron/asar 依赖。
//
// 输出一行 JSON 结论，供 scripts/package-win.mjs 判定：
//   { protocolPkg: '0.7.3', protocolVersion: '1.12.0', graphSize, hasHubIndex, offenders: [...] }
//
// 检查项：
//   1) asar 内 momo-hub-protocol 的包版本与 PROTOCOL_VERSION（防止发出去的包用了陈旧协议副本）
//   2) runtime 子进程 eager 依赖图内零 electron 运行期依赖（v2.1.0-alpha.9 及 alpha.63/64 P0 回归锁）

const fs = require('node:fs');
const path = require('node:path');

const asarRoot = process.argv[2];
if (!asarRoot) {
  console.error('usage: asar-probe.cjs <app.asar path>');
  process.exit(2);
}
const mainDir = path.join(asarRoot, 'dist', 'main');
const entry = path.join(mainDir, 'agent', 'runtime-entry.js');

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not found */
    }
  }
  return null;
}

// 只认「模块顶层（行首零缩进）的 require」：编译态里 `await import('x')` 会变成
// 缩进的 `Promise.resolve().then(() => require('x'))`，语义是懒加载，不属于 boot 期依赖。
const TOP_LEVEL_REQUIRE =
  /^(?:const|let|var)\s+[\w$]+\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)|^require\(\s*['"](\.[^'"]+)['"]\s*\)|^__exportStar\(require\(\s*['"](\.[^'"]+)['"]\s*\)/gm;

function collectEager(startEntry) {
  const seen = new Set([startEntry]);
  const queue = [startEntry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    TOP_LEVEL_REQUIRE.lastIndex = 0;
    let m;
    while ((m = TOP_LEVEL_REQUIRE.exec(src)) !== null) {
      const next = resolveRelative(file, m[1] || m[2] || m[3]);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

function electronRuntimeDeps(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const hits = [];
  if (/require\(\s*['"]electron['"]\s*\)/.test(code)) hits.push("require('electron')");
  if (/^\s*import\s+['"]electron['"]/m.test(code)) hits.push("side-effect import 'electron'");
  return hits;
}

const SANCTIONED = new Set(['electron-access.js']);

const result = {
  protocolPkg: null,
  protocolVersion: null,
  graphSize: 0,
  hasHubIndex: false,
  offenders: [],
  error: null,
};

try {
  const protoPkgPath = path.join(asarRoot, 'node_modules', 'momo-hub-protocol', 'package.json');
  result.protocolPkg = JSON.parse(fs.readFileSync(protoPkgPath, 'utf8')).version;
  const versionJs = fs.readFileSync(
    path.join(asarRoot, 'node_modules', 'momo-hub-protocol', 'dist', 'version.js'),
    'utf8',
  );
  const m = versionJs.match(/PROTOCOL_VERSION = '([^']+)'/);
  result.protocolVersion = m ? m[1] : null;

  const files = collectEager(entry);
  result.graphSize = files.length;
  result.hasHubIndex = files.some((f) => f.replace(/\\/g, '/').endsWith('/hub/index.js'));
  result.offenders = files
    .filter((f) => !SANCTIONED.has(path.basename(f)))
    .map((f) => ({
      file: path.relative(mainDir, f).replace(/\\/g, '/'),
      deps: electronRuntimeDeps(fs.readFileSync(f, 'utf8')),
    }))
    .filter((x) => x.deps.length > 0);
} catch (e) {
  result.error = e.message;
}

console.log(JSON.stringify(result));
