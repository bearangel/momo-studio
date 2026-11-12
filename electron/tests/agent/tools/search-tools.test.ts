// electron/tests/agent/tools/search-tools.test.ts
//
// SearchTools 单元测试：grep / glob / .gitignore 三组用例，共 15 条。
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
import { DirectContentIo } from '../../../src/main/files/file-io/content-io';
import { SearchTools } from '../../../src/main/agent/tools/search-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import type { ContentIo } from '../../../src/main/files/file-io/types';

// 实测 E-SafeNet 容器头（cipher-detect.test.ts 同款；魔数在前 64 字节内）
const CIPHER_HEAD = Buffer.from(
  '62142365DA00260100000001452D536166654E65740000004C4F434B',
  'hex',
);

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
    creatorUserId: '',
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

  // spec 2026-11-02 §5.4：path 可能是单个文件（真实会话传入中文文件名 HTML，
  // 旧实现一律当目录交给 fast-glob → ENOTDIR）。文件名用中文，锁住非 ASCII 路径。
  it('path 指向单个文件时只搜该文件', async () => {
    await fs.promises.writeFile(
      path.join(tmpDir, '研发周报PPT模板.html'),
      '<h1>第 1 页</h1>\n<h2>TODO: 补第 2 页</h2>\n',
    );
    await fs.promises.writeFile(path.join(tmpDir, 'other.ts'), 'TODO\n');
    const tools = new SearchTools();
    // include 在单文件模式下被忽略（只可能命中这一个文件），故意传不匹配的 *.ts
    const result = await tools.execute(
      'grep',
      { pattern: 'TODO', path: '研发周报PPT模板.html', include: '*.ts' },
      ctx,
    );
    expect(result).toContain('研发周报PPT模板.html:2:<h2>TODO: 补第 2 页</h2>');
    expect(result).not.toContain('other.ts');
  });

  // 回归锁（spec §5.4：显式点名的文件绕过 DEFAULT_IGNORE 与 .gitignore）：
  // 若实现仍走过滤层，本用例会得到「(无匹配)」而失败。
  it('显式点名的文件即使被 .gitignore 与 DEFAULT_IGNORE 覆盖也能搜到', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '.gitignore'), '*.log\n');
    await fs.promises.writeFile(path.join(tmpDir, 'debug.log'), 'TODO\n');
    await fs.promises.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'dist/ship.html'), 'SHIP\n');
    const tools = new SearchTools();

    // 目录模式对照：两层忽略都要生效（行为不变）
    expect(await tools.execute('grep', { pattern: 'TODO' }, ctx)).toBe('(无匹配)');
    expect(await tools.execute('grep', { pattern: 'SHIP' }, ctx)).toBe('(无匹配)');

    // 显式点名：忽略层不参与
    expect(await tools.execute('grep', { pattern: 'TODO', path: 'debug.log' }, ctx)).toContain(
      'debug.log:1:TODO',
    );
    expect(
      await tools.execute('grep', { pattern: 'SHIP', path: 'dist/ship.html' }, ctx),
    ).toContain('ship.html:1:SHIP');
  });

  it('文件超过 1MB 时明确提示未搜索，而不是 (无匹配)', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'huge.html'), 'x'.repeat(1024 * 1024 + 16));
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'TODO', path: 'huge.html' }, ctx);
    expect(result).toContain('超过 1MB 未搜索');
    expect(result).toContain('huge.html');
    expect(result).not.toContain('(无匹配)');
    // 下一步必须可执行（终审 Minor 5）：grep 没有行范围参数，建议「再用 grep
    // 逐段核」是死路——模型照着做只会再撞同一个 1MB 上限。
    expect(result).toContain('read_file');
    expect(result).not.toContain('用 grep 逐段核');
  });

  it('path 不存在时抛明确中文错误', async () => {
    const tools = new SearchTools();
    await expect(
      tools.execute('grep', { pattern: 'TODO', path: 'nope.html' }, ctx),
    ).rejects.toThrow(/路径不存在: nope\.html/);
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

  // glob 的 path 语义仍是「目录」；不存在时给与 grep 一致的明确文案
  it('path 不存在时抛明确中文错误', async () => {
    const tools = new SearchTools();
    await expect(
      tools.execute('glob', { pattern: '**/*.ts', path: 'no-such-dir' }, ctx),
    ).rejects.toThrow(/路径不存在: no-such-dir/);
  });

  // 终审 Minor 3：path 指向文件时旧实现把该路径交给 fast-glob，抛裸
  // `ENOTDIR: not a directory, scandir`——模型看不出是「用错了工具」还是「越界」。
  it('path 指向文件时抛可执行的中文错误（不再是裸 ENOTDIR）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'report.html'), '<h1>x</h1>');
    const tools = new SearchTools();
    let err: Error | null = null;
    try {
      await tools.execute('glob', { pattern: '**/*.ts', path: 'report.html' }, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain('path 必须是目录: report.html');
    expect(err?.message).not.toContain('ENOTDIR');
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

  it('.gitignore 本身是密文时按读取失败降级（不当规则表解析，搜索不中断）', async () => {
    // 注：默认通道 strict 读密文本应抛 EENCRYPTED——loadGitignore 捕获后降级 null；
    // 非 strict 时魔数自检同样降级。此处用非 strict 通道锁自检路径。
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), CIPHER_HEAD);
    await fs.promises.writeFile(path.join(tmpDir, 'a.ts'), 'TODO\n');
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: new DirectContentIo(false) });
    const tools = new SearchTools();
    expect(await tools.execute('grep', { pattern: 'TODO' }, ctx)).toContain('a.ts:1:TODO');
  });
});

// ── B 方案收口：密文安全闸 + 批量通道读（spec 2026-11-11 补遗）──

describe('SearchTools grep 密文安全闸（B 方案收口）', () => {
  it('单文件密文 → 明确报错（strict 通道 EENCRYPTED 或自检拒绝，绝非「(无匹配)」）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    const tools = new SearchTools();
    let err: Error | null = null;
    try {
      await tools.execute('grep', { pattern: 'class', path: 'Enc.java' }, ctx);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/加密/);
    expect(err?.message).toContain('Enc.java');
  });

  it('单文件密文 + strict=false 通道 → 自检仍拒绝（自检独立于 strict 设置）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: new DirectContentIo(false) });
    const tools = new SearchTools();
    await expect(
      tools.execute('grep', { pattern: 'class', path: 'Enc.java' }, ctx),
    ).rejects.toThrow(/已加密（E-SafeNet 容器）/);
  });

  it('目录混合（明文 + 密文）→ 命中明文 + 末尾「已跳过 N 个加密文件」', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'ok1.ts'), 'NEEDLE in ok1\n');
    fs.writeFileSync(path.join(tmpDir, 'Enc1.java'), CIPHER_HEAD);
    fs.writeFileSync(path.join(tmpDir, 'Enc2.java'), CIPHER_HEAD);
    await fs.promises.writeFile(path.join(tmpDir, 'ok2.ts'), 'NEEDLE in ok2\n');
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE' }, ctx);
    expect(result).toContain('ok1.ts:1:NEEDLE in ok1');
    expect(result).toContain('ok2.ts:1:NEEDLE in ok2');
    expect(result).toContain('⚠ 已跳过 2 个加密文件: Enc1.java, Enc2.java');
  });

  it('目录全密文无命中 → 不再是裸「(无匹配)」，跳过提示可见', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE' }, ctx);
    expect(result).toContain('(无匹配)');
    expect(result).toContain('⚠ 已跳过 1 个加密文件: Enc.java');
  });

  it('跳过名单超 10 个截断展示（计数仍为全量）', async () => {
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(tmpDir, `Enc${i}.java`), CIPHER_HEAD);
    }
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE' }, ctx);
    // fast-glob 字典序：Enc1, Enc10, Enc11, Enc12, Enc2..Enc7 为前 10，Enc8/Enc9 截掉
    expect(result).toContain('⚠ 已跳过 12 个加密文件: ');
    expect(result).toContain('Enc7.java …');
    expect(result).not.toContain('Enc8.java');
    expect(result).not.toContain('Enc9.java');
  });

  it('strict 通道整批硬失败时退化逐文件定位密文（跳过而非整次失败）', async () => {
    // 默认 WorkspaceFS 即 DirectContentIo(strict=true)：批读抛 EENCRYPTED，
    // readBatchWithCipherSkip 应退化为逐文件并把密文归入跳过。
    await fs.promises.writeFile(path.join(tmpDir, 'ok.ts'), 'NEEDLE\n');
    fs.writeFileSync(path.join(tmpDir, 'Enc.java'), CIPHER_HEAD);
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE' }, ctx);
    expect(result).toContain('ok.ts:1:NEEDLE');
    expect(result).toContain('⚠ 已跳过 1 个加密文件: Enc.java');
  });

  it('命中上限 early-exit 保持：单文件 100 命中 → 「已达上限」仍出现', async () => {
    let content = '';
    for (let i = 0; i < 100; i++) content += 'match\n';
    await fs.promises.writeFile(path.join(tmpDir, 'big.txt'), content);
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'match' }, ctx);
    expect(result).toContain('已达上限');
  });
});

describe('SearchTools grep 批量通道读（B 方案收口）', () => {
  /** 真实 fs 后端的记录型通道：readFile/readFiles 读盘并记录每批大小 */
  function recordingIo(): ContentIo & { batches: number[] } {
    const io = {
      batches: [] as number[],
      async readFile(p: string) {
        return fs.promises.readFile(p);
      },
      async readFiles(ps: string[]) {
        io.batches.push(ps.length);
        const out: Buffer[] = [];
        for (const p of ps) out.push(await fs.promises.readFile(p));
        return out;
      },
      async writeFile(p: string, d: Buffer) {
        return fs.promises.writeFile(p, d);
      },
    };
    return io;
  }

  it('目录模式经 wsFs.readFiles 批量读，每批 ≤16', async () => {
    for (let i = 1; i <= 35; i++) {
      await fs.promises.writeFile(path.join(tmpDir, `f${i}.ts`), `NEEDLE ${i}\n`);
    }
    const io = recordingIo();
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: io });
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE' }, ctx);
    expect(result).toContain('f35.ts:1:NEEDLE 35');
    expect(io.batches.length).toBeGreaterThan(0);
    // 35 个文件（.gitignore 不存在不进批）→ 3 批：16 + 16 + 3
    expect(io.batches.every((n) => n <= 16)).toBe(true);
    expect(io.batches.reduce((a, b) => a + b, 0)).toBe(35);
  });

  it('单文件模式走 readFile 单发（不进批量面）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'one.ts'), 'NEEDLE\n');
    const io = recordingIo();
    ctx.wsFs = new WorkspaceFS(tmpDir, { contentIo: io });
    const tools = new SearchTools();
    const result = await tools.execute('grep', { pattern: 'NEEDLE', path: 'one.ts' }, ctx);
    expect(result).toContain('one.ts:1:NEEDLE');
    expect(io.batches).toHaveLength(0);
  });
});
