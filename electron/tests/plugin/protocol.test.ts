// electron/tests/plugin/protocol.test.ts
//
// T1 RED：momo-plugin:// 自定义协议（spec §6.1）——
// 只放行插件安装目录内的静态文件；穿越/跨版本/未知插件/非 GET 全拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_PANEL_SCHEME,
  registerPluginPanelProtocol,
  type ProtocolLike,
} from '../../src/main/plugin/protocol';
import { upsertPlugin } from '../../src/main/plugin/registry';
import { resolvePluginInstalledDir, resolvePluginsDir } from '../../src/main/paths';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pproto-'));
let handler: (request: { url: string; method?: string }) => Response | Promise<Response>;

const stubProtocol: ProtocolLike = {
  handle(_scheme, h) {
    handler = h;
  },
};

function mkRecord(id: string, version: string, source: 'zip' | 'dev', sourcePath: string | null): PluginRecord {
  return {
    id,
    version,
    manifestJson: JSON.stringify({ id, name: id, version, description: '', components: {} }),
    state: 'active',
    source,
    sourcePath,
    installedAt: 'x',
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`)
    .run();
  registerPluginPanelProtocol(stubProtocol);
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function installFixtureFiles(id: string, version: string): void {
  const root = resolvePluginInstalledDir(id, version);
  fs.mkdirSync(path.join(root, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'index.html'), '<html>面板</html>');
  fs.mkdirSync(path.join(root, 'panel', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'assets', 'app.js'), 'console.log(1)');
}

describe('momo-plugin:// 协议', () => {
  it('已装 zip 插件：panel/index.html → 200 text/html', async () => {
    installFixtureFiles('cg', '0.4.0');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel/index.html` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('面板');
  });

  it('嵌套资源 mime 正确（.js → text/javascript）', async () => {
    installFixtureFiles('cg', '0.4.0');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel/assets/app.js` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('路径穿越（..）→ 403', async () => {
    installFixtureFiles('cg', '0.4.0');
    // 兄弟版本目录里的真实文件——只有穿越才能触达
    const sibling = resolvePluginInstalledDir('cg', '0.9.9');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'evil.txt'), 'x');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    const res = await handler({
      url: `${PLUGIN_PANEL_SCHEME}://cg/panel/../..%2F0.9.9/evil.txt`,
    });
    expect(res.status).toBe(403);
  });

  it('数据目录不可达（plugins/data 不在 servable 根内）', async () => {
    installFixtureFiles('cg', '0.4.0');
    fs.mkdirSync(path.join(resolvePluginsDir(), 'data', 'cg'), { recursive: true });
    fs.writeFileSync(path.join(resolvePluginsDir(), 'data', 'cg', 'config.json'), '{"apiToken":"sk-secret"}');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    // URL 构造器会把 `..` 规范化消解——无论如何构造，路径都锚死在安装根内：
    // 真实不变量 = config.json 内容永远不可达（403 拒绝或 404 锚内不存在）
    const res = await handler({
      url: `${PLUGIN_PANEL_SCHEME}://cg/../../data/cg/config.json`,
    });
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('sk-secret');
  });

  it('未知插件 → 404', async () => {
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://ghost/panel/index.html` });
    expect(res.status).toBe(404);
  });

  it('文件不存在 → 404；目录目标 → 404', async () => {
    installFixtureFiles('cg', '0.4.0');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    expect((await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel/nope.html` })).status).toBe(404);
    expect((await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel` })).status).toBe(404);
  });

  it('非 GET → 405', async () => {
    installFixtureFiles('cg', '0.4.0');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel/index.html`, method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('dev 来源插件：从 sourcePath 服务', async () => {
    const devRoot = path.join(tmpRoot, 'dev-plugin');
    fs.mkdirSync(path.join(devRoot, 'panel'), { recursive: true });
    fs.writeFileSync(path.join(devRoot, 'panel', 'index.html'), 'dev panel');
    upsertPlugin(mkRecord('devp', '0.0.1', 'dev', devRoot));
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://devp/panel/index.html` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('dev panel');
  });

  it('missing 态插件 → 404', async () => {
    const rec = mkRecord('gone', '0.1.0', 'zip', null);
    upsertPlugin({ ...rec, state: 'missing' });
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://gone/panel/index.html` });
    expect(res.status).toBe(404);
  });

  it('未知扩展名 → application/octet-stream', async () => {
    installFixtureFiles('cg', '0.4.0');
    fs.writeFileSync(path.join(resolvePluginInstalledDir('cg', '0.4.0'), 'panel', 'data.bin'), 'bin');
    upsertPlugin(mkRecord('cg', '0.4.0', 'zip', null));
    const res = await handler({ url: `${PLUGIN_PANEL_SCHEME}://cg/panel/data.bin` });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
