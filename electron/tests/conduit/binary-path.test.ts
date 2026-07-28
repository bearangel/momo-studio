// electron/tests/conduit/binary-path.test.ts
import { describe, it, expect } from 'vitest';
import { resolveConduitBinaryPath } from '../../src/main/conduit/binary-path';

describe('conduit/binary-path', () => {
  it('returns a string ending with the correct per-OS filename', () => {
    const p = resolveConduitBinaryPath();
    expect(typeof p).toBe('string');
    if (process.platform === 'win32') {
      expect(p).toMatch(/conduit-windows-x64\.exe$/);
    } else if (process.platform === 'darwin') {
      expect(p).toMatch(/conduit-darwin-(arm64|x64)$/);
    } else {
      expect(p).toMatch(/conduit-linux-x64$/);
    }
  });
});