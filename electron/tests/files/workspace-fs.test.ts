// electron/tests/files/workspace-fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmpRoot = path.join(os.tmpdir(), `ap-fs-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('files/workspace-fs', () => {
  it('assertInWorkspace 允许 workspace 内路径', () => {
    expect(() => wsFs.assertInWorkspace('src/main.ts')).not.toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(wsFs['rootDir'], 'src/app.ts'))).not.toThrow();
  });

  it('assertInWorkspace 拒绝路径穿越', () => {
    expect(() => wsFs.assertInWorkspace('../../../etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace('../../secret')).toThrow();
  });

  it('assertInWorkspace 拒绝绝对路径在 workspace 外', () => {
    expect(() => wsFs.assertInWorkspace('/etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(tmpRoot, 'outside'))).toThrow();
  });

  it('writeFile + readFile 往返', async () => {
    await wsFs.writeFile('test.txt', 'hello world');
    const content = await wsFs.readFile('test.txt');
    expect(content.toString()).toBe('hello world');
  });

  it('writeFile 拒绝写到 .git/', async () => {
    await expect(wsFs.writeFile('.git/config', 'evil')).rejects.toThrow();
  });

  it('writeFile 拒绝大写 .GIT/ 变体（macOS 大小写不敏感 FS 绕过防护）', async () => {
    await expect(wsFs.writeFile('.GIT/config', 'evil')).rejects.toThrow();
    await expect(wsFs.writeFile('.Git/hooks/x', 'evil')).rejects.toThrow();
  });

  // I4 连带：`.git` 保护是段精确匹配（`.git` 与其内部子路径），同前缀的
  // `.github` / `.gitattributes` 等正常 dotfile 不误伤。旧实现的字符串前缀
  // startsWith('.git') 把 .github/… 一并拒绝（composer @ 引用第二层撞墙根因）。
  it('writeFile 允许 .github/ 等同前缀 dotfile（段精确匹配不误伤）', async () => {
    await expect(wsFs.writeFile('.github/workflows/ci.yml', 'jobs: {}')).resolves.toBeUndefined();
    await expect(wsFs.writeFile('.gitattributes', '* text=auto')).resolves.toBeUndefined();
    // `.git` 本身与其内部路径仍拒（保护语义不变）
    await expect(wsFs.writeFile('.git/config', 'evil')).rejects.toThrow(/\.git/);
    await expect(wsFs.writeFile('.git-hooks/x.sh', 'ls')).resolves.toBeUndefined();
  });

  it('listDir 返回文件和子目录', async () => {
    await wsFs.writeFile('a.txt', 'a');
    await wsFs.writeFile('b.txt', 'b');
    fs.mkdirSync(path.join(wsFs['rootDir'], 'subdir'), { recursive: true });
    const entries = await wsFs.listDir('.');
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  it('exists 检查文件存在', async () => {
    await wsFs.writeFile('exists.txt', 'yes');
    expect(await wsFs.exists('exists.txt')).toBe(true);
    expect(await wsFs.exists('no.txt')).toBe(false);
  });
});

describe('extraRootDirs（spec hard-gate §6）', () => {
  // 测试 fixture realpath 归一（macOS /var → /private/var symlink 可移植性）：
  // 生产 WorkspaceFS.setExtraRootDirs 对根做 realpath 归一去重，assertInWorkspace
  // 不动输入——fixture 必须与生产同形（realpath 后）否则 macOS 下 isInsideDir 字符串
  // 前缀比对失败。Linux 上 /var 非 symlink，realpath 是恒等映射无副作用。后人不要
  // 「简化」掉——GUI 宿主（macOS）必须绿，后续 Task 7/8 也在宿主跑测试。
  let root: string;
  let extra: string;
  let wfs: WorkspaceFS;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-root-')));
    extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-extra-')));
    wfs = new WorkspaceFS(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
  });

  it('默认空 → 越界行为与文案不变', () => {
    expect(() => wfs.assertInWorkspace(path.join(extra, 'f.txt'))).toThrow(
      /路径越界: .+ 不在 workspace 内/,
    );
  });

  it('setExtraRootDirs 后：extra 根内路径放行（读写在根外成功）', async () => {
    wfs.setExtraRootDirs([extra]);
    await wfs.writeFile(path.join(extra, 'f.txt'), 'x');
    expect((await wfs.readFile(path.join(extra, 'f.txt'))).toString()).toBe('x');
  });

  it('extra 根内 symlink 指向两根之外 → 逃逸拒绝（逐根 realpath 判定）', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsfs-outside-')));
    try {
      fs.symlinkSync(outside, path.join(extra, 'link'));
      wfs.setExtraRootDirs([extra]);
      expect(() => wfs.assertInWorkspace(path.join(extra, 'link', 'f.txt'))).toThrow(
        /符号链接逃逸: .+/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('.git 保护仅 workspace 根：extra 根下 .git 路径放行（与 bash 授权后对齐）', () => {
    wfs.setExtraRootDirs([extra]);
    expect(wfs.assertInWorkspace(path.join(extra, '.git', 'config'))).toBe(
      path.join(extra, '.git', 'config'),
    );
    expect(() => wfs.assertInWorkspace(path.join(root, '.git', 'config'))).toThrow(
      /禁止操作 \.git 目录/,
    );
  });

  it('越界错误文案锁（含空格路径——write-grant-tool regex 的消费契约）', () => {
    const spaced = path.join(extra, 'My Dir With Spaces', 'f.txt');
    try {
      wfs.assertInWorkspace(spaced);
      throw new Error('应越界');
    } catch (err) {
      const m = /路径越界: (.+) 不在 workspace 内/.exec((err as Error).message);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(spaced); // 提取值必须完整还原带空格路径
    }
  });
});
