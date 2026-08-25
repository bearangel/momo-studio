// electron/scripts/dev.mjs
//
// 开发模式编排器（2.0.0 运维优化）：
//   1. 启动 renderer vite dev server（端口 5173，HMR——源码即所见）
//   2. 启动 electron 主进程 tsc watch（首次全量编译）
//   3. 两者就绪后（5173 可连通 且 electron/dist/main/index.js 存在）拉起 Electron，
//      注入 VITE_DEV_SERVER_URL（window.ts 据此 loadURL 走 dev server）
//
// 背景：旧 dev = tsc -w + electron 加载 renderer/dist 静态产物——renderer 改动
// 不重建就全部丢失，「拉代码后忘了 build renderer」在本机验收中连续引发
// 多轮误报（stale renderer 跑的是几轮前的旧 JS）。
//
// 退出语义：任一子进程退出 → 杀掉全部（concurrently -k 等价）；Ctrl+C 信号转发。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_DIST_MAIN = path.join(ROOT, 'electron', 'dist', 'main', 'index.js');
const VITE_PORT = 5173;
const VITE_URL = `http://localhost:${VITE_PORT}`;

const isWin = process.platform === 'win32';
const children = [];

function log(tag, msg) {
  console.log(`\x1b[36m[${tag}]\x1b[0m ${msg}`);
}

function spawnChild(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: 'inherit',
    env: opts.env,
    shell: isWin,
  });
  children.push(child);
  log(name, `已启动 (pid ${child.pid})`);
  child.on('exit', (code) => {
    log(name, `退出 (code ${code})`);
    shutdown(code ?? 0);
  });
  return child;
}

function killAll() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // 已退出——忽略
    }
  }
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killAll();
  // SIGTERM 已发，给子进程 1.5s 收尾再强退
  setTimeout(() => process.exit(code), 1500);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('');
    shutdown(0);
  });
}

async function waitForVite(timeoutMs = 60_000) {
  // vite 监听 localhost——不同环境解析为 IPv4 或 IPv6（容器内实测 ::1），
  // 两个候选地址轮询探测，任一连通即就绪。
  const candidates = ['http://127.0.0.1:5173', 'http://[::1]:5173'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok || res.status === 200) return true;
      } catch {
        // 该地址未就绪——尝试下一个
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForElectronDist(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(ELECTRON_DIST_MAIN)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  // 1. renderer：vite dev server（HMR）。首次冷启动会预构建 monaco，可能要几十秒。
  spawnChild('vite', 'npx', ['pnpm@9.0.0', '--filter', './renderer', 'dev']);

  // 2. electron 主进程：tsc watch（启动即全量编译一次）
  spawnChild('tsc', 'npx', ['pnpm@9.0.0', '--filter', './electron', 'exec', 'tsc', '-p', 'tsconfig.json', '--watch']);

  // 3. 双就绪后拉起 Electron
  const [viteOk, distOk] = await Promise.all([waitForVite(), waitForElectronDist()]);
  if (!viteOk) {
    console.error(`\x1b[31m[dev] vite dev server ${VITE_PORT} 端口 60s 内未就绪，放弃启动 Electron\x1b[0m`);
    shutdown(1);
    return;
  }
  if (!distOk) {
    console.error('\x1b[31m[dev] electron/dist/main/index.js 120s 内未生成（tsc 编译失败？），放弃启动 Electron\x1b[0m');
    shutdown(1);
    return;
  }

  log('dev', `vite 就绪 (${VITE_URL}) + electron dist 就绪 → 启动 Electron`);
  spawnChild('electron', 'npx', [
    'pnpm@9.0.0', '--filter', './electron', 'exec', 'electron', '.',
    ...process.argv.slice(2),
  ], {
    env: { ...process.env, VITE_DEV_SERVER_URL: VITE_URL },
  });
}

main().catch((err) => {
  console.error('[dev] 编排失败:', err);
  shutdown(1);
});
