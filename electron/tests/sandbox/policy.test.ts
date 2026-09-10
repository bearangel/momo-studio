// electron/tests/sandbox/policy.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPolicy } from '../../src/main/sandbox/policy';

describe('buildPolicy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('workspace 路径 realpath 解析（符号链接归一）', () => {
    const link = path.join(tmp, 'ws-link');
    const real = path.join(tmp, 'ws-real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(buildPolicy(link, false).workspaceDir).toBe(fs.realpathSync(real));
  });

  it('敏感目录只保留磁盘上存在的（~/.ssh 存在场景模拟不了就断言过滤逻辑：不存在的 .gnupg 不出现）', () => {
    const policy = buildPolicy(tmp, false);
    for (const dir of policy.sensitiveDirs) expect(fs.existsSync(dir)).toBe(true);
  });

  it('networkEnabled 透传', () => {
    expect(buildPolicy(tmp, true).networkEnabled).toBe(true);
    expect(buildPolicy(tmp, false).networkEnabled).toBe(false);
  });

  it('tmpDir 是 realpath（macOS /var → /private/var 归一）', () => {
    expect(buildPolicy(tmp, false).tmpDir).toBe(fs.realpathSync(os.tmpdir()));
  });
});
