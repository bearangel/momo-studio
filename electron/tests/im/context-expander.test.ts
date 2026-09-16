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
  MAX_INLINE_FILE_BYTES,
  MAX_TOTAL_INLINE_BYTES,
  setExpanderDeps,
} from '../../src/main/im/context-expander';

let tmpRoot: string;
let wsId: string | null;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ctx-'));
  // 伪 workspace 目录结构：expander 经测试注入的根解析函数取 workspace 目录
  fs.mkdirSync(path.join(tmpRoot, 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'ws1', 'a.ts'), 'export const a = 1;');
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

  it('空 context 返回空结构', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [] });
    expect(r).toEqual({ skills: [], files: [] });
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
});
