// electron/tests/agent/tools/file-tools.test.ts
//
// file-tools 单元测试：用真实 tmp 目录 + 真实 WorkspaceFS，覆盖
//   1. read_file 能读到写入的内容
//   2. write_file 能写入并能读回
//   3. list_files 返回格式化列表（含 📁/📄 标记和目录尾斜杠）
//   4. path traversal 被 WorkspaceFS 拒绝（执行器抛错）
//   5. 未知工具抛错
//   6. 缺失参数抛错
//   7. getFileToolDefs 返回三个工具且 schema 合法

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import {
  getFileToolDefs,
  executeFileTool,
} from '../../../src/main/agent/tools/file-tools';
import {
  getVirtualToolDefs,
  getDispatchToolDefs,
} from '../../../src/main/agent/builtin-tools';
import { SkillRegistry } from '../../../src/main/skill/registry';

const tmpRoot = path.join(os.tmpdir(), `ap-file-tools-test-${Date.now()}`);
const tmpDir = path.join(tmpRoot, 'workspace');
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('agent/tools/file-tools getFileToolDefs', () => {
  it('返回 8 个文件工具（read_file / write_file / list_files / edit_file / mkdir / rm / mv / exists）', () => {
    const defs = getFileToolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'list_files',
        'edit_file',
        'mkdir',
        'rm',
        'mv',
        'exists',
      ]),
    );
    expect(defs.length).toBe(8);
  });

  it('每个工具有 name / description / inputSchema', () => {
    for (const def of getFileToolDefs()) {
      expect(typeof def.name).toBe('string');
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe('string');
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('agent/tools/file-tools read_file', () => {
  it('读取已存在的文件内容', async () => {
    await wsFs.writeFile('hello.txt', '你好世界');
    const result = await executeFileTool('read_file', { path: 'hello.txt' }, wsFs);
    expect(result).toBe('你好世界');
  });

  it('缺失 path 参数抛错', async () => {
    await expect(executeFileTool('read_file', {}, wsFs)).rejects.toThrow('path');
  });

  // v1.5.6 分页测试
  it('offset+limit 分页读取小段', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    await wsFs.writeFile('big.txt', lines.join('\n'));
    const result = await executeFileTool(
      'read_file',
      { path: 'big.txt', offset: 10, limit: 5 },
      wsFs,
    );
    expect(result).toContain('line 10');
    expect(result).toContain('line 14');
    expect(result).not.toContain('line 15');
    expect(result).toMatch(/offset=15/); // 尾部提示下一段 offset
  });

  it('默认 limit=2000，大文件分页提示', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`);
    await wsFs.writeFile('huge.txt', lines.join('\n'));
    const result = await executeFileTool('read_file', { path: 'huge.txt' }, wsFs);
    expect(result).toContain('l1\n');
    expect(result).toContain('l2000');
    expect(result).not.toContain('l2001');
    expect(result).toMatch(/共 3000 行.*offset=2001/);
  });

  it('offset 超出文件总行数返回空提示', async () => {
    await wsFs.writeFile('small.txt', 'only one line');
    const result = await executeFileTool(
      'read_file',
      { path: 'small.txt', offset: 100 },
      wsFs,
    );
    expect(result).toMatch(/共 1 行.*offset=100 超出范围/);
  });

  it('读到末尾显示文件末尾标记', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `x${i + 1}`);
    await wsFs.writeFile('med.txt', lines.join('\n'));
    const result = await executeFileTool(
      'read_file',
      { path: 'med.txt', offset: 40, limit: 20 },
      wsFs,
    );
    expect(result).toContain('x40');
    expect(result).toContain('x50');
    expect(result).toMatch(/文件末尾.*共 50 行/);
  });

  it('limit 上限保护（防 LLM 误传巨大 limit）', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `y${i + 1}`);
    await wsFs.writeFile('cap.txt', lines.join('\n'));
    // 即使 limit=99999，实际最多返回 5000 行（这里文件只有 100，返回全部 + 末尾标记）
    const result = await executeFileTool(
      'read_file',
      { path: 'cap.txt', limit: 99999 },
      wsFs,
    );
    expect(result).toContain('y1');
    expect(result).toContain('y100');
  });

  it('完整读小文件无分页提示（向后兼容）', async () => {
    await wsFs.writeFile('tiny.txt', 'short\nfile');
    const result = await executeFileTool('read_file', { path: 'tiny.txt' }, wsFs);
    expect(result).toBe('short\nfile');
  });
});

describe('agent/tools/file-tools write_file', () => {
  it('写入文件后能读回', async () => {
    const result = await executeFileTool(
      'write_file',
      { path: 'out.txt', content: '写入测试' },
      wsFs,
    );
    expect(result).toBe('文件已写入: out.txt');
    const readBack = await executeFileTool('read_file', { path: 'out.txt' }, wsFs);
    expect(readBack).toBe('写入测试');
  });

  it('能创建子目录并写入（writeFile 自动 mkdir）', async () => {
    await executeFileTool(
      'write_file',
      { path: 'sub/deep/file.txt', content: '嵌套' },
      wsFs,
    );
    const readBack = await executeFileTool('read_file', { path: 'sub/deep/file.txt' }, wsFs);
    expect(readBack).toBe('嵌套');
  });

  it('缺失 content 参数抛错', async () => {
    await expect(
      executeFileTool('write_file', { path: 'x.txt' }, wsFs),
    ).rejects.toThrow('content');
  });
});

describe('agent/tools/file-tools list_files', () => {
  it('返回格式化的目录列表', async () => {
    await wsFs.writeFile('a.txt', 'a');
    await wsFs.writeFile('b.md', 'b');
    fs.mkdirSync(path.join(wsFs['rootDir'], 'subdir'), { recursive: true });

    const result = await executeFileTool('list_files', { path: '.' }, wsFs);
    const lines = result.split('\n');
    expect(lines).toContain('📄 a.txt');
    expect(lines).toContain('📄 b.md');
    expect(lines).toContain('📁 subdir/');
  });

  it('未传 path 时默认列 workspace 根目录', async () => {
    await wsFs.writeFile('root.txt', 'x');
    const result = await executeFileTool('list_files', {}, wsFs);
    expect(result).toContain('root.txt');
  });

  it('空目录返回提示文本', async () => {
    const result = await executeFileTool('list_files', { path: '.' }, wsFs);
    expect(result).toBe('(空目录)');
  });
});

describe('agent/tools/file-tools 安全与错误', () => {
  it('path traversal 被 WorkspaceFS 拒绝（read_file）', async () => {
    await expect(
      executeFileTool('read_file', { path: '../../../etc/passwd' }, wsFs),
    ).rejects.toThrow();
  });

  it('path traversal 被 WorkspaceFS 拒绝（write_file）', async () => {
    await expect(
      executeFileTool('write_file', { path: '../../evil.txt', content: 'x' }, wsFs),
    ).rejects.toThrow();
  });

  it('.git 目录操作被拒绝', async () => {
    await expect(
      executeFileTool('write_file', { path: '.git/config', content: 'evil' }, wsFs),
    ).rejects.toThrow();
  });

  it('未知工具抛错', async () => {
    await expect(
      executeFileTool('not_a_tool', { path: 'x' }, wsFs),
    ).rejects.toThrow('未知工具');
  });
});

describe('edit_file', () => {
  it('唯一匹配成功', async () => {
    await wsFs.writeFile('foo.txt', 'line1\nTARGET\nline3');
    const result = await executeFileTool('edit_file',
      { path: 'foo.txt', oldString: 'TARGET', newString: 'REPLACED' }, wsFs);
    expect(result).toContain('已编辑');
    expect((await wsFs.readFile('foo.txt')).toString('utf-8')).toBe('line1\nREPLACED\nline3');
  });

  it('多重匹配抛错', async () => {
    await wsFs.writeFile('foo.txt', 'DUP\nDUP\nDUP');
    await expect(executeFileTool('edit_file',
      { path: 'foo.txt', oldString: 'DUP', newString: 'X' }, wsFs)).rejects.toThrow(/出现多次/);
  });

  it('未找到时回写文件头', async () => {
    await wsFs.writeFile('foo.txt', 'hello world'.repeat(100));
    await expect(executeFileTool('edit_file',
      { path: 'foo.txt', oldString: 'NOT_FOUND', newString: 'X' }, wsFs))
      .rejects.toThrow(/未在文件中找到/);
  });

  it('oldString=newString 拒绝', async () => {
    await wsFs.writeFile('foo.txt', 'hello');
    await expect(executeFileTool('edit_file',
      { path: 'foo.txt', oldString: 'hello', newString: 'hello' }, wsFs)).rejects.toThrow(/相同/);
  });

  it('文件不存在抛错', async () => {
    await expect(executeFileTool('edit_file',
      { path: 'no.txt', oldString: 'a', newString: 'b' }, wsFs)).rejects.toThrow(/文件不存在/);
  });

  it('路径越界抛错', async () => {
    await expect(executeFileTool('edit_file',
      { path: '../../etc/passwd', oldString: 'a', newString: 'b' }, wsFs)).rejects.toThrow(/路径越界/);
  });
});

describe('mkdir', () => {
  it('创建目录', async () => {
    const result = await executeFileTool('mkdir', { path: 'newdir' }, wsFs);
    expect(result).toContain('已创建');
    expect(fs.existsSync(path.join(tmpDir, 'newdir'))).toBe(true);
  });

  it('递归创建嵌套', async () => {
    await executeFileTool('mkdir', { path: 'a/b/c' }, wsFs);
    expect(fs.existsSync(path.join(tmpDir, 'a/b/c'))).toBe(true);
  });
});

describe('rm', () => {
  it('删除文件', async () => {
    await wsFs.writeFile('trash.txt', 'x');
    await executeFileTool('rm', { path: 'trash.txt' }, wsFs);
    expect(fs.existsSync(path.join(tmpDir, 'trash.txt'))).toBe(false);
  });

  it('不存在的路径抛错', async () => {
    await expect(executeFileTool('rm', { path: 'no.txt' }, wsFs)).rejects.toThrow();
  });
});

describe('mv', () => {
  it('移动文件', async () => {
    await wsFs.writeFile('a.txt', 'content');
    await executeFileTool('mv', { src: 'a.txt', dst: 'b.txt' }, wsFs);
    expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(true);
  });
});

describe('exists', () => {
  it('存在返回 "存在"', async () => {
    await wsFs.writeFile('here.txt', 'x');
    expect(await executeFileTool('exists', { path: 'here.txt' }, wsFs)).toBe('存在');
  });

  it('不存在返回 "不存在"', async () => {
    expect(await executeFileTool('exists', { path: 'no.txt' }, wsFs)).toBe('不存在');
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
