// electron/tests/agent/tools/resource-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ResourceTools } from '../../../src/main/agent/tools/resource-tools';
import { ALL_BUILTIN_TOOLS } from '../../../src/main/agent/tools/catalog';

const fakeOp = (result: unknown) => async (_op: string, _args: Record<string, unknown>) => result;
const mk = (r: unknown) => new ResourceTools(fakeOp(r));

describe('ResourceTools', () => {
  it('十二工具名进目录全集（65→70）', () => {
    const names = new ResourceTools(fakeOp(null)).getDefs().map((d) => d.name);
    expect(names).toEqual([
      'resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team', 'list_models',
      'describe_agent', 'update_agent_capabilities', 'update_agent_profile', 'update_skill', 'update_mcp',
    ]);
    for (const n of names) expect(ALL_BUILTIN_TOOLS).toContain(n);
  });

  it('handles 精确匹配七个名', () => {
    const t = mk(null);
    expect(t.handles('create_agent')).toBe(true);
    expect(t.handles('create_agent_v2')).toBe(false);
    expect(t.handles('resource_list')).toBe(true);
    expect(t.handles('list_models')).toBe(true);
    expect(t.handles('list_model')).toBe(false);
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

  it('模型三方契约在工具 description（回归锁：agent 曾把 manifest model.provider 填成供应商名 glm-code 而非平台枚举）', () => {
    const defs = new ResourceTools(fakeOp(null)).getDefs();
    expect(defs.find((d) => d.name === 'create_agent')?.description).toContain('platform 字段');
    expect(defs.find((d) => d.name === 'list_models')?.description).toContain('modelProviderId');
  });

  it('无 IPC 通道时干净失败（默认 callOp 无 process.send → 中文 reject）', async () => {
    const t = new ResourceTools(); // 不注入——生产默认 requestResourceOp
    await expect(t.execute('resource_list', {}, ctx)).rejects.toThrow('未建立 IPC 通道');
  });
});

describe('资源管理工具面（spec 2026-11-12 §5）', () => {
  it('五工具齐备且 handles/op 映射正确', () => {
    const tools = new ResourceTools(vi.fn(async () => ({})));
    const names = tools.getDefs().map((d) => d.name);
    for (const n of ['describe_agent', 'update_agent_capabilities', 'update_agent_profile', 'update_skill', 'update_mcp']) {
      expect(names).toContain(n);
      expect(tools.handles(n)).toBe(true);
    }
  });

  it('update_agent_capabilities 的 scope 缺省语义写进 description', () => {
    const def = new ResourceTools(vi.fn(async () => ({}))).getDefs().find((d) => d.name === 'update_agent_capabilities')!;
    expect(def.description).toContain('member');
    expect(def.description).toContain('definition');
  });

  it('update_agent_profile 停机生效表述条件化（F3：不得回退成无条件「发起者自身回合结束后自动生效」）', () => {
    const def = new ResourceTools(vi.fn(async () => ({}))).getDefs().find((d) => d.name === 'update_agent_profile')!;
    expect(def.description).toContain('若目标是发起者自身（或其定义）则回合结束后自动生效');
    expect(def.description).toContain('其它运行实例立即停止');
  });

  it('catalog：分类「资源管理」、defaultOn 全 false、riskNote 就位（buildCatalog fail-fast 兜底）', () => {
    const cat = new ResourceTools(vi.fn(async () => ({}))).getCatalog();
    const upd = cat.find((c) => c.name === 'update_agent_capabilities')!;
    expect(upd.category).toBe('资源管理');
    expect(upd.categoryEmoji).toBe('🧱');
    expect(upd.defaultOn).toBe(false);
    expect(upd.riskNote).toBeTruthy();
    expect(cat.find((c) => c.name === 'update_mcp')!.riskNote).toBeTruthy();
    // 五条 meta 全量就位（buildCatalog 缺 meta 即抛——到达即证明无漏项）
    for (const n of ['describe_agent', 'update_agent_profile', 'update_skill']) {
      expect(cat.find((c) => c.name === n)!.category).toBe('资源管理');
      expect(cat.find((c) => c.name === n)!.defaultOn).toBe(false);
    }
  });

  it('execute 经 callOp 透传 op 与 args', async () => {
    const callOp = vi.fn(async () => ({ ok: 1 }));
    await new ResourceTools(callOp).execute('describe_agent', { agent: 'x' }, ctx);
    expect(callOp).toHaveBeenCalledWith('describeAgent', { agent: 'x' });
  });
});

const ctx = {} as Parameters<ResourceTools['execute']>[2]; // ToolContext 最小占位（本模块不消费 ctx 字段）
