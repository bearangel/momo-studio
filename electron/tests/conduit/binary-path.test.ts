// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns correct Linux binary path', () => {
    // Conduwuit 仅发布 Linux 二进制，macOS/Windows 会抛错
    if (process.platform !== 'linux') {
      expect(() => resolveConduitBinaryPath()).toThrow(/No Conduwuit binary/);
      return;
    }
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.arch === 'arm64') {
      expect(p).toMatch(/static-aarch64-unknown-linux-musl$/);
    } else {
      expect(p).toMatch(/static-x86_64-unknown-linux-musl$/);
    }
  });
});