// electron/tests/agent/builtin-tools.test.ts
//
// builtin-tools 单元测试：用真实 tmp 目录 + 真实 WorkspaceFS，覆盖
//   1. read_file 能读到写入的内容
//   2. write_file 能写入并能读回
//   3. list_files 返回格式化列表（含 📁/📄 标记和目录尾斜杠）
//   4. path traversal 被 WorkspaceFS 拒绝（执行器抛错）
//   5. 未知工具抛错
//   6. 缺失参数抛错
//   7. getBuiltinToolDefs 返回三个工具且 schema 合法

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';
import {
  getBuiltinToolDefs,
  executeBuiltinTool,
  getVirtualToolDefs,
  getDispatchToolDefs,
} from '../../src/main/agent/builtin-tools';
import { SkillRegistry } from '../../src/main/skill/registry';

const tmpRoot = path.join(os.tmpdir(), `ap-builtin-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('agent/builtin-tools getBuiltinToolDefs', () => {
  it('返回 read_file / write_file / list_files 三个工具', () => {
    const defs = getBuiltinToolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'write_file', 'list_files']));
    expect(defs.length).toBe(3);
  });

  it('每个工具有 name / description / inputSchema', () => {
    for (const def of getBuiltinToolDefs()) {
      expect(typeof def.name).toBe('string');
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe('string');
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('agent/builtin-tools read_file', () => {
  it('读取已存在的文件内容', async () => {
    await wsFs.writeFile('hello.txt', '你好世界');
    const result = await executeBuiltinTool('read_file', { path: 'hello.txt' }, wsFs);
    expect(result).toBe('你好世界');
  });

  it('缺失 path 参数抛错', async () => {
    await expect(executeBuiltinTool('read_file', {}, wsFs)).rejects.toThrow('path');
  });
});

describe('agent/builtin-tools write_file', () => {
  it('写入文件后能读回', async () => {
    const result = await executeBuiltinTool(
      'write_file',
      { path: 'out.txt', content: '写入测试' },
      wsFs,
    );
    expect(result).toBe('文件已写入: out.txt');
    const readBack = await executeBuiltinTool('read_file', { path: 'out.txt' }, wsFs);
    expect(readBack).toBe('写入测试');
  });

  it('能创建子目录并写入（writeFile 自动 mkdir）', async () => {
    await executeBuiltinTool(
      'write_file',
      { path: 'sub/deep/file.txt', content: '嵌套' },
      wsFs,
    );
    const readBack = await executeBuiltinTool('read_file', { path: 'sub/deep/file.txt' }, wsFs);
    expect(readBack).toBe('嵌套');
  });

  it('缺失 content 参数抛错', async () => {
    await expect(
      executeBuiltinTool('write_file', { path: 'x.txt' }, wsFs),
    ).rejects.toThrow('content');
  });
});

describe('agent/builtin-tools list_files', () => {
  it('返回格式化的目录列表', async () => {
    await wsFs.writeFile('a.txt', 'a');
    await wsFs.writeFile('b.md', 'b');
    fs.mkdirSync(path.join(wsFs['rootDir'], 'subdir'), { recursive: true });

    const result = await executeBuiltinTool('list_files', { path: '.' }, wsFs);
    const lines = result.split('\n');
    expect(lines).toContain('📄 a.txt');
    expect(lines).toContain('📄 b.md');
    expect(lines).toContain('📁 subdir/');
  });

  it('未传 path 时默认列 workspace 根目录', async () => {
    await wsFs.writeFile('root.txt', 'x');
    const result = await executeBuiltinTool('list_files', {}, wsFs);
    expect(result).toContain('root.txt');
  });

  it('空目录返回提示文本', async () => {
    const result = await executeBuiltinTool('list_files', { path: '.' }, wsFs);
    expect(result).toBe('(空目录)');
  });
});

describe('agent/builtin-tools 安全与错误', () => {
  it('path traversal 被 WorkspaceFS 拒绝（read_file）', async () => {
    await expect(
      executeBuiltinTool('read_file', { path: '../../../etc/passwd' }, wsFs),
    ).rejects.toThrow();
  });

  it('path traversal 被 WorkspaceFS 拒绝（write_file）', async () => {
    await expect(
      executeBuiltinTool('write_file', { path: '../../evil.txt', content: 'x' }, wsFs),
    ).rejects.toThrow();
  });

  it('.git 目录操作被拒绝', async () => {
    await expect(
      executeBuiltinTool('write_file', { path: '.git/config', content: 'evil' }, wsFs),
    ).rejects.toThrow();
  });

  it('未知工具抛错', async () => {
    await expect(
      executeBuiltinTool('not_a_tool', { path: 'x' }, wsFs),
    ).rejects.toThrow('未知工具');
  });
});

const skillTmp = path.join(os.tmpdir(), `ap-builtin-skill-${Date.now()}`);

describe('agent/builtin-tools getVirtualToolDefs（skill 渐进式披露）', () => {
  beforeEach(() => {
    fs.mkdirSync(skillTmp, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(skillTmp, { recursive: true, force: true });
  });

  it('空注册表返回 []（避免向 LLM 暴露必然失败的虚拟工具）', () => {
    const registry = new SkillRegistry();
    expect(getVirtualToolDefs(registry)).toEqual([]);
  });

  it('注册了 skill 时返回 loadSkill + readResource 两个工具', () => {
    const skillDir = path.join(skillTmp, 'demo-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示\n---\n正文',
    );
    const registry = new SkillRegistry();
    registry.register(skillDir);

    const defs = getVirtualToolDefs(registry);
    const names = defs.map((d) => d.name);
    expect(names).toEqual(['loadSkill', 'readResource']);
  });

  it('每个虚拟工具有合法的 schema 与必填字段', () => {
    const skillDir = path.join(skillTmp, 's2');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: s2\ndescription: x\n---\n正文',
    );
    const registry = new SkillRegistry();
    registry.register(skillDir);

    const defs = getVirtualToolDefs(registry);
    const loadSkill = defs.find((d) => d.name === 'loadSkill')!;
    expect(loadSkill.inputSchema.properties).toHaveProperty('name');
    expect(loadSkill.inputSchema.required).toEqual(['name']);

    const readResource = defs.find((d) => d.name === 'readResource')!;
    expect(readResource.inputSchema.required).toEqual(['skill', 'path']);
  });
});

describe('agent/builtin-tools getDispatchToolDefs（主→子调度工具）', () => {
  it('为每个 sub agent 生成一个 dispatch:<slug> 工具', () => {
    const subs = [
      { slug: 'coder', botUserId: '@coder.bot:localhost', description: '写代码' },
      { slug: 'reviewer', botUserId: '@reviewer.bot:localhost', description: '代码审查' },
    ];
    const defs = getDispatchToolDefs(subs);
    expect(defs.map((d) => d.name)).toEqual(['dispatch:coder', 'dispatch:reviewer']);
    expect(defs[0]!.description).toBe('写代码');
    expect(defs[0]!.inputSchema.required).toEqual(['task']);
  });

  it('sub 描述为空时回退到通用描述', () => {
    const defs = getDispatchToolDefs([
      { slug: 'worker', botUserId: '@worker.bot:localhost', description: '' },
    ]);
    expect(defs[0]!.description).toBe('调度子 agent: worker');
  });

  it('空 sub 列表返回 []', () => {
    expect(getDispatchToolDefs([])).toEqual([]);
  });
});
