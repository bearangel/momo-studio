// electron/tests/agent/tools/search-tools.test.ts
//
// SearchTools 单元测试：grep / glob / .gitignore 三组用例，共 10 条。
// 设计要点：
//   - 每条用例都用真实 tmp 目录（避免共享 fs）+ 真实 WorkspaceFS 沙箱。
//   - 构造最小 ToolContext（搜索工具只用 wsFs / workspaceDir / sendStreamChunk，
//     skillRegistry / roomId / streamSessionId / permissionConfig 给 stub）。
//   - loadGitignore 的 cache 按 workspaceDir 分桶，beforeEach 用唯一 tmpDir
//     保证用例间不串数据。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { SearchTools } from '../../../src/main/agent/tools/search-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

// 每个 beforeEach 用唯一 tmpDir，避免 SearchTools 内部的 gitignoreCache（模块级 Map）
// 在用例间串数据；不复用 file-tools.test.ts 的模块级 tmpDir 模式。
let tmpRoot: string;
let tmpDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `ap-search-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  // 最小 ToolContext：search 工具只用 wsFs / workspaceDir，其他字段给空 stub
  // （实现里不会触碰 skillRegistry / streamSessionId 等）。
  ctx = {
    wsFs,
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['grep', 'glob'], deniedTools: [] },
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SearchTools grep', () => {
  it('简单字符串匹配（file:line:content 格式，1-based 行号）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), 'const x = 1;\n// TODO: fix\n');
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'TODO' }, ctx);
    expect(result).toContain('a.ts:2:// TODO: fix');
  });

  it('include glob 过滤（只看 .ts，不看 .md）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), 'TODO\n');
    await fs.promises.writeFile(path.join(tmpDir, 'b.md'), 'TODO\n');
    const tools = new SearchTools();
    const result = await tools.execute(
      'grep',
      { pattern: 'TODO', include: '*.ts' },
      ctx,
    );
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.md');
  });

  it('caseInsensitive 切换（默认区分大小写，开启后命中）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'Hello World\n');
    const tools = new SearchTools();
    expect(await tools.execute('grep', { pattern: 'hello' }, ctx)).toBe('(无匹配)');
    expect(
      await tools.execute('grep', { pattern: 'hello', caseInsensitive: true }, ctx),
    ).toContain('Hello World');
  });

  it('自动排除 node_modules（硬编码 DEFAULT_IGNORE）', async () => {
    await fs.promises.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'node_modules/lib.js'), 'TODO\n');
    await fs.promises.writeFile(path.join(tmpDir, 'src.ts'), 'TODO\n');
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'TODO' }, ctx);
    expect(result).toContain('src.ts');
    expect(result).not.toContain('node_modules');
  });

  it('非法正则抛错（明确错误消息）', async () => {
    const tools = new SearchTools();
    await expect(tools.execute('grep', { pattern: '[' }, ctx)).rejects.toThrow(/非法正则/);
  });

  it('50 条上限触发（单文件 100 个匹配 → 输出含已达上限提示）', async () => {
    let content = '';
    for (let i = 0; i < 100; i++) content += 'match\n';
    await fs.promises.writeFile(path.join(tmpDir, 'big.txt'), content);
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'match' }, ctx);
    // 实现走 limitReached 分支，输出含「已达上限」字样（让 LLM 缩小范围）
    expect(result).toContain('已达上限');
  });
});

describe('SearchTools glob', () => {
  it('简单 glob 模式（**/*.ts 匹配 .ts，不匹配 .md）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'b.ts'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'c.md'), '');
    const tools = new SearchTools();
    const result = await tools.execute('glob', { pattern: '**/*.ts' }, ctx);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
    expect(result).not.toContain('c.md');
  });

  it('自动排除 .git（硬编码 DEFAULT_IGNORE）', async () => {
    await fs.promises.mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, '.git/config'), '');
    await fs.promises.writeFile(path.join(tmpDir, 'real.ts'), '');
    const tools = new SearchTools();
    const result = await tools.execute('glob', { pattern: '**/*' }, ctx);
    expect(result).toContain('real.ts');
    expect(result).not.toContain('.git');
  });
});

describe('SearchTools .gitignore 集成', () => {
  it('尊重 workspace .gitignore（*.log 应被忽略）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '.gitignore'), '*.log\n');
    await fs.promises.writeFile(path.join(tmpDir, 'app.ts'), 'TODO\n');
    await fs.promises.writeFile(path.join(tmpDir, 'debug.log'), 'TODO\n');
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'TODO' }, ctx);
    expect(result).toContain('app.ts');
    expect(result).not.toContain('debug.log');
  });

  it('.gitignore 不存在时静默降级（不抛错，正常匹配）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), 'TODO\n');
    const tools = new SearchTools();
    expect(await tools.execute('grep', { pattern: 'TODO' }, ctx)).toContain('a.ts');
  });
});
