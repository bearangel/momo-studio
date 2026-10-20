// electron/tests/plugin/codegraph-engine-harness.test.ts
//
// 引擎整合 T8 真引擎版（spec §8 L2 锚点）——双 ws 双语言：
// ws-a（TS 样例）/ ws-b（Java 样例）各自经 getOrStartMcp 拉起真 codegraph
// 引擎实例，断言各自命中各自语言的符号。**Java 命中是 dap-e_server 惨案的
// 回归锁**（自研 indexer 只认 JS/TS 致 6446 个 .java 全部未索引）。
// skipIf：本机无引擎（CI 不拉 280MB——CI 版行为验证见 codegraph-e2e.test.ts）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { getOrStartMcp, stopAllMcpForWorkspace } from '../../src/main/mcp/host-manager';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import type { McpServerConfig } from '../../src/main/mcp/types';
import type { PluginRecord } from '../../src/main/plugin/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENGINE_BIN = path.join(REPO_ROOT, 'plugins', 'codegraph', 'engine', 'bin', 'codegraph');
const ENGINE_READY = fs.existsSync(ENGINE_BIN);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgharness-'));
const vault = new Map<string, string>();

function wsDir(name: string): string {
  return path.join(tmpRoot, name);
}

function seedWs(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wsDir(name), rel)), { recursive: true });
    fs.writeFileSync(path.join(wsDir(name), rel), content);
  }
}

// Java 样例：dap-e_server 同款形态（InitGuideApplicationServiceImpl + 调用方）
const JAVA_FILES = {
  'src/main/java/com/x/InitGuideApplicationServiceImpl.java': `package com.x;

public class InitGuideApplicationServiceImpl {
    public String getOverview(boolean refresh) {
        return "overview:" + refresh;
    }

    public String getStatus() {
        return getOverview(false);
    }
}
`,
  'src/main/java/com/x/InitGuideController.java': `package com.x;

public class InitGuideController {
    private final InitGuideApplicationServiceImpl initGuideApplicationService = new InitGuideApplicationServiceImpl();

    public String overview() {
        return initGuideApplicationService.getOverview(true);
    }
}
`,
};

const TS_FILES = {
  'src/tasks.ts': `export function transitionTaskStatus(id: string, next: string): string {
  return id + ':' + next;
}
`,
  'src/flow.ts': `import { transitionTaskStatus } from './tasks';

export function completeTask(id: string): string {
  return transitionTaskStatus(id, 'done');
}
`,
};

const MANIFEST = {
  id: 'cg',
  name: 'cg',
  version: '2.0.0',
  components: { mcp: './mcp/mcp.json' },
};

function mcpConfigFor(wsId: string, root: string): McpServerConfig {
  return {
    id: 'plugin-cg-codegraph',
    name: 'codegraph',
    version: '0.0.0',
    command: 'node',
    args: [
      '${pluginRoot}/bin/boot.js',
      '--engine', '${engineBin}',
      '--root', '${config.workspaceRoot}',
    ],
    env: { CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_DIR: '.momo-codegraph' },
    transport: 'stdio',
    source: 'plugin',
    pluginId: 'cg',
    ...(wsId === '' ? {} : {}),
    ...(root === '' ? {} : {}),
  };
}

function seedPlugin(): PluginRecord {
  // dev 插件记录（resolvePluginRoot 走真插件目录——引擎/manifest 与仓库一致）
  const root = path.join(REPO_ROOT, 'plugins', 'codegraph');
  const rec: PluginRecord = {
    id: 'cg',
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

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
  runMigrations();
});
afterEach(() => {
  stopAllMcpForWorkspace('ws-a');
  stopAllMcpForWorkspace('ws-b');
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe.skipIf(!ENGINE_READY)('真引擎双 ws 双语言 harness（L2 锚点）', () => {
  it('TS 工作空间命中 TS 符号；Java 工作空间命中 Java 符号（惨案回归锁）', async () => {
    seedWs('ws-a', TS_FILES);
    seedWs('ws-b', JAVA_FILES);
    seedPlugin();
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id)
         VALUES ('ws-a', 'A', ?, '@o'), ('ws-b', 'B', ?, '@o')`,
      )
      .run(wsDir('ws-a'), wsDir('ws-b'));

    const a = await getOrStartMcp('ws-a', mcpConfigFor('ws-a', wsDir('ws-a')));
    const b = await getOrStartMcp('ws-b', mcpConfigFor('ws-b', wsDir('ws-b')));

    // 引擎首启建图需要时间——轮询 explore 直到命中或超时（大仓真实语义）
    const exploreUntil = async (client: typeof a, symbol: string, ms: number): Promise<string> => {
      const deadline = Date.now() + ms;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const r = await client.callTool('codegraph_explore', { query: symbol });
          last = JSON.stringify(r);
          if (!/未收录|not found|no match/i.test(last)) return last;
        } catch (err) {
          last = String(err);
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
      return last;
    };

    const tsHit = await exploreUntil(a, 'transitionTaskStatus', 90_000);
    expect(tsHit).toContain('tasks.ts');
    expect(tsHit).not.toContain('InitGuide');

    const javaHit = await exploreUntil(b, 'InitGuideApplicationServiceImpl', 90_000);
    expect(javaHit).toContain('InitGuideApplicationServiceImpl.java');
    expect(javaHit).not.toContain('tasks.ts');

    // 索引数据落点：各自项目根下 .momo-codegraph/（与 CODEGRAPH_DIR 一致）
    expect(fs.existsSync(path.join(wsDir('ws-a'), '.momo-codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir('ws-b'), '.momo-codegraph'))).toBe(true);
  }, 240_000);
});
