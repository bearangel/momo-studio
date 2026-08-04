// electron/tests/agent/tools/integration.test.ts
//
// v1.5 Task 16：端到端集成测试——模拟 agent 完整工作流。
//
// 验证目标：
//   1. 多工具串联可用（list → write → edit → grep → mkdir+write → git_add），
//      覆盖 file/search/git 三大类协作场景，证明 tools/index.ts 注册中心路由正确。
//   2. getAllToolDefs 把全部模块的 LLMToolDef 聚合暴露给 LLM（7 大类工具可见）。
//   3. 工具权限白/黑名单生效——deniedTools 命中即拦截。
//
// 权限测试说明：
//   生产代码中，权限校验在 runtime-entry.doExecuteTool 的入口处调用 assertToolAllowed
//   完成（注释见 file-tools.ts:「permissionConfig 在前置 assertToolAllowed 已校验，
//   注册中心内不再重复」）。tools/index.ts 的 executeTool 是纯路由分派，不重复校验
//   ——这是有意的职责分离。因此本测试直接对 assertToolAllowed 断言拦截行为，与
//   生产代码的实际拦截点一致；同时反向验证默认 ctx 下 executeTool 可正常分派 bash。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import { buildToolRegistry, getAllToolDefs, executeTool } from '../../../src/main/agent/tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { assertToolAllowed } from '../../../src/main/agent/tools/shared/permission';

let tmpDir: string;
let ctx: ToolContext;
let modules: ReturnType<typeof buildToolRegistry>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-integration-'));
  // git init 让 git_add 等工具可用；-b main 显式指定默认分支名（避免 git 版本差异）
  execSync('git init -b main', { cwd: tmpDir });
  execSync('git config user.email t@t.com && git config user.name T', { cwd: tmpDir });
  ctx = {
    wsFs: new WorkspaceFS(tmpDir),
    workspaceId: 'ws',
    workspaceDir: tmpDir,
    // skillRegistry 在集成测试中不被调用，给个最小 stub 满足类型约束
    skillRegistry: { list: () => [] } as never,
    streamSessionId: 'ssn',
    roomId: '!r',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
  };
  // buildToolRegistry 内部按 workspaceDir 条件注册 LspTools；
  // tmpDir 此时无 tsconfig/.ts/.js → shouldRegister=false → LSP 不注册（符合预期）
  modules = buildToolRegistry(ctx);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('agent 完整工作流', () => {
  it('list → write → edit → grep → mkdir+write test → git_add，全部工具暴露给 LLM', async () => {
    // 1. 列出 workspace（空目录，仅返回友好提示，不抛错）
    const list = await executeTool('list_files', { path: '.' }, ctx, modules);
    expect(list).toBeDefined();

    // 2. 写一个 TS 源文件
    await executeTool(
      'write_file',
      { path: 'app.ts', content: 'export function add(a: number, b: number) {\n  return a + b;\n}\n' },
      ctx,
      modules,
    );

    // 3. edit 精确替换一行（str_replace 唯一匹配语义）
    await executeTool(
      'edit_file',
      {
        path: 'app.ts',
        oldString: 'return a + b;',
        newString: 'return a + b + 1;',
      },
      ctx,
      modules,
    );

    // 4. grep 找符号——返回 file:line:content 格式，必须含 app.ts
    const grepResult = await executeTool('grep', { pattern: 'add' }, ctx, modules);
    expect(grepResult).toContain('app.ts');

    // 5. mkdir + 在子目录下写测试文件（write_file 自动递归创建父目录）
    await executeTool('mkdir', { path: 'tests' }, ctx, modules);
    await executeTool('write_file', {
      path: 'tests/app.test.ts',
      content: 'import { add } from "../app";\n',
    }, ctx, modules);

    // 6. git_add 暂存全部改动。git_commit 需要 GitPolicy 配置（allowAgentCommits +
    //    分支保护 + message pattern），集成测试不 mock policy，故只验证 add 阶段。
    await executeTool('git_add', { paths: ['.'] }, ctx, modules);

    // 7. 全部工具类别暴露给 LLM（getAllToolDefs 聚合所有模块的 LLMToolDef）
    const defs = getAllToolDefs(modules);
    const names = new Set(defs.map((d) => d.name));
    // 文件类
    expect(names.has('read_file')).toBe(true);
    expect(names.has('edit_file')).toBe(true);
    expect(names.has('mkdir')).toBe(true);
    // 搜索类
    expect(names.has('grep')).toBe(true);
    expect(names.has('glob')).toBe(true);
    // Shell 类
    expect(names.has('bash')).toBe(true);
    // Git 类（commit 工具存在，运行时由 GitPolicy 决定是否放行）
    expect(names.has('git_status')).toBe(true);
    expect(names.has('git_add')).toBe(true);
    expect(names.has('git_commit')).toBe(true);
    expect(names.has('git_diff')).toBe(true);
    expect(names.has('git_log')).toBe(true);
    expect(names.has('git_show')).toBe(true);
    expect(names.has('git_branch')).toBe(true);
    expect(names.has('git_checkout')).toBe(true);
    expect(names.has('git_stash')).toBe(true);
    // Web 类
    expect(names.has('webfetch')).toBe(true);
    // Todo 类
    expect(names.has('todowrite')).toBe(true);
    // LSP 类：本测试 workspace 无 tsconfig → 不应注册（验证条件注册逻辑正确）
    expect(names.has('lsp_diagnostics')).toBe(false);
    expect(names.has('lsp_find_references')).toBe(false);
  }, 60000);

  it('权限白/黑名单生效：deniedTools 命中即拦截，默认放行', async () => {
    // 拦截路径：assertToolAllowed 是生产代码的权限闸口（runtime-entry.doExecuteTool
    // 入口处调用）。deniedTools 优先级高于 allowedTools——命中即抛「被禁止」。
    const deniedConfig = { allowedTools: [], deniedTools: ['bash'] };
    expect(() => assertToolAllowed('bash', deniedConfig)).toThrow(/被禁止/);

    // 通配符支持：git_* 拦截全部 git 工具
    const wildcardConfig = { allowedTools: [], deniedTools: ['git_*'] };
    expect(() => assertToolAllowed('git_commit', wildcardConfig)).toThrow(/被禁止/);
    expect(() => assertToolAllowed('git_status', wildcardConfig)).toThrow(/被禁止/);

    // 放行路径：默认 ctx（deny 为空 + allow 为空 = 全允许）下，executeTool 正常分派
    // bash 到 ShellTools 执行。echo hello 必返回 exit_code: 0。
    const result = await executeTool('bash', { command: 'echo hello' }, ctx, modules);
    expect(result).toContain('exit_code: 0');
    expect(result).toContain('hello');
  }, 30000);
});
