// electron/tests/im/context-expander.test.ts
// context-expander：skill 展开（成功/不可用占位）+ 文件读取（内联/超大/总量/逃逸/不存在）。
// momo-test-rules：文件系统用真实临时目录（不 mock fs）；skill 用真实 SKILL.md 文件；
// 错误路径与空输入专项用例全覆盖（总量累计超限 / workspaceId=null / 空 context）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expandMessageContext,
  MAX_IMAGE_BASE64_CHARS,
  MAX_INLINE_FILE_BYTES,
  MAX_TOTAL_INLINE_BYTES,
  setExpanderDeps,
} from '../../src/main/im/context-expander';
import type { MessageContext } from '../../../renderer/src/ipc/types';

let tmpRoot: string;
let wsId: string | null;
/** 图片素材字节（多模态 Task 5：断言 base64 与 mime 的已知输入） */
let pngBytes: Buffer;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ctx-'));
  // 伪 workspace 目录结构：expander 经测试注入的根解析函数取 workspace 目录
  fs.mkdirSync(path.join(tmpRoot, 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'ws1', 'a.ts'), 'export const a = 1;');
  // I4：合法 dotfile 素材（.env / .github 嵌套路径是正常 workspace 内容）
  fs.writeFileSync(path.join(tmpRoot, 'ws1', '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(tmpRoot, 'ws1', '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'ws1', '.github', 'workflows', 'ci.yml'), 'jobs: {}');
  // 超大文件（> 64KB）
  fs.writeFileSync(path.join(tmpRoot, 'ws1', 'big.txt'), 'x'.repeat(MAX_INLINE_FILE_BYTES + 1));
  // 总量超限素材：5 个 60KB 文件（单个 ≤64KB 不触单文件上限；4 个累计 240KB ≤ 256KB，
  // 第 5 个 240+60=300KB > 256KB 触累计上限降级）
  const chunk = 'y'.repeat(60 * 1024);
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(tmpRoot, 'ws1', `part${i}.txt`), chunk);
  }
  // 符号链接逃逸素材：ws1 内 symlink 指向 workspace 外的真实文件
  fs.writeFileSync(path.join(tmpRoot, 'outside.txt'), 'secret');
  fs.symlinkSync(path.join(tmpRoot, 'outside.txt'), path.join(tmpRoot, 'ws1', 'link.txt'));
  // skill 目录（custom 形态）
  fs.mkdirSync(path.join(tmpRoot, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'skills', 'demo', 'SKILL.md'),
    '---\nname: 演示技能\ndescription: 测试用\nversion: 1.0.0\n---\n\n技能正文。',
  );
  // 图片素材（多模态 Task 5）：.momo/assets 内容寻址形态 + 各失败形态素材。
  // 字节不必是真实图片——expander 只按扩展名映射 mime、按字节算 base64
  const assetsDir = path.join(tmpRoot, 'ws1', '.momo', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(assetsDir, 'ab.png'), pngBytes);
  fs.writeFileSync(path.join(assetsDir, 'cd.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]));
  fs.writeFileSync(path.join(assetsDir, 'ef.bmp'), Buffer.from([0x42, 0x4d, 6, 7]));
  // base64 超限素材：raw 8MB+ → base64 文本 ≈11MB > 8MB 上限
  fs.writeFileSync(path.join(assetsDir, 'huge.png'), Buffer.alloc(8 * 1024 * 1024 + 1024, 7));
  // 未知扩展名素材（.txt 不在图片 mime 白名单）
  fs.writeFileSync(path.join(assetsDir, 'note.txt'), 'not an image');
  // 注入测试依赖（生产路径依赖 electron app / SQLite，不进测试）：
  // skillRoots 注入即完全接管 skill 解析；workspaceDir 注入即绕开 getWorkspace DB 查询
  setExpanderDeps({
    skillRoots: [path.join(tmpRoot, 'skills')],
    workspaceDir: () => path.join(tmpRoot, 'ws1'),
  });
  wsId = 'ws1';
});

afterAll(() => {
  setExpanderDeps({});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('expandMessageContext', () => {
  it('skill 展开正文与名称', async () => {
    const r = await expandMessageContext(wsId, { skills: [{ slug: 'demo', name: '演示技能' }], files: [] });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]!.body).toContain('技能正文。');
    expect(r.skills[0]!.name).toBe('演示技能');
  });

  it('skill 不可用降级为占位（不抛错）', async () => {
    const r = await expandMessageContext(wsId, { skills: [{ slug: 'gone', name: '已删除' }], files: [] });
    expect(r.skills[0]!.body).toBe('[skill 已不可用]');
  });

  it('文件内联读取（≤64KB）', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'a.ts' }] });
    expect(r.files[0]!.content).toBe('export const a = 1;');
  });

  it('超大文件 content=null 降级', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'big.txt' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('路径逃逸（.. 与绝对路径）按读取失败降级，不越 workspace', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [{ path: '../outside.txt' }, { path: '/etc/passwd' }],
    });
    expect(r.files[0]!.content).toBeNull();
    expect(r.files[1]!.content).toBeNull();
  });

  it('不存在文件 content=null 降级', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'nope.ts' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('总量累计超限：超出 MAX_TOTAL 后其余文件降级（单文件均不超限）', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [1, 2, 3, 4, 5].map((i) => ({ path: `part${i}.txt` })),
    });
    // 前 4 个累计 240KB ≤ 256KB：内联
    expect(r.files[0]!.content).not.toBeNull();
    expect(r.files[3]!.content).not.toBeNull();
    expect(r.files[3]!.content).toHaveLength(60 * 1024);
    // 第 5 个累计将达 300KB > 256KB：降级
    expect(r.files[4]!.content).toBeNull();
    expect(MAX_TOTAL_INLINE_BYTES).toBe(256 * 1024);
  });

  it('workspaceId=null 时文件全部降级（无根可依附）', async () => {
    const r = await expandMessageContext(null, { skills: [], files: [{ path: 'a.ts' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('符号链接逃逸（指向 workspace 外）降级 content=null', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'link.txt' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('恶意 slug（路径穿越形态）按不可用降级占位', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [{ slug: '../../etc', name: 'evil' }],
      files: [],
    });
    expect(r.skills[0]!.body).toBe('[skill 已不可用]');
  });

  it('空 context 返回空结构（images/droppedImages 恒为数组）', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [] });
    expect(r).toEqual({ skills: [], files: [], images: [], droppedImages: [] });
  });

  // === I4 回归锁（终审修复）：合法 dotfile 不再一刀切拒绝 ===
  // 缺陷：isSafeRelativePath 的 !norm.startsWith('.') 拒绝一切 dotfile——
  // .env / .github/... 全静默降级 content=null 且提示误导「文件过大」。
  // 修复语义：仅拒「. / .. / 父逃逸前缀」；dotfile 是正常 workspace 内容。

  it('I4：.env dotfile 正常内联（不再被 startsWith(.) 误拒）', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: '.env' }] });
    expect(r.files[0]!.content).toBe('SECRET=1');
  });

  it('I4：.github/workflows/ci.yml 嵌套 dotfile 路径正常内联', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [{ path: '.github/workflows/ci.yml' }],
    });
    expect(r.files[0]!.content).toBe('jobs: {}');
  });

  it('I4：`.` / `./` 归一后是当前目录 → 仍拒（content=null）', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: '.' }, { path: './' }] });
    expect(r.files[0]!.content).toBeNull();
    expect(r.files[1]!.content).toBeNull();
  });

  it('I4：`..` / 父逃逸前缀 / 绝对路径 → 仍拒（安全边界不变）', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [{ path: '..' }, { path: '../x' }, { path: 'a/../../x' }, { path: '/etc/passwd' }],
    });
    expect(r.files.map((f) => f.content)).toEqual([null, null, null, null]);
  });

  it('注入的 workspaceDir 抛错时不抛错，文件 content=null 降级（永不抛错契约守卫）', async () => {
    // 模拟 getWorkspace 后端 DB 不可用：注入抛错的 workspaceDir 模拟同款异常。
    // 锁「expander 永不抛错」契约——下游必须自然降级而不是把异常向上冒泡。
    setExpanderDeps({
      skillRoots: [path.join(tmpRoot, 'skills')],
      workspaceDir: () => {
        throw new Error('db down');
      },
    });
    try {
      const r = await expandMessageContext(wsId, {
        skills: [],
        files: [{ path: 'a.ts' }, { path: 'big.txt' }],
      });
      // 抛错 → wsFs=null → 所有文件降级 content=null（不阻塞，不抛错）
      expect(r.files).toHaveLength(2);
      expect(r.files[0]!.content).toBeNull();
      expect(r.files[1]!.content).toBeNull();
    } finally {
      // 恢复 beforeAll 的注入，避免污染后续用例
      setExpanderDeps({
        skillRoots: [path.join(tmpRoot, 'skills')],
        workspaceDir: () => path.join(tmpRoot, 'ws1'),
      });
    }
  });

  // === I5 回归锁（终审修复）：元素级畸形输入不击穿「永不抛错」===
  // 缺陷：skills 元素 slug/name 非字符串时 isValidSkillSlug 的 slug.includes /
  // files 元素 path 非字符串时 path.isAbsolute 直接 TypeError——异常沿
  // routeUserChat 顶层 catch 被吃掉，消息落库不派发且无反馈。
  // IPC 入口（sanitizeMessageContext）剔除畸形元素，此处是绕过入口路径
  // （resume 重放 / 历史行）的第二层防御：typeof 守卫逐元素跳过。

  it('I5：畸形元素（skills:[123] / files:[456]）不抛错、合法元素照常展开', async () => {
    const malformed = {
      skills: [123, null, { slug: 'demo' }, { slug: 'demo', name: '演示技能' }],
      files: [456, null, {}, { path: 'a.ts' }],
    } as unknown as MessageContext;
    const r = await expandMessageContext(wsId, malformed);
    // 合法 skill（slug+name 均 string）照常展开；其余（数字 / null / 缺 name）剔除
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]!.body).toContain('技能正文。');
    // 合法文件照常内联；畸形（数字 / null / 缺 path）剔除
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toEqual({ path: 'a.ts', content: 'export const a = 1;' });
  });

  it('I5：全部元素畸形 → 空结果（不抛错、不产半截条目）', async () => {
    const malformed = {
      skills: [{ slug: 789, name: 'x' }],
      files: [{ path: ['evil'] }],
    } as unknown as MessageContext;
    const r = await expandMessageContext(wsId, malformed);
    expect(r).toEqual({ skills: [], files: [], images: [], droppedImages: [] });
  });

  // === 多模态 Task 5：images 展开（读文件→base64；一切失败剔除进 droppedImages） ===
  // 契约：expander 永不抛错；失败占位 [图片加载失败: path] 由 runtime（Task 8）
  // 从 droppedImages 渲染，本层只负责剔除 + 返回清单。

  it('合法图片读取为 base64（png/jpg/bmp mime 映射），droppedImages 空', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [
        { path: '.momo/assets/ab.png', w: 100, h: 50 },
        { path: '.momo/assets/cd.jpg', w: 80, h: 60 },
        { path: '.momo/assets/ef.bmp', w: 10, h: 12 },
      ],
    });
    expect(r.images).toEqual([
      {
        path: '.momo/assets/ab.png',
        mime: 'image/png',
        base64: pngBytes.toString('base64'),
        w: 100,
        h: 50,
      },
      { path: '.momo/assets/cd.jpg', mime: 'image/jpeg', base64: expect.any(String), w: 80, h: 60 },
      { path: '.momo/assets/ef.bmp', mime: 'image/bmp', base64: expect.any(String), w: 10, h: 12 },
    ]);
    expect(r.droppedImages).toEqual([]);
  });

  it('文件缺失 → droppedImages 记录 path，不抛错', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/gone.png', w: 1, h: 1 }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual(['.momo/assets/gone.png']);
  });

  it('单图 base64 超 8MB 上限 → 剔除（raw 8MB → base64 ≈11MB）', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/huge.png', w: 1, h: 1 }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual(['.momo/assets/huge.png']);
    expect(MAX_IMAGE_BASE64_CHARS).toBe(8 * 1024 * 1024);
  });

  it('路径逃逸（../ 与绝对路径）→ 剔除不越 workspace', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [{ path: '../escape.png', w: 1, h: 1 }, { path: '/etc/hosts.png', w: 1, h: 1 }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual(['../escape.png', '/etc/hosts.png']);
  });

  it('未知扩展名（.txt）→ 剔除', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/note.txt', w: 1, h: 1 }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual(['.momo/assets/note.txt']);
  });

  it('旧消息无 images 字段 → images/droppedImages 空数组（兼容锁）', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [{ slug: 'demo', name: '演示技能' }],
      files: [{ path: 'a.ts' }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual([]);
    // skills/files 流不受 images 缺省影响
    expect(r.skills[0]!.body).toContain('技能正文。');
    expect(r.files[0]!.content).toBe('export const a = 1;');
  });

  it('workspaceId=null 时图片全部降级 droppedImages（无根可依附）', async () => {
    const r = await expandMessageContext(null, {
      skills: [],
      files: [],
      images: [{ path: '.momo/assets/ab.png', w: 1, h: 1 }],
    });
    expect(r.images).toEqual([]);
    expect(r.droppedImages).toEqual(['.momo/assets/ab.png']);
  });

  it('畸形元素（数字/null/缺 path/w 非数字）跳过，合法元素照常展开（元素级兜底）', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [],
      images: [
        123,
        null,
        { path: 1, w: 2, h: 3 },
        { w: 1, h: 1 },
        { path: '.momo/assets/ab.png', w: 5, h: 5 },
      ],
    } as unknown as MessageContext);
    expect(r.images).toEqual([
      {
        path: '.momo/assets/ab.png',
        mime: 'image/png',
        base64: pngBytes.toString('base64'),
        w: 5,
        h: 5,
      },
    ]);
    // 畸形元素不进 droppedImages（path 可能都不是字符串，无法构成占位）
    expect(r.droppedImages).toEqual([]);
  });
});
