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
