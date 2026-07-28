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

// Interval between health-check attempts and per-attempt fetch timeout. The
// fetch timeout is deliberately smaller than the typical poll cadence so a
// hung connection cannot stall the overall deadline.
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1000;
// Grace period after SIGTERM before we escalate to SIGKILL in stopConduit.
const STOP_GRACE_PERIOD_MS = 5000;

let conduitProcess: ChildProcess | null = null;
let binaryOverride: string[] | null = null;

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
 * Idempotent: calling again while running returns the cached info.
 */
export async function startConduit(): Promise<ConduitInfo> {
  if (isConduitRunning()) {
    return { port: CONDUIT_PORT, baseUrl: BASE_URL };
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
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      conduitProcess = null;
      clearTimeout(forceTimer);
      logger.info('Conduit stopped');
      resolve();
    };
    // `once` (not `on`) so repeated stopConduit calls don't accumulate
    // listeners on the same process handle.
    proc.once('exit', done);
    proc.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!proc.killed) {
        logger.warn('Conduit did not exit on SIGTERM; sending SIGKILL');
        proc.kill('SIGKILL');
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
    try {
      const response = await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet (ECONNREFUSED) or request timed out — retry until deadline.
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}
