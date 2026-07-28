// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns a string ending with the correct per-OS filename', () => {
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.platform === 'linux') {
      if (process.arch === 'arm64') {
        expect(p).toMatch(/static-aarch64-unknown-linux-musl$/);
      } else {
        expect(p).toMatch(/static-x86_64-unknown-linux-musl$/);
      }
    }
    // macOS/Windows: resolveConduitBinaryPath throws (no Conduwuit binary).
    // Those platforms use Docker-hosted Conduwuit; not testable here.
  });
});