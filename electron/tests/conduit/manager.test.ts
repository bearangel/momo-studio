// electron/tests/conduit/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  startConduit,
  stopConduit,
  isConduitRunning,
  healthCheck,
  setBinaryOverride,
} from '../../src/main/conduit/manager';

// Per-test scratch dir under the OS temp root so resolveConduitDir() (driven by
// AP_USER_DATA_DIR) writes its generated conduit.toml somewhere disposable and
// never clobbers the developer's real ~/.agent-platform.
const tmpRoot = path.join(os.tmpdir(), `ap-conduit-test-${Date.now()}`);
// Reference the .ts source directly: tsx (registered via --import tsx on the
// spawned argv) handles .ts natively, so no pre-compile step is needed.
const fakeBinary = path.join(__dirname, 'fake-binary.ts');

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  // Swap the real Conduit binary for our HTTP stand-in. Each argv element is
  // passed verbatim to spawn(); the manager appends `-c <configPath>` after.
  setBinaryOverride(['node', '--import', 'tsx', fakeBinary]);
});

afterEach(async () => {
  await stopConduit();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  // Clean up any per-test fake-binary mode flags so they can't leak across
  // tests and silently change another test's behavior.
  delete process.env.FAKE_IGNORE_SIGTERM;
  delete process.env.FAKE_NO_HEALTH;
  setBinaryOverride(null);
});

describe('conduit/manager', () => {
  it(
    'starts, reports running, healthchecks, and stops',
    async () => {
      expect(isConduitRunning()).toBe(false);
      const info = await startConduit();
      expect(isConduitRunning()).toBe(true);
      expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await healthCheck(5000)).toBe(true);
      await stopConduit();
      expect(isConduitRunning()).toBe(false);
    },
    15000,
  );

  it('startConduit is idempotent', async () => {
    const a = await startConduit();
    const b = await startConduit();
    expect(a.baseUrl).toBe(b.baseUrl);
    await stopConduit();
  });

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when SIGTERM is ignored',
    async () => {
      // Fake ignores SIGTERM entirely, so only SIGKILL can stop it. This
      // verifies the force-kill escalation in stopConduit (the path that was
      // previously dead because `proc.killed` is true the instant SIGTERM is
      // delivered, not when the child actually exits).
      process.env.FAKE_IGNORE_SIGTERM = '1';
      await startConduit();
      expect(isConduitRunning()).toBe(true);

      const start = Date.now();
      await stopConduit();
      const elapsed = Date.now() - start;

      // SIGTERM is ignored for the full STOP_GRACE_PERIOD_MS (5s) before the
      // SIGKILL timer fires, so stop must take at least ~5s.
      expect(elapsed).toBeGreaterThanOrEqual(4800);
      // And it should not run away: ~5s grace plus kill/exit overhead.
      expect(elapsed).toBeLessThan(8000);
      expect(isConduitRunning()).toBe(false);
    },
    15000,
  );

  it('concurrent startConduit calls share one in-flight spawn', async () => {
    // Fire three starts in the same tick. Without the pendingStart guard all
    // three would race past the isConduitRunning() check and spawn three
    // children; with the guard they must all join the same promise.
    const results = await Promise.all([
      startConduit(),
      startConduit(),
      startConduit(),
    ]);
    expect(results).toHaveLength(3);
    // Reference equality proves they resolved the SAME promise (and thus the
    // same ConduitInfo object) rather than three independently-built copies.
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    await stopConduit();
  });

  it(
    'startConduit rejects when health check fails',
    async () => {
      // Fake binds the port but never answers /health (hangs forever), so the
      // startup healthCheck cannot ever succeed and startConduit must reject.
      process.env.FAKE_NO_HEALTH = '1';
      await expect(startConduit()).rejects.toThrow(/health check/i);
      // startConduit tears down on failure; nothing should be left running.
      expect(isConduitRunning()).toBe(false);
    },
    25000,
  );

  it(
    'healthCheck respects the requested timeoutMs',
    async () => {
      // Spawn a hanging /health server directly (bypassing startConduit's 15s
      // startup deadline) so we can measure healthCheck(500) in isolation.
      const proc: ChildProcess = spawn(
        'node',
        ['--import', 'tsx', fakeBinary],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FAKE_NO_HEALTH: '1' },
        },
      );
      try {
        await waitForReady(proc);
        const start = Date.now();
        const ok = await healthCheck(500);
        const elapsed = Date.now() - start;
        expect(ok).toBe(false);
        // With the deadline-clamping fix, healthCheck returns within ~timeoutMs.
        // The pre-fix code used a fixed 1000ms per-request timeout + 200ms sleep
        // and overran to ~1200ms even for a 500ms budget.
        expect(elapsed).toBeLessThan(1000);
      } finally {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
    10000,
  );
});

// Wait for the fake binary to print its `READY:<port>` line, signalling the
// HTTP server is listening. Rejects if the process exits before binding.
function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('fake binary did not print READY in time')),
      5000,
    );
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('READY:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`fake binary exited before READY (code=${code} signal=${signal})`),
      );
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
