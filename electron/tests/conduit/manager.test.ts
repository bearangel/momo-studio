// electron/tests/conduit/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
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
});
