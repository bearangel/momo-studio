// electron/tests/sandbox/windows.test.ts
import { describe, expect, it } from 'vitest';
import { detectWindowsShell, getExecutionPolicy, buildKillTreeArgs, detectPackageManager } from '../../src/main/sandbox/windows';
import type { CmdRunner } from '../../src/main/sandbox/probe';

describe('detectWindowsShell', () => {
  it('pwsh 可用 → pwsh.exe', async () => {
    const r: CmdRunner = async (cmd) => ({ code: cmd === 'pwsh.exe' ? 0 : null, stdout: '7.4.1\n', stderr: '' });
    expect(await detectWindowsShell(r)).toBe('pwsh.exe');
  });
  it('pwsh 缺失 → powershell.exe（系统必带）', async () => {
    const r: CmdRunner = async () => ({ code: null, stdout: '', stderr: 'ENOENT' });
    expect(await detectWindowsShell(r)).toBe('powershell.exe');
  });
});

describe('getExecutionPolicy', () => {
  it('解析 stdout 首行（Restricted / RemoteSigned）', async () => {
    const r: CmdRunner = async () => ({ code: 0, stdout: 'Restricted\n', stderr: '' });
    expect(await getExecutionPolicy('powershell.exe', r)).toBe('Restricted');
  });
  it('非零退出码 → Unknown', async () => {
    const r: CmdRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    expect(await getExecutionPolicy('powershell.exe', r)).toBe('Unknown');
  });
  it('空输出 → Unknown', async () => {
    const r: CmdRunner = async () => ({ code: 0, stdout: '\n', stderr: '' });
    expect(await getExecutionPolicy('powershell.exe', r)).toBe('Unknown');
  });
});

describe('buildKillTreeArgs', () => {
  it('taskkill 树杀参数', () => {
    expect(buildKillTreeArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
  });
});

describe('detectPackageManager', () => {
  it('按二进制存在性探测（容器内通常是 apt）', () => {
    const { manager, installCommand } = detectPackageManager();
    expect(['apt', 'dnf', 'pacman', 'zypper', null]).toContain(manager);
    if (manager) expect(installCommand).toContain('bubblewrap');
  });
});
