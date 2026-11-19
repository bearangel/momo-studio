// electron/tests/agent/runtime-plugin-integration.test.ts
//
// runtime 工具注册中心集成锁（spec §4.3）：assembleToolModules = 内置在前、
// 插件在后并入；loader failures 携带不进 modules；无 pluginTools 时纯内置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assembleToolModules } from '../../src/main/agent/tools/plugin-tools';
import type { ToolModule } from '../../src/main/agent/tools/types';
import type { PluginToolRef } from '../../src/main/agent/runtime-config';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pint-'));

function fakeBuiltin(names: string[]): ToolModule {
  return {
    getDefs: () => names.map((n) => ({ name: n, description: 'b', inputSchema: {} })),
    getCatalog: () => [],
    handles: (n) => names.includes(n),
    execute: async () => 'ok',
  };
}

function writePlugin(name: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(
    p,
    `module.exports.createTools = function () {
      return {
        getDefs() { return [{ name: 'echo', description: 'e', inputSchema: {} }]; },
        getCatalog() { return []; },
        handles(n) { return n === 'echo'; },
        async execute() { return 'echo!'; },
      };
    };`,
  );
  return p;
}

const ref = (modulePaths: string[]): PluginToolRef => ({
  pluginId: 'cg',
  rootDir: tmpRoot,
  modulePaths,
  dataDir: path.join(tmpRoot, 'data'),
  config: {},
});

describe('assembleToolModules', () => {
  it('无 pluginTools → 仅内置；有 → 内置在前插件在后', () => {
    const base = [fakeBuiltin(['read_file'])];
    const only = assembleToolModules(base, [], vi.fn());
    expect(only.modules).toHaveLength(1);
    expect(only.failures).toHaveLength(0);

    const withPlugin = assembleToolModules(base, [ref([writePlugin('a.js')])], vi.fn());
    expect(withPlugin.modules).toHaveLength(2);
    expect(withPlugin.modules[1]!.handles('plugin:cg/echo')).toBe(true);
    expect(withPlugin.modules[0]!.handles('read_file')).toBe(true); // 内置次序不变
  });

  it('loader failures 携带返回、不进 modules（启动日志可观测面）', () => {
    const bad = path.join(tmpRoot, 'bad.js');
    fs.writeFileSync(bad, 'throw new Error("kaboom");');
    const res = assembleToolModules([fakeBuiltin(['git_status'])], [ref([bad])], vi.fn());
    expect(res.modules).toHaveLength(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.error).toContain('kaboom');
  });
});

// 2026-11-19 粒度收口：spawn 侧按工具名匹配决定模块准入后，单文件多工具模块
// 会整体进子进程——未授权工具若仍暴露 defs/handles，等于「授权 query 可执行
// write」。loader 按 grantedPluginTools 逐工具过滤 defs 并收口 handles。
describe('assembleToolModules grantedPluginTools 逐工具过滤（2026-11-19）', () => {
  /** 双工具模块：echo + echo2（单文件多工具形态） */
  function writeMultiPlugin(name: string): string {
    const p = path.join(tmpRoot, name);
    fs.writeFileSync(
      p,
      `module.exports.createTools = function () {
        return {
          getDefs() {
            return [
              { name: 'echo', description: 'e', inputSchema: {} },
              { name: 'echo2', description: 'e2', inputSchema: {} },
            ];
          },
          getCatalog() { return []; },
          handles(n) { return n === 'echo' || n === 'echo2'; },
          async execute() { return 'echo!'; },
        };
      };`,
    );
    return p;
  }

  it('精确授权 → defs 只剩已授权工具；handles 拒未授权名（防粒度放大执行）', () => {
    const res = assembleToolModules(
      [fakeBuiltin(['read_file'])],
      [ref([writeMultiPlugin('multi.js')])],
      vi.fn(),
      { grantedPluginTools: ['plugin:cg/echo'] },
    );
    const mod = res.modules[1]!;
    expect(mod.getDefs().map((d) => d.name)).toEqual(['plugin:cg/echo']);
    expect(mod.handles('plugin:cg/echo')).toBe(true);
    // 幻觉调用未授权名：handles 不放行（assertToolAllowed 对 plugin: 豁免白名单，
    // 可见性=装配面——粒度收口必须在 loader 完成）
    expect(mod.handles('plugin:cg/echo2')).toBe(false);
  });

  it('组模式 plugin:cg/* → 全量；未传 opts → 全量（旧 AGENT_CONFIG 兼容）', () => {
    const mp = writeMultiPlugin('group.js');
    const grouped = assembleToolModules([], [ref([mp])], vi.fn(), {
      grantedPluginTools: ['plugin:cg/*'],
    });
    expect(grouped.modules[0]!.getDefs()).toHaveLength(2);

    const legacy = assembleToolModules([], [ref([writeMultiPlugin('legacy.js')])], vi.fn());
    expect(legacy.modules[0]!.getDefs()).toHaveLength(2);
    expect(legacy.modules[0]!.handles('plugin:cg/echo2')).toBe(true);
  });
});
