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

  it('工具链目录不存在的条目原样透传（终审 F1：存在性过滤下沉 linux.ts——bwrap 特定顾虑，macOS 侧 pip:user 首装前不存在也须「授权即生效」）', () => {
    const ghost = path.join(tmp, 'toolchain-ghost');
    expect(buildPolicy(tmp, false, [ghost]).extraWriteDirs).toEqual([ghost]);
  });

  it('工具链目录 Set 去重后原样透传（存在/不存在条目混排不剔除）', () => {
    const real = path.join(tmp, 'toolchain-real');
    fs.mkdirSync(real);
    const ghost = path.join(tmp, 'toolchain-ghost');
    const policy = buildPolicy(tmp, false, [real, real, ghost, ghost]);
    expect(policy.extraWriteDirs).toEqual([real, ghost]);
  });
});
