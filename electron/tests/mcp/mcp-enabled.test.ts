// electron/tests/mcp/mcp-enabled.test.ts
//
// 组⑤（走查 D13）：MCP 启停断面测试——「定义保留、运行时切断」三防线中的
// 可单测断面（spawn 过滤 + getOrStartMcp 拒绝 + 开关读写 + 服务编排）。
//   - 注册默认 enabled=1（migration 053 DEFAULT；重装 INSERT OR REPLACE 回默认）
//   - setMcpEnabledDefinition：true/false 往返 + 未注册中文错
//   - getOrStartMcp：enabled=false 拒绝（守卫先于 spawn——不产生真实进程）
//   - callMcpTool 池 miss 路径：禁用条目拒绝（正在跑的 agent 也调不动）
//   - 资源层 setMcpEnabled：未注册中文错；getMcpEditView 透出 enabled
//   - spawn 过滤 filterEnabledMcps：已注册且禁用的剔除；未注册与启用的保留
//
// DB 隔离沿用 host-manager-edit.test.ts 既定模式（AP_USER_DATA_DIR 临时目录 +
// 真实 runMigrations + closeDb 复位单例）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import {
  registerMcpDefinition,
  getMcpConfig,
  listRegistered,
  getOrStartMcp,
  callMcpTool,
  setMcpEnabledDefinition,
} from '../../src/main/mcp/host-manager';
import { setMcpEnabled, getMcpEditView } from '../../src/main/resource/mcp-config';
import { filterEnabledMcps } from '../../src/main/agent/spawn-helpers';
import type { McpServerConfig } from '../../src/main/mcp/types';

/** 最小可注册 stdio 配置（command 指向不存在的路径——本文件所有断言都在 spawn 之前短路） */
function mkConfig(name: string): McpServerConfig {
  return { id: `id-${name}`, name, version: '1.0.0', command: '/nonexistent/noop', args: [], source: 'custom' };
}

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enabled-test-'));
  process.env.AP_USER_DATA_DIR = dataDir;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('host-manager 启停读写', () => {
  it('注册默认 enabled=true（migration 053 DEFAULT 1）；listRegistered 同步透出', () => {
    registerMcpDefinition(mkConfig('alpha'));
    expect(getMcpConfig('alpha')?.enabled).toBe(true);
    const listed = listRegistered().find((m) => m.name === 'alpha');
    expect(listed?.enabled).toBe(true);
  });

  it('setMcpEnabledDefinition true/false 往返', () => {
    registerMcpDefinition(mkConfig('alpha'));
    setMcpEnabledDefinition('alpha', false);
    expect(getMcpConfig('alpha')?.enabled).toBe(false);
    setMcpEnabledDefinition('alpha', true);
    expect(getMcpConfig('alpha')?.enabled).toBe(true);
  });

  it('setMcpEnabledDefinition 未注册 → 中文错', () => {
    expect(() => setMcpEnabledDefinition('ghost', false)).toThrow('MCP ghost 未注册');
  });

  it('重装（INSERT OR REPLACE）enabled 回默认 1——覆盖安装即新装语义', () => {
    registerMcpDefinition(mkConfig('alpha'));
    setMcpEnabledDefinition('alpha', false);
    registerMcpDefinition(mkConfig('alpha'));
    expect(getMcpConfig('alpha')?.enabled).toBe(true);
  });
});

describe('运行时切断', () => {
  it('getOrStartMcp 对 enabled=false 拒绝（守卫先于 spawn，不产生进程）', async () => {
    registerMcpDefinition(mkConfig('alpha'));
    setMcpEnabledDefinition('alpha', false);
    const config = getMcpConfig('alpha');
    expect(config).not.toBeNull();
    await expect(getOrStartMcp('ws-1', config!)).rejects.toThrow('MCP alpha 已禁用');
  });

  it('callMcpTool 池 miss 路径：禁用条目拒绝（运行中的 agent 也调不动）', async () => {
    registerMcpDefinition(mkConfig('beta'));
    setMcpEnabledDefinition('beta', false);
    await expect(callMcpTool('ws-1', 'beta', 'any_tool', {})).rejects.toThrow('MCP beta 已禁用');
  });
});

describe('资源层服务 setMcpEnabled（组⑤编排）', () => {
  it('禁用 → 定义保留（仍可 getMcpConfig）+ enabled=false', async () => {
    registerMcpDefinition(mkConfig('alpha'));
    await setMcpEnabled('alpha', false);
    const def = getMcpConfig('alpha');
    expect(def).not.toBeNull();
    expect(def?.enabled).toBe(false);
  });

  it('未注册 → 中文错（透传 renderer）', async () => {
    await expect(setMcpEnabled('ghost', true)).rejects.toThrow('MCP ghost 未注册');
  });

  it('getMcpEditView 透出 enabled（编辑弹窗据此跳过 mcp.start 预热）', async () => {
    registerMcpDefinition(mkConfig('alpha'));
    expect(getMcpEditView('alpha').enabled).toBe(true);
    await setMcpEnabled('alpha', false);
    expect(getMcpEditView('alpha').enabled).toBe(false);
  });
});

describe('spawn 过滤 filterEnabledMcps（组⑤第一防线）', () => {
  it('已注册且禁用的剔除；启用与未注册的保留（悬空语义归 dangling 扫描）', () => {
    registerMcpDefinition(mkConfig('on'));
    registerMcpDefinition(mkConfig('off'));
    setMcpEnabledDefinition('off', false);
    const filtered = filterEnabledMcps(['on', 'off', 'unregistered-ghost']);
    expect(filtered).toEqual(['on', 'unregistered-ghost']);
  });

  it('空输入返回空数组', () => {
    expect(filterEnabledMcps([])).toEqual([]);
  });
});
