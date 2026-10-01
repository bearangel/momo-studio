// electron/tests/sandbox/policy.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPolicy, sensitiveCandidates } from '../../src/main/sandbox/policy';

describe('buildPolicy', () => {
  // 每用例新建 tmp（原 describe 级单例 + afterEach 删除会让后续用例拿到已删
  // 路径——新增用例需在磁盘上真实建目录，故改为 beforeEach 重建）
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-')); });
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

  it('敏感清单覆盖 kube / docker / netrc（审查 F4 扩充）', () => {
    const home = '/home/t';
    const list = sensitiveCandidates(home);
    expect(list).toContain(path.join(home, '.ssh'));
    expect(list).toContain(path.join(home, '.gnupg'));
    expect(list).toContain(path.join(home, '.aws'));
    expect(list).toContain(path.join(home, '.config', 'gcloud'));
    expect(list).toContain(path.join(home, '.kube'));
    expect(list).toContain(path.join(home, '.docker'));
    // .netrc 是普通文件（FTP 凭据）——清单承载路径形态，bwrap 侧按文件类型遮盖
    expect(list).toContain(path.join(home, '.netrc'));
  });

  it('networkEnabled 透传', () => {
    expect(buildPolicy(tmp, true).networkEnabled).toBe(true);
    expect(buildPolicy(tmp, false).networkEnabled).toBe(false);
  });

  it('tmpDir 是 realpath（macOS /var → /private/var 归一）', () => {
    expect(buildPolicy(tmp, false).tmpDir).toBe(fs.realpathSync(os.tmpdir()));
  });

  it('工具链目录不存在的条目被过滤（bwrap 对不存在路径 --bind 硬失败——与 sensitiveDirs 同款同理由）', () => {
    const ghost = path.join(tmp, 'toolchain-ghost');
    expect(buildPolicy(tmp, false, [ghost]).toolchainDirs).toEqual([]);
  });

  it('工具链目录存在的条目保留（去重后原样透传）', () => {
    const real = path.join(tmp, 'toolchain-real');
    fs.mkdirSync(real);
    expect(buildPolicy(tmp, false, [real]).toolchainDirs).toEqual([real]);
  });
});
