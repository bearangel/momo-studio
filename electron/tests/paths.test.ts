// electron/tests/paths.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveUserDataDir, resolveDbPath } from '../src/main/paths';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('paths', () => {
  const tmpRoot = path.join(os.tmpdir(), `ap-test-${Date.now()}`);

  beforeEach(() => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

  it('resolveUserDataDir returns AP_USER_DATA_DIR and creates it', () => {
    const result = resolveUserDataDir();
    expect(result).toBe(tmpRoot);
    expect(fs.existsSync(tmpRoot)).toBe(true);
  });

  it('resolveDbPath returns <userData>/state.db', () => {
    expect(resolveDbPath()).toBe(path.join(tmpRoot, 'state.db'));
  });
});
