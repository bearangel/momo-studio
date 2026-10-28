// hub pin 形状锁（M2.3 T2b v0.1.5 / 裁定书 p1-0 §4.2；M3.0-P2 pin bump v0.1.6；
// M3.1 pin bump v0.1.7——协议 1.3.0：task.answer RPC + waiting 态 + 决策列 +
// task.answered 事件；M3.2 pin bump v0.1.8——协议 1.4.0：view.workspaces /
// view.files 两方法 + view.* 可选 groupId + files 限额常量；M3.4 pin bump
// v0.1.9——协议 1.5.0：SnapshotResourceRef.version? / HubCatalog.revision /
// EVT.resourceUnpublished）——锁四件事：
// ① pin 生效：node_modules 实装 momo-hub-protocol 版本 = pin 目标（0.1.9）——
//    防「lockfile-only 更新后未 install」/「pin 漂移」两类事故（构建新鲜度红线）
// ② v0.1.5 语义目录样本（hub 乱序发布产物，形状锚自 hub 仓 resources-latest-semver.test.ts
//    与裁定书 §1 curl 实录）过 validateHubCatalog——生产消费链（momo-hub.ts load）同校验器
// ③ 语义不变式：versions[0] === version（latest = semver max 落位首元素——studio 侧
//    T2 的「缺省装取 latest」消费锚）；非法形状（versions 非数组）仍拒——validate 未放松
// ④ 1.5.0 三面（M3.4 §2.1）：manifest resources[].version? 透传（缺省合法 /
//    在场保留 / 非法拒收）；HubCatalog.revision 容错归一（旧 hub 1.4 不发 → 0；
//    非整数/负数仍拒）；EVT.resourceUnpublished 事件名登记
// 版本 introspection 直读包内 package.json：单入口规则（protocol.ts）约束的是协议符号
// import；此处是 pin 锁定断言，目的不同，不走协议面。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  EVT,
  validateHubCatalog,
  validateSnapshotManifest,
  type HubCatalog,
} from '../../src/main/hub/protocol';

const hubDirRequire = createRequire(`${__dirname}/../../src/main/hub/`);
const pkg = JSON.parse(readFileSync(hubDirRequire.resolve('momo-hub-protocol/package.json'), 'utf8')) as {
  version: string;
};

/** hub v0.1.5 乱序发布实录样本（发布序 1.0.0 → 2.0.0 → 1.5.0）：
 *  latest = versions 全集 semver max（2.0.0），versions semver 降序。
 *  revision（1.5.0 起）= 目录持久化修订号——hub 侧 publish/unpublish 同事务单调 +1。 */
function semverCatalogSample(): HubCatalog {
  return {
    version: '1.2.0',
    revision: 7,
    updatedAt: '2026-10-28T00:00:00.000Z',
    items: [{
      slug: 'p10-skill',
      type: 'skill',
      name: 'P10 Skill',
      version: '2.0.0',
      author: 'p10-probe',
      description: '乱序发布样本',
      readme: '# sample',
      tags: [],
      category: 'dev',
      iconEmoji: '🧩',
      verificationStatus: 'unverified',
      downloadUrl: 'http://127.0.0.1:8790/resources/p10-skill/2.0.0/download',
      checksum: 'a'.repeat(64),
      sizeBytes: 42,
      publishedAt: 1790000000000,
      versions: ['2.0.0', '1.5.0', '1.0.0'],
    }],
  };
}

/** 最小合法 manifest（resources 可覆写——1.5.0 version? 透传锁的载体） */
function manifestSample(resources: unknown): unknown {
  return {
    workspaceName: 'pin-ws',
    version: '20261029.010203.abcd',
    resources,
    config: {
      agentMembers: [],
      teams: [],
      mcpEnabled: [],
      skills: [],
      pluginsEnabled: [],
      providerRefs: [],
      prefs: {},
    },
  };
}

describe('hub pin v0.1.9（M3.4）', () => {
  it('pin 生效：实装 momo-hub-protocol 版本 = 0.1.9（electron/package.json #v0.1.9）', () => {
    expect(pkg.version).toBe('0.1.9');
  });

  it('v0.1.5 语义目录样本过 validateHubCatalog（生产消费链同校验器）', () => {
    const sample = semverCatalogSample();
    expect(validateHubCatalog(sample)).not.toBeNull();
  });

  it('语义不变式：latest = semver max 且 versions 降序——versions[0] === version', () => {
    const sample = semverCatalogSample();
    const validated = validateHubCatalog(sample);
    expect(validated).not.toBeNull();
    const item = validated!.items[0]!;
    // studio 消费锚（T2「缺省装取 latest」）：最新版 = versions 首元素 = version 字段
    expect(item.versions[0]).toBe(item.version);
    expect(item.versions).toEqual(['2.0.0', '1.5.0', '1.0.0']);
    // downloadUrl 版本段与 latest 同源（不指向最近发布的低版本）
    expect(item.downloadUrl).toContain(`/resources/p10-skill/${item.version}/download`);
  });

  it('validate 未放松：versions 非数组 / checksum 非 sha256 仍拒（null）', () => {
    const sample = semverCatalogSample();
    const brokenVersions = structuredClone(sample);
    (brokenVersions.items[0] as unknown as { versions: unknown }).versions = '2.0.0';
    expect(validateHubCatalog(brokenVersions)).toBeNull();
    const brokenChecksum = structuredClone(sample);
    (brokenChecksum.items[0] as { checksum: string }).checksum = 'not-sha256';
    expect(validateHubCatalog(brokenChecksum)).toBeNull();
  });

  describe('1.5.0：SnapshotResourceRef.version? 透传（B13——builder/applier 钉死链的协议面）', () => {
    it('在场且合法 → 校验产物保留 version 字段（未知字段剥除点 resourceRefsFrom 不剥它）', () => {
      const parsed = validateSnapshotManifest(
        manifestSample([{ type: 'skill', slug: 'p10-skill', version: '1.5.0' }]),
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.resources).toEqual([{ type: 'skill', slug: 'p10-skill', version: '1.5.0' }]);
    });

    it('缺省 → 合法且不带 version 键（1.4 旧 manifest 零变化——latest 语义）', () => {
      const parsed = validateSnapshotManifest(
        manifestSample([{ type: 'skill', slug: 'p10-skill' }]),
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.resources).toEqual([{ type: 'skill', slug: 'p10-skill' }]);
      expect('version' in parsed!.resources[0]!).toBe(false);
    });

    it('在场但非法（白名单外字符）→ 整包拒收（version 会拼进下载路径，与顶层 version 同强度）', () => {
      expect(
        validateSnapshotManifest(
          manifestSample([{ type: 'skill', slug: 'p10-skill', version: '1.0.0;rm -rf' }]),
        ),
      ).toBeNull();
    });
  });

  describe('1.5.0：HubCatalog.revision 容错归一（B10——studio 不以 revision 判变，仅透传）', () => {
    it('旧 hub（1.4）不发 revision → 校验通过且归一为 0（字段新增非破坏）', () => {
      const legacy = semverCatalogSample() as unknown as Record<string, unknown>;
      delete legacy.revision;
      const validated = validateHubCatalog(legacy);
      expect(validated).not.toBeNull();
      expect(validated!.revision).toBe(0);
    });

    it('在场且为非负整数 → 原样保留', () => {
      const validated = validateHubCatalog(semverCatalogSample());
      expect(validated!.revision).toBe(7);
    });

    it('非整数 / 负数 → 拒收（null）——容错 ≠ 放松校验', () => {
      const floatRev = semverCatalogSample() as unknown as Record<string, unknown>;
      floatRev.revision = 1.5;
      expect(validateHubCatalog(floatRev)).toBeNull();
      const negRev = semverCatalogSample() as unknown as Record<string, unknown>;
      negRev.revision = -1;
      expect(validateHubCatalog(negRev)).toBeNull();
    });
  });

  it('1.5.0：EVT.resourceUnpublished 事件名登记（B12 撤回链——hub/index.ts onEvent 分支消费）', () => {
    expect(EVT.resourceUnpublished).toBe('resource.unpublished');
    expect(EVT.resourcePublished).toBe('resource.published');
  });
});
