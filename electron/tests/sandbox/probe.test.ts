// electron/tests/sandbox/probe.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { reprobeSandbox, getSandboxState, __setSandboxStateForTest } from '../../src/main/sandbox/probe';
import type { CmdRunner } from '../../src/main/sandbox/probe';

beforeEach(() => __setSandboxStateForTest(null));

const okRunner = (stdout = ''): CmdRunner => async () => ({ code: 0, stdout, stderr: '' });
const failRunner: CmdRunner = async () => ({ code: null, stdout: '', stderr: 'spawn ENOENT' });

describe('reprobeSandbox（linux 分支——按真实平台执行）', () => {
  it('bwrap --version 成功 → available + 版本解析', async () => {
    const st = await reprobeSandbox(async (cmd, args) => {
      if (cmd === 'bwrap' && args[0] === '--version') return { code: 0, stdout: 'bubblewrap 0.10.0\n', stderr: '' };
      return { code: null, stdout: '', stderr: 'unexpected' };
    });
    expect(st.sandboxTool).toBe('bwrap');
    expect(st.toolVersion).toBe('bubblewrap 0.10.0');
    expect(st.available).toBe(true);
    expect(getSandboxState()).toEqual(st); // 单例缓存
  });

  it('bwrap 缺失（ENOENT）→ unavailable + 原因', async () => {
    const st = await reprobeSandbox(failRunner);
    expect(st.available).toBe(false);
    expect(st.unavailableReason).toContain('bwrap');
  });
});

describe('__setSandboxStateForTest', () => {
  it('注入后 getSandboxState 直读（供 shell-tools 单测消费）', () => {
    __setSandboxStateForTest({ platform: 'linux', sandboxTool: null, toolVersion: null, available: false,
      unavailableReason: 'bwrap 未安装', windowsShell: null, executionPolicy: null, probedAt: 0 });
    expect(getSandboxState()?.unavailableReason).toBe('bwrap 未安装');
  });
});
