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
  function buildOpts(overrides: Partial<Record<'allowedTools' | 'deniedTools', string[]>> = {
    allowedTools: ['read_file'],
    deniedTools: [],
  }) {
    return {
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
      isLeader: false,
      devMode: false,
      maxToolCalls: -1,
      contextWindow: 0,
      outputTokens: 0,
      ...overrides,
    };
  }

  it('allowedTools=[read_file] 的 agent：task_complete 放行、bash 拒绝', async () => {
    const config = parseConfig(JSON.parse(JSON.stringify(buildOpts())));
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

  // v2.x 展示层过滤（GUI 终验缺陷回归锁，spec 目标 2 的另一半）：
  // ctx.tools（LLM 请求里的工具 schema，唯一消费点 chatStream）必须与白名单收敛——
  // 否则 agent 自报工具与配置不符（用户实测定案：31 工具配置自报 65 全集），
  // 且每个 agent 白白背负全量工具 schema 的 token。
  describe('展示层过滤（LLM 工具面 = 所配即所得）', () => {
    it('allowedTools=[read_file] → ctx.tools 只含所配 + Tier 0，不含未配的 bash/浏览器/办公', async () => {
      const config = parseConfig(JSON.parse(JSON.stringify(buildOpts())));
      const ctx = await buildRuntimeContext(config);
      const names = ctx.tools.map((t) => t.name);
      // 所配工具可见
      expect(names).toContain('read_file');
      // Tier 0 平台机制可见（并集先于过滤——顺序契约）
      expect(names).toContain('task_complete');
      expect(names).toContain('compact');
      // 未配置的内置工具从展示面剔除（修复前此断言失败——ctx.tools 是全模块全集）
      expect(names).not.toContain('bash');
      expect(names).not.toContain('browser_navigate');
      expect(names).not.toContain('office_read');
      expect(names).not.toContain('memory_save');
    });

    it('deniedTools 命中的工具从展示面剔除（白名单空 = 其余全展示）', async () => {
      const config = parseConfig(
        JSON.parse(JSON.stringify(buildOpts({ allowedTools: [], deniedTools: ['bash'] }))),
      );
      const ctx = await buildRuntimeContext(config);
      const names = ctx.tools.map((t) => t.name);
      expect(names).not.toContain('bash');
      expect(names).toContain('read_file');
      expect(names).toContain('office_read');
    });

    it('allowedTools=[] 且无 denied → 全量展示（现状语义不变）', async () => {
      const config = parseConfig(
        JSON.parse(JSON.stringify(buildOpts({ allowedTools: [], deniedTools: [] }))),
      );
      const ctx = await buildRuntimeContext(config);
      const names = ctx.tools.map((t) => t.name);
      expect(names).toContain('bash');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('office_read');
    });
  });
});
