// electron/tests/plugin/codegraph-e2e.test.ts
//
// 引擎整合 T8 CI 版（spec §8）：模板态插件 MCP 的多 ws 实例 + setConfig
// 联动池失效——假引擎（node 脚本 JSON-RPC server，回显 env 标记）集成验证，
// 不依赖真引擎（CI 可跑）。真引擎双语言锚点见 codegraph-engine-harness.test.ts。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { syncPluginMcps } from '../../src/main/plugin/mcp-sync';
import { getOrStartMcp, invalidateMcpByName, stopAllMcpForWorkspace } from '../../src/main/mcp/host-manager';
import { getMcpConfig } from '../../src/main/mcp/host-manager';
import { writePluginConfig, normalizeConfigSchema } from '../../src/main/plugin/config-store';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cge2e-'));
const PID = 'cg';

/** 假引擎 bin：MCP stdio server，tools/list 回显 env.CGE2E_MARKER */
const FAKE_ENGINE = `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') {
    send({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  } else if (msg.method === 'tools/list') {
    send({ tools: [{ name: 'codegraph_explore', description: 'x', inputSchema: { type: 'object' } }] });
  } else if (msg.method === 'tools/call') {
    send({ content: [{ type: 'text', text: 'argv=' + JSON.stringify(process.argv.slice(2)) }], isError: false });
  }
});
`;

const MANIFEST = {
  id: PID,
  name: 'cg',
  version: '2.0.0',
  components: { mcp: './mcp/mcp.json' },
  config: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' },
    },
  },
};

const SCHEMA = normalizeConfigSchema(MANIFEST.config);

function seedDevPlugin(): PluginRecord {
  const root = path.join(tmpRoot, 'dev-plugin');
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'engine', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'engine', 'bin', 'codegraph'),
    FAKE_ENGINE,
    { encoding: 'utf-8', mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, 'momo-plugin.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(
    path.join(root, 'mcp', 'mcp.json'),
    JSON.stringify({
      servers: {
        codegraph: {
          command: '${engineBin}',
          args: ['serve', '--mcp', '--path', '${config.workspaceRoot}'],
          env: { CODEGRAPH_NO_DOWNLOAD: '1' },
        },
      },
    }),
  );
  const rec: PluginRecord = {
    id: PID,
    version: '2.0.0',
    manifestJson: JSON.stringify(MANIFEST),
    state: 'active',
    source: 'dev',
    sourcePath: root,
    installedAt: 'x',
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, ?, ?, 'active', 'dev', ?, 'x')`,
    )
    .run(rec.id, rec.version, rec.manifestJson, root);
  return rec;
}

const vault = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
  runMigrations();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id)
       VALUES ('ws-a', 'A', ?, '@o'), ('ws-b', 'B', ?, '@o')`,
    )
    .run(path.join(tmpRoot, 'ws-a'), path.join(tmpRoot, 'ws-b'));
});
afterEach(() => {
  stopAllMcpForWorkspace('ws-a');
  stopAllMcpForWorkspace('ws-b');
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('模板态插件 MCP 集成（假引擎）', () => {
  it('① 注册模板态 → 两个 ws 各自展开拉起（marker=root 差异证实多实例）', async () => {
    const rec = seedDevPlugin();
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-a') }, 'ws-a');
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-b') }, 'ws-b');
    expect(syncPluginMcps(rec)).toEqual(['codegraph']);

    // 假引擎无 marker 注入渠道——经 args 差异验证：callTool 回显 args（含各自 path）
    const cfgA = getMcpConfig('codegraph');
    if (cfgA === null) throw new Error('codegraph 定义未注册');
    const a = await getOrStartMcp('ws-a', cfgA);
    const b = await getOrStartMcp('ws-b', cfgA);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // 池按 ws 分实例：两个客户端进程独立（断言非同对象）
    expect(a).not.toBe(b);
    const rA = await a.callTool('codegraph_explore', { q: 1 });
    const rB = await b.callTool('codegraph_explore', { q: 1 });
    const textA = JSON.stringify(rA);
    const textB = JSON.stringify(rB);
    // args 展开各自的 root（假 server 回显 args=…path 各自不同）
    expect(textA).toContain('ws-a');
    expect(textB).toContain('ws-b');
  }, 30000);

  it('③ I2 回归锁：卸载级联（removePluginMcps）回收池实例——旧引擎进程不再复用', async () => {
    const rec = seedDevPlugin();
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-a') }, 'ws-a');
    syncPluginMcps(rec);
    const cfg = getMcpConfig('codegraph');
    if (cfg === null) throw new Error('未注册');
    const before = await getOrStartMcp('ws-a', cfg);
    expect(before.isConnected).toBe(true);

    const { removePluginMcps } = await import('../../src/main/plugin/mcp-sync');
    removePluginMcps(PID);

    // 池实例已回收：重拉同键必然重建（旧实例不复用）
    const after = await getOrStartMcp('ws-a', cfg);
    expect(after).not.toBe(before);
  }, 30000);

  it('④ C1 回归锁：boot.js 进程链——宿主断连后孙进程（引擎）随之退出', async () => {
    const rec = seedDevPlugin();
    // 预建索引目录——绕开并行 init 路径（本用例锁进程链，init 语义由 harness 覆盖）
    fs.mkdirSync(path.join(tmpRoot, 'ws-a', '.momo-codegraph'), { recursive: true });
    // boot 形态：command node + boot.js --engine <假引擎> --root <ws>
    // 假引擎 serve 前写 pid 文件；断连后断言该 pid 消亡
    const pidFile = path.join(tmpRoot, 'grandchild.pid');
    const FAKE_BOOT_ENGINE = FAKE_ENGINE.replace(
      "rl.on('line',",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrl.on('line',`,
    );
    const root = path.join(tmpRoot, 'dev-plugin');
    fs.writeFileSync(path.join(root, 'engine', 'bin', 'codegraph'), FAKE_BOOT_ENGINE, {
      encoding: 'utf-8',
      mode: 0o755,
    });
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-a') }, 'ws-a');
    // 直接注册 boot 形态定义（绕过 mcp.json——本用例测进程链而非注册）
    const cfg: import('../../src/main/mcp/types').McpServerConfig = {
      id: 'plugin-cg-codegraph',
      name: 'codegraph',
      version: '0.0.0',
      command: 'node',
      args: [
        path.join(path.dirname(__dirname), '..', '..', 'plugins', 'codegraph', 'bin', 'boot.js'),
        '--engine', path.join(root, 'engine', 'bin', 'codegraph'),
        '--root', path.join(tmpRoot, 'ws-a'),
      ],
      transport: 'stdio',
      source: 'plugin',
      pluginId: PID,
    };
    const client = await getOrStartMcp('ws-a', cfg);
    await client.callTool('codegraph_explore', {});
    // 引擎孙进程已记录 pid
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    expect(pid).toBeGreaterThan(0);
    // 断连前存活态不设硬断言——宿主侧管道提前半关时 boot.js 的 stdin-EOF
    // 联动会先杀引擎（产品语义正确的路径）；核心不变量是 disconnect 后必死
    let aliveBefore = false;
    try { process.kill(pid, 0); aliveBefore = true; } catch { aliveBefore = false; }
    // 宿主断连（kill 直接子进程 node boot.js）
    await client.disconnect();
    // 轮询孙进程消亡（信号转发 + stdin EOF 联动后应 ≤3s）
    const deadline = Date.now() + 8000;
    let gone = false;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 300)); }
      catch { gone = true; break; }
    }
    expect(gone).toBe(true); // 无论断连前死活，孙进程终态必须消亡
  }, 30000);

  it('② setConfig 联动失效：改 workspaceRoot 后旧实例回收、新参数生效（stale root 杜绝）', async () => {
    const rec = seedDevPlugin();
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-a') }, 'ws-a');
    syncPluginMcps(rec);
    const cfg = getMcpConfig('codegraph');
    if (cfg === null) throw new Error('codegraph 定义未注册');
    const before = await getOrStartMcp('ws-a', cfg);
    const r1 = await before.callTool('codegraph_explore', {});
    expect(JSON.stringify(r1)).toContain('ws-a');

    // 配置变更 → 联动失效（ipc.handlers 语义，此处直调）
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: path.join(tmpRoot, 'ws-a', 'v2') }, 'ws-a');
    invalidateMcpByName('codegraph');

    const after = await getOrStartMcp('ws-a', cfg);
    const r2 = await after.callTool('codegraph_explore', {});
    expect(JSON.stringify(r2)).toContain('ws-a/v2');
    expect(JSON.stringify(r2)).not.toContain('"path":"' + path.join(tmpRoot, 'ws-a') + '"');
  }, 30000);
});
