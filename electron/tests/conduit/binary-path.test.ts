// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns correct per-platform binary path', () => {
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.platform === 'linux') {
      if (process.arch === 'arm64') {
        expect(p).toMatch(/tuwunel-linux-arm64$/);
      } else {
        expect(p).toMatch(/tuwunel-linux-x64$/);
      }
    } else if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        expect(p).toMatch(/tuwunel-darwin-arm64$/);
      } else {
        expect(p).toMatch(/tuwunel-darwin-x64$/);
      }
    } else if (process.platform === 'win32') {
      expect(p).toMatch(/tuwunel-windows-x64\.exe$/);
    }
  });
});