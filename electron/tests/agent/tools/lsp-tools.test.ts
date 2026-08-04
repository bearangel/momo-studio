// electron/tests/agent/tools/lsp-tools.test.ts
//
// LspTools 单元测试（6 用例）：lsp_diagnostics + lsp_find_references +
//   shouldRegister 条件注册 + LspTools.create 工厂 + LspManager 生命周期。
//
// 设计要点（与 spec 10.3 一致——LSP 用真实 typescript-language-server）：
//   - 不 mock LSP server，spawn 真实进程验证 JSON-RPC 协议正确性。
//   - LSP server 冷启动 3-5s + 诊断/引用计算耗时，单测 timeout 拉到 30s。
//   - 每个用例用唯一 workspaceId（per-workspace 单例 Map 隔离，避免串数据）。
//   - afterEach 强制 shutdownLspManager，防止 tsserver 子进程泄漏（每个 ~200MB）。
//   - 测试 workspace 内放 tsconfig.json，确保 typescript-language-server 把文件当作
//     project 成员解析（跨文件 find_references 必须有共同 project）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import {
  LspTools,
  shouldRegister,
  getLspManager,
  shutdownLspManager,
  shutdownAllLspManagers,
} from '../../../src/main/agent/tools/lsp-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

// LSP server 冷启动 + 诊断计算可能较慢；每个触及真实 server 的用例给 30s。
const LSP_TEST_TIMEOUT = 30_000;

let tmpRoot: string;
let tmpDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;
// 每个用例唯一 workspaceId，避免模块级单例 Map 串数据。
let workspaceId: string;

beforeEach(() => {
  workspaceId = `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpRoot = path.join(os.tmpdir(), `ap-lsp-tools-${workspaceId}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  ctx = {
    wsFs,
    workspaceId,
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['lsp_diagnostics', 'lsp_find_references'], deniedTools: [] },
  };
});

afterEach(async () => {
  // 强制关闭本用例的 LspManager，防止 tsserver 子进程泄漏。
  await shutdownLspManager(workspaceId);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 全部用例跑完后再扫一遍，确保没有任何遗留进程（跨用例防御）。
afterEach(async () => {
  await shutdownAllLspManagers();
});

describe('LspTools shouldRegister（条件注册）', () => {
  it('tsconfig.json / jsconfig.json / .ts / .js 任一存在即注册；纯 .md 目录不注册', () => {
    // 空目录不注册
    expect(shouldRegister(tmpDir)).toBe(false);

    // 只有 .md 不注册
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# hi');
    expect(shouldRegister(tmpDir)).toBe(false);

    // tsconfig.json 触发注册
    const dirTs = path.join(tmpRoot, 'with-tsconfig');
    fs.mkdirSync(dirTs, { recursive: true });
    fs.writeFileSync(path.join(dirTs, 'tsconfig.json'), '{}');
    expect(shouldRegister(dirTs)).toBe(true);

    // jsconfig.json 触发注册
    const dirJs = path.join(tmpRoot, 'with-jsconfig');
    fs.mkdirSync(dirJs, { recursive: true });
    fs.writeFileSync(path.join(dirJs, 'jsconfig.json'), '{}');
    expect(shouldRegister(dirJs)).toBe(true);

    // 顶层有 .ts 文件触发注册
    const dirTsFile = path.join(tmpRoot, 'with-ts-file');
    fs.mkdirSync(dirTsFile, { recursive: true });
    fs.writeFileSync(path.join(dirTsFile, 'foo.ts'), 'export const x = 1;');
    expect(shouldRegister(dirTsFile)).toBe(true);

    // 顶层有 .js 文件触发注册
    const dirJsFile = path.join(tmpRoot, 'with-js-file');
    fs.mkdirSync(dirJsFile, { recursive: true });
    fs.writeFileSync(path.join(dirJsFile, 'foo.js'), 'module.exports = 1;');
    expect(shouldRegister(dirJsFile)).toBe(true);

    // 子目录里的 .ts 不触发（只看顶层）
    const dirNested = path.join(tmpRoot, 'with-nested');
    fs.mkdirSync(path.join(dirNested, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dirNested, 'sub', 'foo.ts'), 'export const x = 1;');
    expect(shouldRegister(dirNested)).toBe(false);
  });
});

describe('LspTools.create（条件工厂）', () => {
  it('不可注册 workspace 返回 null；可注册 workspace 返回带 2 个工具定义的实例', () => {
    // 纯 .md 目录 → null
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# hi');
    expect(LspTools.create(ctx)).toBeNull();

    // 加 tsconfig.json → 返回实例
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', strict: true, target: 'es2020' },
    }));
    const tools = LspTools.create(ctx);
    expect(tools).not.toBeNull();
    const defs = tools!.getDefs();
    expect(defs.map((d) => d.name).sort()).toEqual(['lsp_diagnostics', 'lsp_find_references']);
    expect(tools!.handles('lsp_diagnostics')).toBe(true);
    expect(tools!.handles('lsp_find_references')).toBe(true);
    expect(tools!.handles('grep')).toBe(false);
  });
});

describe('LspTools lsp_diagnostics（真实 typescript-language-server）', () => {
  beforeEach(() => {
    // typescript-language-server 需要把文件识别为 project 成员才出诊断。
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', strict: true, target: 'es2020' },
    }));
  });

  it(
    '类型错误文件返回含 severity/line/message 的诊断',
    async () => {
      // number 变量赋字符串值——TS2322 必报错。
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x: number = "not a number";\n');
      const tools = LspTools.create(ctx)!;
      const result = await tools.execute('lsp_diagnostics', { path: 'a.ts' }, ctx);

      // 结果应包含文件名、1-based 行号（=1）、错误描述关键词。
      expect(result).toContain('a.ts');
      expect(result).toContain(':1:'); // 行号
      // TS2322 错误文案包含 "Type" 与 "is not assignable to type"
      expect(result.toLowerCase()).toMatch(/type.*not assignable|不能将类型|不可分配/);
    },
    LSP_TEST_TIMEOUT,
  );

  it(
    '干净文件返回「无诊断」语义标记',
    async () => {
      fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'export const value: number = 42;\n');
      const tools = LspTools.create(ctx)!;
      const result = await tools.execute('lsp_diagnostics', { path: 'clean.ts' }, ctx);

      // 无诊断时应返回明确的空标记（不能是空字符串——LLM 需区分「无」与「未运行」）。
      expect(result).toMatch(/无诊断|no diagnostics|✓/i);
    },
    LSP_TEST_TIMEOUT,
  );
});

describe('LspTools lsp_find_references（真实 typescript-language-server）', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', strict: true, target: 'es2020' },
    }));
  });

  it(
    '跨文件查找符号引用：返回定义处 + 引用处两个位置',
    async () => {
      // a.ts 定义 mySymbol；b.ts 引用它。find_references 应同时命中两处。
      // `export const mySymbol` —— 'm' 在 0-based 列 13（export<sp>const<sp> = 13 字符）。
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const mySymbol = 42;\n');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), "import { mySymbol } from './a';\nconsole.log(mySymbol);\n");

      const tools = LspTools.create(ctx)!;
      const result = await tools.execute(
        'lsp_find_references',
        { path: 'a.ts', line: 1, character: 13 },
        ctx,
      );

      // 结果应同时包含 a.ts（定义）和 b.ts（引用）。
      expect(result).toContain('a.ts');
      expect(result).toContain('b.ts');
    },
    LSP_TEST_TIMEOUT,
  );
});

describe('LspManager 生命周期（shutdown 清理）', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', strict: true, target: 'es2020' },
    }));
  });

  it(
    'getDiagnostics 启动 server（isStarted=true）；shutdown 后 isStarted=false 且下次调用重启',
    async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export const value: number = 42;\n');
      const tools = LspTools.create(ctx)!;

      // 调一次 diagnostics 触发懒启动。
      await tools.execute('lsp_diagnostics', { path: 'a.ts' }, ctx);
      const mgr = getLspManager(workspaceId);
      expect(mgr).toBeDefined();
      expect(mgr!.isStarted()).toBe(true);

      // 显式 shutdown：进程应被杀掉，isStarted 归 false。
      await shutdownLspManager(workspaceId);
      expect(mgr!.isStarted()).toBe(false);

      // 再次调用应触发重启（ensureStarted 重新 spawn + initialize）。
      await tools.execute('lsp_diagnostics', { path: 'a.ts' }, ctx);
      expect(mgr!.isStarted()).toBe(true);
    },
    LSP_TEST_TIMEOUT,
  );
});
