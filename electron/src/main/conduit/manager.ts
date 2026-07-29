// electron/src/main/conduit/manager.ts
//
// Conduit lifecycle: spawn the Conduit server as a child process, poll its
// /health endpoint until it is ready, and tear it down gracefully on stop.
//
// Design notes:
// - Port is fixed to 8008 for v1 (matches real Conduit's default and is bound
//   to 127.0.0.1 only, so it is never exposed on the LAN).
// - startConduit is idempotent: a second call while a live process exists just
//   returns the same baseUrl without respawning.
// - setBinaryOverride lets tests substitute a fake argv (e.g. a node script)
//   without touching the real binary path resolver.
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveConduitBinaryPath } from './binary-path';
import { writeConduitConfig } from './config';
import { resolveConduitDir } from '../paths';
import { logger } from '../logger';

const CONDUIT_PORT = 8008; // Fixed for v1; Conduit binds to 127.0.0.1 only.
const BASE_URL = `http://127.0.0.1:${CONDUIT_PORT}`;

// Caps for per-iteration work inside healthCheck. The per-request fetch
// timeout is capped so a hung connection cannot stall a single poll past the
// overall deadline; the sleep cap bounds idle time between polls. Both are
// clamped to the *remaining* deadline each iteration so healthCheck never
// overruns the requested timeoutMs.
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1000;
// Grace period after SIGTERM before we escalate to SIGKILL in stopConduit.
const STOP_GRACE_PERIOD_MS = 5000;

let conduitProcess: ChildProcess | null = null;
let binaryOverride: string[] | null = null;
// In-flight start so concurrent startConduit() callers share one spawn instead
// of racing past the isConduitRunning() check and spawning multiple children.
let pendingStart: Promise<ConduitInfo> | null = null;

export interface ConduitInfo {
  port: number;
  baseUrl: string;
}

/** Test hook: substitute the real Conduit argv with a fake command. Pass null to clear. */
export function setBinaryOverride(args: string[] | null): void {
  binaryOverride = args;
}

/** True iff a Conduit child process is currently alive. */
export function isConduitRunning(): boolean {
  return conduitProcess !== null && !conduitProcess.killed;
}

/**
 * Start Conduit if not already running. Writes the config, spawns the binary,
 * and blocks until /health responds or the startup deadline (15s) elapses.
 * Idempotent for both sequential and concurrent callers: a second call while
 * a start is in flight joins the same promise rather than spawning again.
 */
export async function startConduit(): Promise<ConduitInfo> {
  if (isConduitRunning()) {
    return { port: CONDUIT_PORT, baseUrl: BASE_URL };
  }
  if (pendingStart) return pendingStart;
  pendingStart = doStartConduit().finally(() => {
    pendingStart = null;
  });
  return pendingStart;
}

async function doStartConduit(): Promise<ConduitInfo> {
  // Windows: 优先 WSL2，回退 Docker
  if (process.platform === 'win32') {
    return await startConduitViaWSLOrDocker();
  }

  const dataDir = resolveConduitDir();
  const configPath = await writeConduitConfig({
    port: CONDUIT_PORT,
    serverName: 'localhost',
    dataDir,
  });

  const binary = binaryOverride ?? [resolveConduitBinaryPath()];
  const [command, ...baseArgs] = binary;
  if (!command) {
    // binaryOverride can be an empty array; resolveConduitBinaryPath never is.
    throw new Error('Conduit binary argv is empty');
  }
  logger.info('Starting Conduit', { binary, configPath });

  const proc = spawn(command, baseArgs.concat(['-c', configPath]), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'info' },
  });
  conduitProcess = proc;

  // Stream child output into our logger for diagnostics.
  proc.stdout?.on('data', (chunk) => {
    logger.info(`[conduit] ${String(chunk).trimEnd()}`);
  });
  proc.stderr?.on('data', (chunk) => {
    logger.warn(`[conduit] ${String(chunk).trimEnd()}`);
  });
  // spawn() emits `error` (not `exit`) when the binary cannot be launched
  // (ENOENT, EACCES, etc.). Without a listener Node would surface this as an
  // uncaught exception, so handle it here and drop our handle.
  proc.on('error', (err) => {
    logger.error('Conduit process error', err);
    if (conduitProcess === proc) conduitProcess = null;
  });
  proc.on('exit', (code, signal) => {
    logger.warn('Conduit exited', { code, signal });
    // Only clear if this is still the current process; a replacement may have
    // already taken over (defensive — not currently reachable but cheap).
    if (conduitProcess === proc) conduitProcess = null;
  });

  const ok = await healthCheck(15000);
  if (!ok) {
    await stopConduit();
    throw new Error('Conduit failed health check within 15s');
  }

  logger.info('Conduit started', { baseUrl: BASE_URL });
  return { port: CONDUIT_PORT, baseUrl: BASE_URL };
}

/**
 * Gracefully stop Conduit: send SIGTERM, wait up to STOP_GRACE_PERIOD_MS for a
 * clean exit, then escalate to SIGKILL. No-op if nothing is running.
 */
export async function stopConduit(): Promise<void> {
  const proc = conduitProcess;
  if (!proc) return;

  return new Promise<void>((resolve) => {
    // Track exit state ourselves. `proc.killed` flips to true the moment
    // SIGTERM is *delivered* — not when the process actually exits — so it
    // cannot distinguish a child that gracefully exited from one that is
    // ignoring SIGTERM. The explicit `exited` flag does.
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      clearTimeout(forceTimer);
      // Identity-guard: only clear the module handle if it still points at
      // this proc. A concurrent startConduit may have already swapped in a
      // fresh replacement, and clearing that would orphan it.
      if (conduitProcess === proc) {
        conduitProcess = null;
      }
      logger.info('Conduit stopped');
      resolve();
    };
    // `once` (not `on`) so repeated stopConduit calls don't accumulate
    // listeners on the same process handle.
    proc.once('exit', onExit);
    proc.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!exited) {
        logger.warn('Conduit did not exit on SIGTERM; sending SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already reaped */
        }
      }
    }, STOP_GRACE_PERIOD_MS);
  });
}

/**
 * Poll GET /health on BASE_URL until it returns 200 or the deadline elapses.
 * Each fetch has its own short timeout so a half-open connection cannot stall
 * the loop past the overall deadline. Returns true once healthy, false on
 * timeout.
 */
export async function healthCheck(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Clamp each fetch to the remaining deadline so a hung connection cannot
    // push the overall wait past timeoutMs. Without this a 500ms deadline
    // could still wait the full 1000ms cap on the last attempt.
    const remaining = deadline - Date.now();
    const requestTimeout = Math.min(HEALTH_REQUEST_TIMEOUT_MS, remaining);
    try {
      const response = await fetch(`${BASE_URL}/_matrix/client/versions`, {
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet (ECONNREFUSED) or request timed out — retry until deadline.
    }
    const sleepMs = Math.min(HEALTH_POLL_INTERVAL_MS, deadline - Date.now());
    if (sleepMs <= 0) break;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  return false;
}

async function startConduitViaWSLOrDocker(): Promise<ConduitInfo> {
  const dataDir = resolveConduitDir();
  await writeConduitConfig({ port: CONDUIT_PORT, serverName: 'localhost', dataDir });

  const { exec, execFile } = require('node:child_process') as {
    exec: typeof import('node:child_process').exec;
    execFile: typeof import('node:child_process').execFile;
  };
  const execAsync = (cmd: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      exec(cmd, (err: Error | null, stdout: string) => (err ? reject(err) : resolve(stdout)));
    });
  };

  // 方案 1: WSL2（Windows 11 自带，轻量，无需额外安装）
  try {
    const wslStatus = await execAsync('wsl --status 2>nul').catch(() => '');
    if (wslStatus.includes('Running') || wslStatus.includes('Default')) {
      logger.info('Windows: 检测到 WSL2，通过 WSL 启动 Tuwunel');
      return await startConduitViaWSL(execAsync, dataDir);
    }
  } catch {
    // WSL 不可用
  }

  // 方案 2: Docker Desktop
  try {
    const dockerOk = await execAsync('docker info 2>nul').catch(() => '');
    if (dockerOk.includes('Server')) {
      logger.info('Windows: 检测到 Docker，通过 Docker 启动 Tuwunel');
      return await startConduitViaDocker(execAsync, dataDir);
    }
  } catch {
    // Docker 不可用
  }

  throw new Error(
    'Windows 需要 WSL2 或 Docker Desktop 来运行 Tuwunel。\n\n' +
    '推荐 WSL2（Windows 11 自带）：\n' +
    '  wsl --install\n\n' +
    '或安装 Docker Desktop：\n' +
    '  https://www.docker.com/products/docker-desktop/',
  );
}

async function startConduitViaWSL(
  execAsync: (cmd: string) => Promise<string>,
  dataDir: string,
): Promise<ConduitInfo> {
  // Windows 路径转 WSL 路径: C:\Users\...\data → /mnt/c/Users/.../data
  const wslDataDir = dataDir.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, drive) => `/mnt/${drive.toLowerCase()}`);
  const wslConfigPath = `${wslDataDir}/conduit.toml`;

  // 在 WSL 中下载 Tuwunel 并运行
  const arch = process.arch === 'arm64' ? 'aarch64-v8' : 'x86_64-v1';
  const downloadUrl = `https://github.com/matrix-construct/tuwunel/releases/download/v1.8.2/v1.8.2-release-all-${arch}-linux-gnu-tuwunel.zst`;
  const wslBinaryPath = `${wslDataDir}/tuwunel`;

  await execAsync(`wsl bash -c "mkdir -p '${wslDataDir}'"`).catch(() => {});
  await execAsync(`wsl bash -c "test -f '${wslBinaryPath}' || (curl -sL '${downloadUrl}' | zstd -d -fo '${wslBinaryPath}' && chmod +x '${wslBinaryPath}')"`);
  await execAsync(`wsl bash -c "nohup '${wslBinaryPath}' -c '${wslConfigPath}' > '${wslDataDir}/tuwunel.log' 2>&1 &"`);

  logger.info('Windows: WSL Tuwunel 已启动', { wslBinaryPath });

  const ok = await healthCheck(30000);
  if (!ok) throw new Error('WSL Tuwunel 启动超时（30s）');
  return { port: CONDUIT_PORT, baseUrl: BASE_URL };
}

async function startConduitViaDocker(
  execAsync: (cmd: string) => Promise<string>,
  dataDir: string,
): Promise<ConduitInfo> {
  const dockerPath = dataDir.replace(/\\/g, '/').replace(/^([A-Z]:)/i, (_, drive) => `//${drive.toLowerCase()}`);
  const containerName = 'momo-studio-tuwunel';

  await execAsync(`docker rm -f ${containerName} 2>nul`).catch(() => {});
  await execAsync(
    `docker run -d --name ${containerName} -p 8008:8008 ` +
    `-v "${dockerPath}:/data" ` +
    `ghcr.io/matrix-construct/tuwunel:latest`,
  );
  logger.info('Windows: Docker Tuwunel 容器已启动', { containerName });

  const ok = await healthCheck(30000);
  if (!ok) throw new Error('Docker Tuwunel 启动超时（30s）');
  return { port: CONDUIT_PORT, baseUrl: BASE_URL };
}
