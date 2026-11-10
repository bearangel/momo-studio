// electron/tests/agent/tools/resource-tools.test.ts
import { describe, it, expect } from 'vitest';
import { ResourceTools } from '../../../src/main/agent/tools/resource-tools';
import { ALL_BUILTIN_TOOLS } from '../../../src/main/agent/tools/catalog';

const fakeOp = (result: unknown) => async (_op: string, _args: Record<string, unknown>) => result;
const mk = (r: unknown) => new ResourceTools(fakeOp(r));

describe('ResourceTools', () => {
  it('六工具名进目录全集（58→64）', () => {
    const names = new ResourceTools(fakeOp(null)).getDefs().map((d) => d.name);
    expect(names).toEqual([
      'resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team',
    ]);
    for (const n of names) expect(ALL_BUILTIN_TOOLS).toContain(n);
  });

  it('handles 精确匹配六个名', () => {
    const t = mk(null);
    expect(t.handles('create_agent')).toBe(true);
    expect(t.handles('create_agent_v2')).toBe(false);
    expect(t.handles('resource_list')).toBe(true);
  });

  it('execute 映射 op 并 JSON 化结果', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const t = new ResourceTools(async (op, args) => { calls.push([op, args]); return { teamId: 't1' }; });
    const out = await t.execute('create_team', { name: 'X', memberInstanceIds: ['a', 'b'], leaderInstanceId: 'a' }, ctx);
    expect(calls[0]![0]).toBe('createTeam');
    expect(out).toContain('t1');
  });

  it('create_agent description 明示 model 块必填（回归锁：曾仅写「模型缺省」被 agent 读成可省略）', () => {
    const def = new ResourceTools(fakeOp(null)).getDefs().find((d) => d.name === 'create_agent');
    expect(def?.description).toContain('必填');
  });

  it('无 IPC 通道时干净失败（默认 callOp 无 process.send → 中文 reject）', async () => {
    const t = new ResourceTools(); // 不注入——生产默认 requestResourceOp
    await expect(t.execute('resource_list', {}, ctx)).rejects.toThrow('未建立 IPC 通道');
  });
});

const ctx = {} as Parameters<ResourceTools['execute']>[2]; // ToolContext 最小占位（本模块不消费 ctx 字段）
