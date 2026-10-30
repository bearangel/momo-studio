// electron/tests/resource/hub/ownership.test.ts
//
// M5.0 §7.5 源头拦截与存量并存扫描回归锁（矩阵 2026-10-30-m5.0-ownership-studio.md §5）：
//   - assertNoLocalSlugConflict / installHubPackage 前置拦截：
//     custom 实体在场无记账 → 拒（HubSlugConflictError 人话）；
//     发布记账（cache_path=''）不豁免——发布者自装被拦；
//     hub 装记账（cache_path 非空）豁免——存量并存更新合法（小票引导清理）；
//     builtin 同 slug 不拦（异源并存是 P2-4 既有语义）；
//     marketplace 装面实体在场 → 拒（防 hub 版整行覆盖 catalog 装面）
//   - scanHubCoexistIssues：hub 装记账 × custom 实体并存清单；owner=本机 →
//     ownedBySelf=true（引导删 hub 副本）；异物 → false；无并存 → 空
//
// DB 隔离沿用 tests/resource/hub-install.test.ts 模式（AP_USER_DATA_DIR 临时目录 +
// runMigrations 真实建表）。目录归属经 __setHubContextResolverForTest 注入 + fetch
// 桩返回目录（getHubCatalogOwnership 走 defaultSource.load() 真实链）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import {
  __setHubContextResolverForTest,
} from '../../../src/main/resource/hub/momo-hub';
import {
  HubSlugConflictError,
  installHubPackage,
} from '../../../src/main/resource/hub-install';
import {
  assertNoLocalSlugConflict,
  hasLocalSlugEntity,
  scanHubCoexistIssues,
} from '../../../src/main/resource/hub/ownership';
import { saveAgentDefinition } from '../../../src/main/agent/crud';
import { registerMcpDefinition } from '../../../src/main/mcp/host-manager';
import { createHubConfigStore } from '../../../src/main/hub/config-store';

const tmpRoot = path.join(os.tmpdir(), `ap-ownership-test-${Date.now()}`);
const fetchSpy = vi.fn();

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** 落一个 custom skill 目录（.sha256 标记——listInstalled custom 判定源） */
function seedCustomSkill(slug: string): string {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: d\n---\n\n正文。\n`);
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
  return dir;
}

function seedAgentDef(slug: string, source: 'custom' | 'marketplace' | 'builtin'): void {
  saveAgentDefinition({
    id: randomUUID(), name: `${slug}-name`, slug, version: '1.0.0', runtime: 'declarative',
    systemPrompt: 'p', defaultTools: [], source, description: 'd', iconEmoji: '',
    defaultMcps: [], defaultSkills: [], workspaceId: null,
    modelProviderId: null, modelName: 'm',
  });
}

/** 直接落 installed_packages `hub:{slug}` 记账行（发布记账 cache_path='' / hub 装 cache 非空） */
function seedHubAccounting(slug: string, itemType: string, cachePath: string): void {
  getDb()
    .prepare(
      `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), `hub:${slug}`, itemType, slug, '1.0.0', cachePath, 'c'.repeat(64));
}

/** 合法目录条目（validateHubCatalog 可过形状；owner 可选） */
function catalogItem(slug: string, ownerNodeId?: string): Record<string, unknown> {
  return {
    slug, type: 'skill', name: slug, version: '1.0.0', author: 'a',
    description: 'd', readme: '# r', tags: [], category: '', iconEmoji: '',
    verificationStatus: 'unverified',
    downloadUrl: `/resources/${slug}/1.0.0/download`,
    checksum: 'a'.repeat(64), sizeBytes: 1, publishedAt: 1, versions: ['1.0.0'],
    ...(ownerNodeId !== undefined ? { ownerNodeId } : {}),
  };
}

/** 注入目录归属上下文：hub 配置行（selfNodeId 判定源）+ 目录 fetch 桩 */
function stubOwnershipCatalog(items: Array<Record<string, unknown>>): void {
  createHubConfigStore(getDb()).write({ hubUrl: 'http://hub.test', nodeName: 'self', nodeId: 'node-self' });
  __setHubContextResolverForTest(async () => ({ hubUrl: 'http://hub.test', deviceToken: 'tok' }));
  fetchSpy.mockImplementation(async () => jsonResponse({ version: '1', revision: 1, updatedAt: '', items }));
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setHubContextResolverForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('hasLocalSlugEntity（自有实体判定原子）', () => {
  it('custom skill / custom agent / custom mcp 在场 → true；不在场 → false', () => {
    seedCustomSkill('own-skill');
    seedAgentDef('own-agent', 'custom');
    registerMcpDefinition({
      id: randomUUID(), name: 'own-mcp', version: '1.0.0', transport: 'stdio',
      command: 'npx', args: [], source: 'custom',
    });
    expect(hasLocalSlugEntity('skill', 'own-skill')).toBe(true);
    expect(hasLocalSlugEntity('agent', 'own-agent')).toBe(true);
    expect(hasLocalSlugEntity('mcp', 'own-mcp')).toBe(true);
    expect(hasLocalSlugEntity('skill', 'ghost')).toBe(false);
  });
});

describe('installHubPackage 源头拦截（M5.0 §7.5）', () => {
  it('custom skill 在场无记账 → HubSlugConflictError 人话拒装（零网络——拦截先于目录拉取）', async () => {
    seedCustomSkill('clash-skill');
    await expect(installHubPackage('skill', 'clash-skill')).rejects.toThrow(
      '本地已有同名自定义资源（skill「clash-skill」）；如需安装请先删除或改名本地版本',
    );
    await expect(installHubPackage('skill', 'clash-skill')).rejects.toBeInstanceOf(HubSlugConflictError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('发布记账（cache_path=\'\'）不豁免——发布者自装同被拦', async () => {
    seedCustomSkill('pub-skill');
    seedHubAccounting('pub-skill', 'skill', '');
    await expect(installHubPackage('skill', 'pub-skill')).rejects.toBeInstanceOf(HubSlugConflictError);
  });

  it('hub 装记账（cache_path 非空）豁免——存量并存更新合法，拦截不误伤', async () => {
    seedCustomSkill('coexist-skill');
    seedHubAccounting('coexist-skill', 'skill', path.join(tmpRoot, 'cache', 'coexist'));
    // 过冲突段后走到目录拉取（未接入 resolver → 「未找到条目」类错误，非冲突错）
    await expect(installHubPackage('skill', 'coexist-skill')).rejects.not.toBeInstanceOf(HubSlugConflictError);
  });

  it('builtin agent 同 slug 不拦——异源并存是 P2-4 既有语义', async () => {
    seedAgentDef('bi-agent', 'builtin');
    await expect(installHubPackage('agent', 'bi-agent')).rejects.not.toBeInstanceOf(HubSlugConflictError);
  });

  it('marketplace 装面 skill（skill_definitions 行）在场无记账 → 拒（防 hub 版整行覆盖 catalog 装面）', async () => {
    getDb()
      .prepare(
        `INSERT INTO skill_definitions (id, name, slug, version, description, allowed_tools, cache_path, tags)
         VALUES (?, ?, ?, ?, ?, '[]', ?, '[]')`,
      )
      .run(randomUUID(), 'mkt 名', 'mkt-skill', '1.0.0', 'd', path.join(tmpRoot, 'cache', 'mkt'));
    await expect(installHubPackage('skill', 'mkt-skill')).rejects.toBeInstanceOf(HubSlugConflictError);
  });
});

describe('scanHubCoexistIssues（存量并存小票）', () => {
  it('hub 装记账 × custom 实体并存：owner=本机 → ownedBySelf=true；异物 → false', async () => {
    seedCustomSkill('mine-skill');
    seedCustomSkill('alien-skill');
    seedCustomSkill('clean-skill'); // 无 hub 装记账——不出清单
    seedHubAccounting('mine-skill', 'skill', path.join(tmpRoot, 'cache', 'mine'));
    seedHubAccounting('alien-skill', 'skill', path.join(tmpRoot, 'cache', 'alien'));
    stubOwnershipCatalog([
      catalogItem('mine-skill', 'node-self'),
      catalogItem('alien-skill', 'node-other'),
    ]);

    const issues = await scanHubCoexistIssues();
    expect(issues).toHaveLength(2);
    const mine = issues.find((i) => i.slug === 'mine-skill');
    const alien = issues.find((i) => i.slug === 'alien-skill');
    expect(mine?.ownedBySelf).toBe(true);
    expect(mine?.hubVersion).toBe('1.0.0');
    expect(alien?.ownedBySelf).toBe(false);
  });

  it('发布记账行（cache_path=\'\'）不算 hub 副本——纯发布态不出清单', async () => {
    seedCustomSkill('onlypub-skill');
    seedHubAccounting('onlypub-skill', 'skill', '');
    stubOwnershipCatalog([catalogItem('onlypub-skill', 'node-self')]);

    expect(await scanHubCoexistIssues()).toEqual([]);
  });

  it('无 custom 实体的 hub 装记账（纯消费者）不出清单', async () => {
    seedHubAccounting('consumer-skill', 'skill', path.join(tmpRoot, 'cache', 'consumer'));
    stubOwnershipCatalog([catalogItem('consumer-skill', 'node-other')]);

    expect(await scanHubCoexistIssues()).toEqual([]);
  });

  it('assertNoLocalSlugConflict 直面：同判定原子与 installHubPackage 前置一致', () => {
    seedCustomSkill('direct-skill');
    expect(() => assertNoLocalSlugConflict('skill', 'direct-skill')).toThrow(HubSlugConflictError);
    expect(() => assertNoLocalSlugConflict('skill', 'absent-skill')).not.toThrow();
  });
});
