// electron/tests/sandbox/windows-command-line.test.ts
import { describe, it, expect } from 'vitest';
import { buildWindowsCommandLine } from '../../src/main/sandbox/windows';

describe('buildWindowsCommandLine', () => {
  it('序言把控制台输出编码钉成 UTF-8，并在原命令之前', () => {
    const out = buildWindowsCommandLine('node -v');
    expect(out.startsWith('$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;')).toBe(true);
    expect(out.endsWith('node -v')).toBe(true);
  });

  it('多行命令 / 含分号命令原样保留', () => {
    const cmd = "$ErrorActionPreference='Stop'\nGet-ChildItem; Write-Output 'ok'";
    const out = buildWindowsCommandLine(cmd);
    expect(out).toContain(cmd);
    expect(out.indexOf('$OutputEncoding')).toBeLessThan(out.indexOf(cmd));
  });
});
