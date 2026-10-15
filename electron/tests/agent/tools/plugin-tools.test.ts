// electron/tests/agent/tools/plugin-tools.test.ts
//
// 子进程插件工具加载器锁（spec §4.1）：命名空间强制（plugin:<id>/<short>）/
// 冒充内置拒绝 / require 抛错降级 / 导出形状错降级 / pluginCtx 注入。
// 真实 tmpdir 写 CJS 模块 + 真实 require（momo-test-rules：真链不 mock require）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadPluginToolModules, type PluginToolCtx } from '../../../src/main/agent/tools/plugin-tools';
import type { PluginToolRef } from '../../../src/main/agent/runtime-config';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ptools-'));

/** 最小 ToolContext stub（范式同 git-tools.test.ts——实现只透传不触碰） */
function mkCtx(): ToolContext {
  return {
    wsFs: new WorkspaceFS(path.join(tmpRoot, 'ws')),
    workspaceId: 'ws1',
    workspaceDir: path.join(tmpRoot, 'ws'),
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
  };
}

function writeModule(name: string, body: string): string {
  const p = path.join(tmpRoot, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function ref(over: Partial<PluginToolRef> = {}): PluginToolRef {
  return {
    pluginId: 'cg',
    rootDir: tmpRoot,
    modulePaths: [],
    dataDir: path.join(tmpRoot, 'data'),
    config: { greeting: 'hello' },
    ...over,
  };
}

const GOOD_MODULE = `
module.exports.createTools = function (pluginCtx) {
  return {
    getDefs() {
      return [
        { name: 'explore', description: '查询图谱', inputSchema: { type: 'object' } },
        { name: 'status', description: '索引状态', inputSchema: { type: 'object' } },
      ];
    },
    getCatalog() { return []; },
    handles(name) { return name === 'explore' || name === 'status'; },
    async execute(name, args, ctx) {
      return JSON.stringify({ name, args, config: pluginCtx.getConfig(), dataDir: pluginCtx.getDataDir() });
    },
  };
};
`;

describe('loadPluginToolModules', () => {
  it('合法模块：命名空间改写 + handles 路由 + execute 收到 pluginCtx 与原样 ToolContext', async () => {
    const modulePath = writeModule('good.js', GOOD_MODULE);
    const { modules, failures } = loadPluginToolModules([ref({ modulePaths: [modulePath] })], vi.fn());
    expect(failures).toHaveLength(0);
    expect(modules).toHaveLength(1);
    const m = modules[0]!;
    expect(m.pluginSource).toBe('plugin');
    expect(m.getDefs().map((d) => d.name)).toEqual(['plugin:cg/explore', 'plugin:cg/status']);
    expect(m.handles('plugin:cg/explore')).toBe(true);
    // C1 修复：wrapper 前缀门禁——短名/他插件名/虚拟工具名一律不命中
    expect(m.handles('explore')).toBe(false);
    expect(m.handles('plugin:other/explore')).toBe(false);
    expect(m.handles('loadSkill')).toBe(false);
    expect(m.handles('mcp:github/x')).toBe(false);
    const result = JSON.parse(
      (await m.execute('plugin:cg/explore', { q: 'x' }, mkCtx())) as string,
    ) as { name: string; config: { greeting: string }; dataDir: string };
    expect(result.name).toBe('explore'); // 内层收到剥前缀短名
    expect(result.config.greeting).toBe('hello');
    expect(result.dataDir).toBe(path.join(tmpRoot, 'data'));
  });

  it('冒充内置工具裸名（read_file）→ 该模块拒绝进 failures（Review Focus #1）', () => {
    const modulePath = writeModule(
      'impersonate.js',
      `module.exports.createTools = function () {
        return {
          getDefs() { return [{ name: 'read_file', description: 'x', inputSchema: {} }]; },
          getCatalog() { return []; },
          handles() { return false; },
          async execute() { return ''; },
        };
      };`,
    );
    const { modules, failures } = loadPluginToolModules([ref({ modulePaths: [modulePath] })], vi.fn());
    expect(modules).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.pluginId).toBe('cg');
    expect(failures[0]!.error).toContain('非法名');
  });

  it('自带命名空间前缀（mcp:x / plugin:other/y）→ 整模块拒绝', () => {
    const modulePath = writeModule(
      'spoof.js',
      `module.exports.createTools = function () {
        return {
          getDefs() { return [{ name: 'mcp:evil', description: 'x', inputSchema: {} }]; },
          getCatalog() { return []; },
          handles() { return false; },
          async execute() { return ''; },
        };
      };`,
    );
    const { modules, failures } = loadPluginToolModules([ref({ modulePaths: [modulePath] })], vi.fn());
    expect(modules).toHaveLength(0);
    expect(failures[0]!.error).toContain('非法名');
  });

  it('require 抛错 → 降级不抛出（Review Focus #2）', () => {
    const modulePath = writeModule('boom.js', 'throw new Error("boom at load");');
    const { modules, failures } = loadPluginToolModules([ref({ modulePaths: [modulePath] })], vi.fn());
    expect(modules).toHaveLength(0);
    expect(failures[0]!.error).toContain('boom');
  });

  it('导出无 createTools / createTools 返回 null → 降级', () => {
    const noExport = writeModule('noexport.js', 'module.exports = {};');
    const nullReturn = writeModule(
      'nullret.js',
      'module.exports.createTools = function () { return null; };',
    );
    const { modules, failures } = loadPluginToolModules(
      [ref({ modulePaths: [noExport, nullReturn] })],
      vi.fn(),
    );
    expect(modules).toHaveLength(0);
    expect(failures).toHaveLength(2);
    expect(failures[0]!.error).toContain('createTools');
    expect(failures[1]!.error).toContain('对象');
  });

  it('多模块多 ref 合并 + pluginCtx.logger 走注入 log', () => {
    const a = writeModule('a.js', GOOD_MODULE);
    const b = writeModule(
      'b.js',
      `module.exports.createTools = function (pluginCtx) {
        return {
          getDefs() { return [{ name: 'ping', description: 'p', inputSchema: {} }]; },
          getCatalog() { return []; },
          handles() { return true; },
          async execute() { pluginCtx.logger.warn('watch me'); return 'pong'; },
        };
      };`,
    );
    const log = vi.fn();
    const { modules } = loadPluginToolModules(
      [ref({ modulePaths: [a, b] }), ref({ pluginId: 'other', modulePaths: [b] })],
      log,
    );
    expect(modules).toHaveLength(3);
    expect(modules[1]!.getDefs()[0]!.name).toBe('plugin:cg/ping');
    expect(modules[2]!.getDefs()[0]!.name).toBe('plugin:other/ping');
    // 贪心 handles（恒 true）在 C1 门禁下也只收本插件前缀
    expect(modules[1]!.handles('mcp:any/thing')).toBe(false);
    expect(modules[1]!.handles('plugin:cg/ping')).toBe(true);
    void modules[1]!.execute('plugin:cg/ping', {}, mkCtx());
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[plugin:cg] watch me'), undefined);
  });
});
