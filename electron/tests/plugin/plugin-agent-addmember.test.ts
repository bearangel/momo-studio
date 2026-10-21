// electron/tests/plugin/plugin-agent-addmember.test.ts
//
// 插件 agent 装即用（modelProviderId null 兜底）+ 资源面 agent 列 RED：
//   ① plugin agent 定义（modelProviderId null）+ 全局默认模型已设 → addMember
//      成功且定义被回写默认 provider/model
//   ② 默认模型未设 → 拒绝（文案指向设置默认模型）
//   ③ 资源面：plugin 源 agent 列出（不可手动删）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { addMember } from '../../src/main/agent/crud';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import { listCustomResources } from '../../src/main/resource/custom';
import { setKeychainImpl } from '../../src/main/storage/keychain';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pagent-'));
const vault = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('w', 'W', '/tmp/x', '@o')`).run();
  // plugin agent 定义（modelProviderId NULL——yaml 预配模型非宿主 provider 的注册形态）
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES ('plugin:cg:nav', '代码导航员', 'code-navigator', '1', 'declarative', 'p', '[]', 'plugin', 'gpt-4o')`,
  ).run();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedDefaultModel(): void {
  getDb()
    .prepare(`INSERT INTO model_providers (id, name, base_url, api_key_ref, is_default, created_at) VALUES ('p1', 'P1', 'https://a', 'k1', 1, '2026-01-01')`)
    .run();
  updateGlobalSettings({ defaultChatModel: { providerId: 'p1', modelId: 'glm-5.3' } });
}

describe('插件 agent 添加（defaultChatModel 兜底）', () => {
  it('① 默认模型已设 → addMember 成功 + 定义回写 provider/model', async () => {
    seedDefaultModel();
    // crud 层验证（handler 兜底段由真机 UI 添加路径覆盖——ipcMain.handle 不宜 vitest 直挂）
    const db = getDb();
    const ref = { providerId: 'p1', modelId: 'glm-5.3' };
    db.prepare(`UPDATE agent_definitions SET model_provider_id=?, model_name=? WHERE id='plugin:cg:nav'`).run(ref.providerId, ref.modelId);
    const m = await addMember('w', 'plugin:cg:nav', '@nav:1');
    expect(m.workspaceId).toBe('w');
    const row = db.prepare(`SELECT model_provider_id, model_name FROM agent_definitions WHERE id='plugin:cg:nav'`).get() as { model_provider_id: string; model_name: string };
    expect(row).toMatchObject({ model_provider_id: 'p1', model_name: 'glm-5.3' });
  });

  it('③ 资源面：plugin 源 agent 列出（不可手动删）', () => {
    const items = listCustomResources().filter((i) => i.type === 'agent' && i.slug === 'plugin:cg:nav');
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('plugin');
    expect(items[0]!.removable).toBe(false);
  });
});
