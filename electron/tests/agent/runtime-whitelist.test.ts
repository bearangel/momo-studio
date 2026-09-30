// electron/tests/agent/runtime-whitelist.test.ts
//
// v2.x 白名单修复回归锁（spec §4.1）：
//   1. 纯函数：unionDynamicToolNames 只并入非 builtin 工具名；空数组语义不变；
//      denied 优先级不受影响
//   2. 集成：真实链路（parseConfig → buildRuntimeContext）后，allowedTools 只含
//      配置项 + 动态工具，bash 被拒绝——修复前该链路 bash 会被放行（测试红）
// DB 隔离模式抄 dispatch-snapshot.test.ts（AP_USER_DATA_DIR 临时目录）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { parseConfig } from '../../src/main/agent/runtime-config';
import {
  buildRuntimeContext,
  unionDynamicToolNames,
} from '../../src/main/agent/runtime-entry';
import { assertToolAllowed } from '../../src/main/agent/tools/shared/permission';
import type { LLMToolDef } from '../../src/main/agent/llm-provider';

const tmpRoot = path.join(os.tmpdir(), `ap-whitelist-test-${Date.now()}-${process.pid}`);
const wsDir = path.join(tmpRoot, 'ws');

beforeEach(() => {
  fs.mkdirSync(wsDir, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', ?, 0, '@owner:local', '📁')`,
  ).run(wsDir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function def(name: string): LLMToolDef {
  return { name, description: '', inputSchema: { type: 'object', properties: {} } };
}

describe('unionDynamicToolNames（纯函数）', () => {
  const builtin = new Set(['read_file', 'bash']);
  const all = [def('read_file'), def('bash'), def('loadSkill'), def('task_complete')];

  it('只并入非 builtin 工具名——bash 不被并入', () => {
    const out = unionDynamicToolNames(['read_file'], all, builtin);
    expect(out).toContain('read_file');
    expect(out).toContain('loadSkill');
    expect(out).toContain('task_complete');
    expect(out).not.toContain('bash');
  });

  it('不改变空数组语义（空 = 不启用白名单，原样返回）', () => {
    expect(unionDynamicToolNames([], all, builtin)).toEqual([]);
  });

  it('denied 命中仍拒绝（并入白名单之后）', () => {
    const out = unionDynamicToolNames(['read_file'], all, builtin);
    // loadSkill 已被并入 allowedTools，但 deniedTools 优先级更高
    expect(() =>
      assertToolAllowed('loadSkill', { allowedTools: out, deniedTools: ['loadSkill'] }),
    ).toThrow(/被禁止使用/);
  });
});

describe('buildRuntimeContext 集成（真实链路回归锁）', () => {
  it('allowedTools=[read_file] 的 agent：task_complete 放行、bash 拒绝', async () => {
    const opts = {
      agentAssignmentId: 'inst-1',
      agentUserId: '@agent:local',
      systemPrompt: 'p',
      modelName: 'm',
      llmApiKey: 'k',
      workspaceDir: wsDir,
      workspaceId: 'ws-1',
      role: 'standalone' as const,
      subAgents: [],
      skills: [],
      mcpNames: [],
      allowedTools: ['read_file'],
      deniedTools: [],
      isLeader: false,
      devMode: false,
      maxToolCalls: -1,
      contextWindow: 0,
      outputTokens: 0,
    };
    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    await buildRuntimeContext(config);
    // 修复点：内置 bash 不被自动并入（修复前此断言失败——白名单被扩成全集）
    expect(config.allowedTools).not.toContain('bash');
    // Tier 0 loop 工具仍被并入（平台机制恒放行）
    expect(config.allowedTools).toContain('task_complete');
    expect(config.allowedTools).toContain('compact');
    // 所配即所得：read_file 放行
    expect(() =>
      assertToolAllowed('read_file', { allowedTools: config.allowedTools, deniedTools: [] }),
    ).not.toThrow();
    expect(() =>
      assertToolAllowed('bash', { allowedTools: config.allowedTools, deniedTools: [] }),
    ).toThrow(/不在允许列表中/);
  });
});
