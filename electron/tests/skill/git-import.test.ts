// electron/tests/skill/git-import.test.ts
//
// P2.6：Git 仓库 skill 导入服务测试（spec 2026-09-24 §3，D1-D6）。
//
// 测试覆盖（brief 10 用例清单展开）：
//   1. buildArchiveUrl：github codeload / 尾斜杠与 .git 后缀归一 / gitlab archive /
//      www.github.com 同 github / gitee 拒（暂不支持）/ http 拒（https）/ 缺 owner/repo 拒
//   2. scan：superpowers 形态归档 → 2 个 skill（slug/name/description 来自 frontmatter），
//      README/垃圾文件不产生条目；tmp 下存在 git-import-<importId>.zip
//   3. scan 根级 SKILL.md（无包裹目录）→ slug = nameToSlug(frontmatter.name)
//   4. scan 未发现 SKILL.md → 抛错
//   5. scan 残留清理：tmp 下既有 git-import-stale.zip 被删
//   6. import 落盘：SKILL.md + references 资产 + .sha256；README 不落盘；imported=2；tmp 清理
//   7. 幂等：同内容重扫重导 → .sha256 内容一致（内部跳过重写）
//   8. 覆盖更新：SKILL.md 内容变化后重导入 → 目标目录为新版
//   9. importId 一次性：同 importId 二次 import 抛「失效」
//   10. 路径防御：entry 名含 .. → 跳过不越界落盘；slug 为 .. → scan 抛「非法 slug」
//
// 隔离策略（mock 收窄——只 mock 网络边界）：
//   - fetchZip 注入 fixture zip（AdmZip 现场打包），零真实网络
//   - tmpDir / skillsDir 注入临时目录，不依赖 AP_USER_DATA_DIR
//   - 解析 / 剥顶层 / 扫描 / 落盘全部走真实实现
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {
  buildArchiveUrl, scanGitRepoSkills, importGitRepoSkills,
} from '../../src/main/skill/git-import';

const tmpRoot = path.join(os.tmpdir(), `ap-git-import-${Date.now()}`);
const skillsDir = path.join(tmpRoot, 'skills');

/** 构造 superpowers 形态的归档 zip：顶层 <repo>-<branch>/ 包 skills/<名>/SKILL.md(+资产) */
function makeArchive(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content, 'utf-8'));
  return zip.toBuffer();
}

/**
 * 构造 entry 名真正含 `..` 的 zip：AdmZip addFile 的 fixPath 会把 `..` 归一化掉，
 * 故先用等长占位段 `qz/` 打包，再对 buffer 做等长二进制替换为 `../`（偏移与
 * filename length 字段零漂移）。entry 名在 zip 内出现两次（local header +
 * central directory），替换计数不符即抛错——防压缩数据意外碰撞导致静默污染。
 */
function makeArchiveWithDotDot(entries: Array<{ name: string; content: string }>): Buffer {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, 'utf-8'));
  const buf = zip.toBuffer();
  const token = Buffer.from('qz/');
  const dots = Buffer.from('../');
  const expected =
    entries.reduce((n, e) => n + e.name.split('qz/').length - 1, 0) * 2; // local + central 各一份
  let idx = 0;
  let patched = 0;
  while ((idx = buf.indexOf(token, idx)) !== -1) {
    dots.copy(buf, idx);
    idx += token.length;
    patched += 1;
  }
  if (patched !== expected) {
    throw new Error(`占位符替换数异常：期望 ${expected} 实际 ${patched}（占位符与压缩数据冲突，请换 token）`);
  }
  return buf;
}
const SKILL_MD = (name: string, desc: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(desc)}\n---\n\n正文 ${name}\n`;

const SUPERPOWERS_LIKE = {
  'superpowers-main/skills/brainstorming/SKILL.md': SKILL_MD('Brainstorming', '想法变设计'),
  'superpowers-main/skills/brainstorming/references/guide.md': '# 指南',
  'superpowers-main/skills/tdd/SKILL.md': SKILL_MD('TDD', '测试驱动'),
  'superpowers-main/README.md': '# 非 skill 文件',
  // 包裹级 __MACOSX 不被 isIgnoredEntry 过滤（只匹配根级前缀），但不在任何 skill 前缀下故无害
  'superpowers-main/__MACOSX/junk': '垃圾',
  'superpowers-main/skills/.DS_Store': '垃圾',
};

beforeEach(() => { fs.mkdirSync(tmpRoot, { recursive: true }); });
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('buildArchiveUrl — host 适配与 URL 归一（D1/D6）', () => {
  it('github → codeload HEAD；尾斜杠 / .git 后缀 / www 前缀均归一', () => {
    const expected = 'https://codeload.github.com/obra/superpowers/zip/HEAD';
    expect(buildArchiveUrl('https://github.com/obra/superpowers')).toBe(expected);
    expect(buildArchiveUrl('https://github.com/obra/superpowers/')).toBe(expected);
    expect(buildArchiveUrl('https://github.com/obra/superpowers.git')).toBe(expected);
    expect(buildArchiveUrl('https://www.github.com/obra/superpowers')).toBe(expected);
  });

  it('gitlab → /-/archive/HEAD/<repo>.zip', () => {
    expect(buildArchiveUrl('https://gitlab.com/gitlab-org/gitlab')).toBe(
      'https://gitlab.com/gitlab-org/gitlab/-/archive/HEAD/gitlab.zip',
    );
  });

  it('非白名单 host / 非 https / 缺 owner-repo 均抛中文错', () => {
    expect(() => buildArchiveUrl('https://gitee.com/x/y')).toThrow(/暂不支持/);
    expect(() => buildArchiveUrl('http://github.com/x/y')).toThrow(/https/);
    // 消息为「需含 <owner>/<repo>」（尖括号隔开，不能写作 /owner\/repo/）
    expect(() => buildArchiveUrl('https://github.com/x')).toThrow(/需含 <owner>\/<repo>/);
  });
});

describe('scanGitRepoSkills — 下载 + 全深度扫描', () => {
  it('superpowers 形态归档 → 2 个 skill，name/description 来自 frontmatter；tmp 落盘 zip', async () => {
    const result = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive(SUPERPOWERS_LIKE),
      tmpDir: tmpRoot,
    });

    // importId 是 importGitRepoSkills 的消费凭证——断言其真实形态（randomUUID）
    expect(result.importId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((s) => s.slug).sort()).toEqual(['brainstorming', 'tdd']);
    const bs = result.skills.find((s) => s.slug === 'brainstorming')!;
    expect(bs.name).toBe('Brainstorming');
    expect(bs.description).toBe('想法变设计');
    // README / __MACOSX / .DS_Store 不产生条目
    expect(result.skills.some((s) => s.slug === 'README.md' || s.slug === '__MACOSX')).toBe(false);
    // scan 阶段 zip 落 tmp（供 import 二次消费，避免二次下载——D5）
    expect(fs.existsSync(path.join(tmpRoot, `git-import-${result.importId}.zip`))).toBe(true);
  });

  it('根级 SKILL.md（无包裹目录）→ 1 个 skill，slug = nameToSlug(frontmatter.name)', async () => {
    const result = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive({
        'SKILL.md': SKILL_MD('Root Level Skill', '根级'),
        'assets/a.md': '# a',
      }),
      tmpDir: tmpRoot,
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.slug).toBe('root-level-skill');
    expect(result.skills[0]!.name).toBe('Root Level Skill');
    // 根级 skill 导入 = 全部文件直落 <slug>/（dirPrefix 为空分支）
    const imp = await importGitRepoSkills(result.importId, { skillsDir });
    expect(imp.imported.map((s) => s.slug)).toEqual(['root-level-skill']);
    expect(fs.existsSync(path.join(skillsDir, 'root-level-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'root-level-skill', 'assets', 'a.md'))).toBe(true);
  });

  it('归档内无 SKILL.md（只有 README）→ 抛错', async () => {
    await expect(
      scanGitRepoSkills('https://github.com/obra/superpowers', {
        fetchZip: async () => makeArchive({ 'superpowers-main/README.md': '# x' }),
        tmpDir: tmpRoot,
      }),
    ).rejects.toThrow(/未发现 SKILL\.md/);
  });

  it('scan 前清理 tmp 下既有 git-import-* 残留（进程崩溃兜底——D5）', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'git-import-stale.zip'), 'stale');
    await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive(SUPERPOWERS_LIKE),
      tmpDir: tmpRoot,
    });
    expect(fs.existsSync(path.join(tmpRoot, 'git-import-stale.zip'))).toBe(false);
  });

  it('SKILL.md 父目录名为 .. → scan 阶段抛「非法 slug」（路径防御前置）', async () => {
    await expect(
      scanGitRepoSkills('https://github.com/obra/superpowers', {
        // qz/ 占位 → 二进制替换为 ../（AdmZip addFile 会归一化 ..，见 helper 注释）
        fetchZip: async () => makeArchiveWithDotDot([
          { name: 'superpowers-main/skills/qz/SKILL.md', content: SKILL_MD('Bad', 'x') },
        ]),
        tmpDir: tmpRoot,
      }),
    ).rejects.toThrow(/非法 slug/);
  });
});

describe('importGitRepoSkills — 落盘 + 幂等/覆盖 + 一次性会话', () => {
  it('scan 后立即 import → SKILL.md + references 资产 + .sha256 落盘；README 不落盘；tmp 清理', async () => {
    const scan = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive(SUPERPOWERS_LIKE),
      tmpDir: tmpRoot,
    });
    const imp = await importGitRepoSkills(scan.importId, { skillsDir });

    expect(imp.imported).toHaveLength(2);
    expect(imp.failures).toEqual([]);
    // brainstorming：SKILL.md + 资产 + hash 标记
    expect(fs.existsSync(path.join(skillsDir, 'brainstorming', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'brainstorming', 'references', 'guide.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'brainstorming', '.sha256'))).toBe(true);
    // tdd 同理
    expect(fs.existsSync(path.join(skillsDir, 'tdd', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'tdd', '.sha256'))).toBe(true);
    // 仓库根 README 不属于任何 skill 目录 → 不落盘
    expect(fs.existsSync(path.join(skillsDir, 'README.md'))).toBe(false);
    // tmp zip 一次性消费后清理（D5）
    expect(fs.existsSync(path.join(tmpRoot, `git-import-${scan.importId}.zip`))).toBe(false);
  });

  it('同内容重复 scan+import → .sha256 内容一致（幂等跳过，不重写）', async () => {
    const buf = makeArchive(SUPERPOWERS_LIKE);
    const s1 = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => buf, tmpDir: tmpRoot,
    });
    await importGitRepoSkills(s1.importId, { skillsDir });
    const hashFile = path.join(skillsDir, 'brainstorming', '.sha256');
    const hash1 = fs.readFileSync(hashFile, 'utf-8');
    const mtime1 = fs.statSync(hashFile).mtimeMs;

    const s2 = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => buf, tmpDir: tmpRoot,
    });
    const r2 = await importGitRepoSkills(s2.importId, { skillsDir });

    expect(r2.imported).toHaveLength(2);
    // 跳过重写：hash 内容等价且文件未被重写（mtime 不变）
    expect(fs.readFileSync(hashFile, 'utf-8')).toBe(hash1);
    expect(fs.statSync(hashFile).mtimeMs).toBe(mtime1);
  });

  it('SKILL.md 内容变化后重导入 → 目标目录为新版（覆盖更新语义）', async () => {
    const v1 = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive(SUPERPOWERS_LIKE), tmpDir: tmpRoot,
    });
    await importGitRepoSkills(v1.importId, { skillsDir });

    const v2 = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive({
        ...SUPERPOWERS_LIKE,
        'superpowers-main/skills/brainstorming/SKILL.md': SKILL_MD('Brainstorming', '新版描述'),
      }),
      tmpDir: tmpRoot,
    });
    const r2 = await importGitRepoSkills(v2.importId, { skillsDir });

    expect(r2.imported).toHaveLength(2);
    const md = fs.readFileSync(path.join(skillsDir, 'brainstorming', 'SKILL.md'), 'utf-8');
    expect(md).toContain('新版描述');
  });

  it('同 importId 第二次 import → 抛「导入会话已失效」', async () => {
    const scan = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive(SUPERPOWERS_LIKE), tmpDir: tmpRoot,
    });
    await importGitRepoSkills(scan.importId, { skillsDir });
    await expect(importGitRepoSkills(scan.importId, { skillsDir })).rejects.toThrow(/失效/);
  });

  it('根级 SKILL.md 无 frontmatter.name → scan/import 均以仓库名兜底 slug（对称，P2.6 Task 1 Minor ①）', async () => {
    // 根级无 name：scan 阶段 slug 兜底链落到仓库名（URL 第二段，.git 后缀已剥）；
    // import 阶段须从会话取同一仓库名重导出 collectSkillRoots——否则 slug 兜底为空串
    // 抛「非法 slug」，与 scan 结果不对称（根级条目永远导不进）。
    const scan = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      fetchZip: async () => makeArchive({
        'SKILL.md': '---\ndescription: 根级无名字\n---\n\n正文\n',
      }),
      tmpDir: tmpRoot,
    });
    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]!.slug).toBe('superpowers');
    expect(scan.skills[0]!.name).toBe('superpowers');
    const imp = await importGitRepoSkills(scan.importId, { skillsDir });
    expect(imp.imported.map((s) => s.slug)).toEqual(['superpowers']);
    expect(imp.failures).toEqual([]);
    expect(fs.existsSync(path.join(skillsDir, 'superpowers', 'SKILL.md'))).toBe(true);
  });

  it('skill 目录内 entry 名含 .. → 跳过（不抛错、不越界落盘）', async () => {
    // skillsDir 嵌套一层：越界路径 resolve 后落在 tmpRoot 内，断言完全隔离
    const nestedSkillsDir = path.join(tmpRoot, 'nested', 'skills');
    const scan = await scanGitRepoSkills('https://github.com/obra/superpowers', {
      // qz/qz/qz 占位 → 二进制替换为 ../../../（AdmZip addFile 会归一化 ..，见 helper 注释）
      fetchZip: async () => makeArchiveWithDotDot([
        { name: 'superpowers-main/skills/evil/SKILL.md', content: SKILL_MD('Evil', 'x') },
        { name: 'superpowers-main/skills/evil/qz/qz/qz/etc/passwd', content: 'hacked' },
      ]),
      tmpDir: tmpRoot,
    });
    const imp = await importGitRepoSkills(scan.importId, { skillsDir: nestedSkillsDir });

    // 合法 skill 正常导入；越界条目被防御跳过（不产生 failure、不抛错）
    expect(imp.imported.map((s) => s.slug)).toEqual(['evil']);
    expect(imp.failures).toEqual([]);
    expect(fs.existsSync(path.join(nestedSkillsDir, 'evil', 'SKILL.md'))).toBe(true);
    // tmpRoot/nested/skills/evil/../../../etc/passwd → resolve = tmpRoot/etc/passwd（未写入）
    expect(fs.existsSync(path.join(tmpRoot, 'etc', 'passwd'))).toBe(false);
  });
});
