#!/usr/bin/env node
// Momo Studio Windows 安装包标准化构建 + 门禁脚本
//
// 背景（历史 P0）：agent runtime 子进程以 ELECTRON_RUN_AS_NODE 运行，asar 内没有 electron npm 包；
// 只要 runtime-entry 的**静态依赖图**里出现顶层 `require('electron')`，子进程即 boot 即崩，
// WarmPool 全灭、agent 永不回复（alpha.63/64 实机事故）。同类风险还包括打包产物里的
// `momo-hub-protocol` 副本陈旧（跨端协议错配）——源码正确不代表发出去的包正确。
//
// 因此本脚本把「构建 → 打包 → 对产物做门禁」固化成一条命令：
//   G1 asar 内 momo-hub-protocol 版本与 electron/package.json 的 pin 一致；
//   G2 asar 内协议 PROTOCOL_VERSION 与仓库实装副本一致；
//   G3 runtime 子进程 eager 依赖图零 electron 运行期依赖；
//   G4 打包 exe 以 ELECTRON_RUN_AS_NODE 加载 runtime-entry.js 成功（LOADED_OK）。
//
// 用法（在 electron/ 目录）：
//   node scripts/package-win.mjs                # 构建 + 打包 + 门禁
//   node scripts/package-win.mjs --no-build     # 跳过 tsc/vite 构建（复用既有 dist）
//   node scripts/package-win.mjs --skip-verify  # 只打包（不推荐，仅排障用）

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const electronRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(electronRoot, '..');
const argv = process.argv.slice(2);
const skipBuild = argv.includes('--no-build');
const skipVerify = argv.includes('--skip-verify');

const log = (m) => console.log(`[package-win] ${m}`);
const die = (m) => {
  console.error(`\n[package-win] ✗ ${m}`);
  process.exit(1);
};

function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) die(`命令失败（exit ${r.status}）：${cmd} ${args.join(' ')}`);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ─── 0) 版本一致性 ───────────────────────────────────────────────────────────
const versions = {
  root: readJson(path.join(repoRoot, 'package.json')).version,
  electron: readJson(path.join(electronRoot, 'package.json')).version,
  renderer: readJson(path.join(repoRoot, 'renderer', 'package.json')).version,
};
if (new Set(Object.values(versions)).size !== 1) {
  die(`三处 package.json 版本不一致：${JSON.stringify(versions)}`);
}
const version = versions.electron;
log(`目标版本：${version}`);

// pin 的协议 tag（github:bearangel/momo-hub#vX.Y.Z）
const electronPkg = readJson(path.join(electronRoot, 'package.json'));
const protocolPin = electronPkg.dependencies?.['momo-hub-protocol'] ?? '';
const pinTag = (protocolPin.match(/#(v[\d.]+)$/) ?? [])[1];
if (!pinTag) die(`electron/package.json 的 momo-hub-protocol 依赖不是 #vX.Y.Z 形态：${protocolPin}`);
const pinVersion = pinTag.slice(1);
log(`协议 pin：${pinTag}`);
log(`✓ 三处版本一致：${version}`);

// ─── 1) 构建 ─────────────────────────────────────────────────────────────────
if (!skipBuild) {
  log('构建：pnpm -r build（renderer tsc+vite / electron tsc）');
  run('cmd.exe', ['/d', '/s', '/c', 'npx pnpm@9.0.0 -r build'], repoRoot, {
    NODE_OPTIONS: '--max-old-space-size=4096',
  });
}
if (!fs.existsSync(path.join(electronRoot, 'dist', 'main', 'index.js'))) {
  die('electron/dist 不存在，先构建（去掉 --no-build）');
}
if (!fs.existsSync(path.join(repoRoot, 'renderer', 'dist', 'index.html'))) {
  die('renderer/dist 不存在，先构建（去掉 --no-build）');
}

// ─── 2) 清原生中间产物（否则安装包虚胖 ~4.5MB 起） ──────────────────────────
{
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  const bsDirs = fs.existsSync(pnpmDir)
    ? fs.readdirSync(pnpmDir).filter((n) => n.startsWith('better-sqlite3@'))
    : [];
  let removed = 0;
  for (const d of bsDirs) {
    const build = path.join(pnpmDir, d, 'node_modules', 'better-sqlite3', 'build');
    if (!fs.existsSync(build)) continue;
    for (const f of fs.readdirSync(build, { recursive: true })) {
      if (/\.(iobj|ipdb|lib|pdb|exp|obj|tlog)$/.test(String(f))) {
        // .tlog 等可能是目录，统一用 recursive 删
        fs.rmSync(path.join(build, String(f)), { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  log(`清理 native 中间产物：${removed} 个文件`);
}

// ─── 3) electron-builder（用本地 electron dist 规避 TLS 断连） ───────────────
const requireElectron = createRequire(path.join(electronRoot, 'package.json'));
let electronDist;
try {
  electronDist = path.dirname(requireElectron('electron')); // -> <...>/electron/dist
} catch {
  die('无法解析本地 electron 安装路径（node_modules/electron）');
}
log(`electronDist：${electronDist}`);
run(
  'cmd.exe',
  [
    '/d',
    '/s',
    '/c',
    `npx pnpm@9.0.0 --filter momo-studio-electron exec electron-builder --win --config.npmRebuild=false --config.electronDist="${electronDist}"`,
  ],
  repoRoot,
  { NODE_OPTIONS: '--max-old-space-size=4096' },
);

const installer = path.join(electronRoot, 'dist-installers', `Momo Studio-${version}-setup.exe`);
if (!fs.existsSync(installer)) die(`未生成安装包：${installer}`);
const unpackedExe = path.join(electronRoot, 'dist-installers', 'win-unpacked', 'momo-studio.exe');
const asarPath = path.join(electronRoot, 'dist-installers', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) die(`未生成 app.asar：${asarPath}`);

// ─── 4) 门禁 ─────────────────────────────────────────────────────────────────
if (!skipVerify) {
  const probe = spawnSync(
    unpackedExe,
    [path.join(electronRoot, 'scripts', 'asar-probe.cjs'), asarPath],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  const line = (probe.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  let verdict;
  try {
    verdict = JSON.parse(line ?? '');
  } catch {
    die(`asar 探针未返回可解析结论：\n${probe.stdout}\n${probe.stderr}`);
  }
  if (verdict.error) die(`asar 探针异常：${verdict.error}`);

  // G1：asar 内协议包版本 == pin 的 tag
  if (verdict.protocolPkg !== pinVersion) {
    die(`G1 失败：asar 内 momo-hub-protocol=${verdict.protocolPkg}，pin=${pinVersion}（pnpm install 未同步？）`);
  }
  log(`✓ G1 asar 内协议包版本 = ${verdict.protocolPkg}（与 pin ${pinTag} 一致）`);

  // G2：asar 内协议 PROTOCOL_VERSION == 仓库实装副本
  const installedProtoPkg = path.join(electronRoot, 'node_modules', 'momo-hub-protocol');
  if (!fs.existsSync(path.join(installedProtoPkg, 'package.json'))) {
    die('G2 无法校验：electron/node_modules/momo-hub-protocol 不存在（先 pnpm install）');
  }
  const installedVersionJs = fs.readFileSync(path.join(installedProtoPkg, 'dist', 'version.js'), 'utf8');
  const installedProtocol = (installedVersionJs.match(/PROTOCOL_VERSION = '([^']+)'/) ?? [])[1];
  if (!installedProtocol) die('G2 无法校验：仓库实装副本读不到 PROTOCOL_VERSION');
  if (verdict.protocolVersion !== installedProtocol) {
    die(`G2 失败：asar 内协议 ${verdict.protocolVersion}，仓库实装 ${installedProtocol}`);
  }
  log(`✓ G2 asar 内协议版本 = ${verdict.protocolVersion}（与仓库实装一致）`);

  // G3：runtime 子进程 eager 依赖图零 electron 运行期依赖
  if (verdict.offenders.length > 0) {
    die(
      `G3 失败：runtime 子进程依赖图内出现 electron 运行期依赖（打包后必崩）：\n` +
        verdict.offenders.map((o) => `  ${o.file}: ${o.deps.join(' | ')}`).join('\n'),
    );
  }
  if (!verdict.hasHubIndex || verdict.graphSize < 200) {
    die(`G3 自检失败：图规模异常（${verdict.graphSize} 模块，含 hub/index=${verdict.hasHubIndex}）`);
  }
  log(`✓ G3 eager 图 ${verdict.graphSize} 模块，零 electron 运行期依赖`);

  // G4：打包运行时加载 runtime-entry（P0 的真实崩溃点）
  const load = spawnSync(
    unpackedExe,
    [
      '-e',
      `require(${JSON.stringify(path.join(asarPath, 'dist', 'main', 'agent', 'runtime-entry.js'))});console.log('LOADED_OK')`,
    ],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  if (load.status !== 0 || !(load.stdout ?? '').includes('LOADED_OK')) {
    die(`G4 失败：打包 runtime-entry 加载失败\n${load.stdout}\n${load.stderr}`);
  }
  log('✓ G4 ELECTRON_RUN_AS_NODE 下 runtime-entry 加载成功（LOADED_OK）');
}

// ─── 5) 摘要 ─────────────────────────────────────────────────────────────────
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
const sizeMb = (fs.statSync(installer).size / 1024 / 1024).toFixed(2);
log('');
log(`✓ 安装包：${installer}（${sizeMb} MB）`);
log(`✓ SHA256：${sha256}`);
log(`✓ 版本：${version} / 协议 pin ${pinTag}`);
