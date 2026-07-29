// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns correct per-platform binary path', () => {
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.platform === 'linux') {
      if (process.arch === 'arm64') {
        expect(p).toMatch(/static-aarch64-unknown-linux-musl$/);
      } else {
        expect(p).toMatch(/static-x86_64-unknown-linux-musl$/);
      }
    } else if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        expect(p).toMatch(/conduwuit-darwin-arm64$/);
      } else {
        expect(p).toMatch(/conduwuit-darwin-x64$/);
      }
    } else if (process.platform === 'win32') {
      expect(p).toMatch(/conduwuit-windows-x64\.exe$/);
    }
  });
});