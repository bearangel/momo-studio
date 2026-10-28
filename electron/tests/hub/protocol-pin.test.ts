// hub pin 形状锁（M2.3 T2b v0.1.5 / 裁定书 p1-0 §4.2；M3.0-P2 pin bump v0.1.6）——
// 锁三件事：
// ① pin 生效：node_modules 实装 momo-hub-protocol 版本 = pin 目标（0.1.6）——
//    防「lockfile-only 更新后未 install」/「pin 漂移」两类事故（构建新鲜度红线）
// ② v0.1.5 语义目录样本（hub 乱序发布产物，形状锚自 hub 仓 resources-latest-semver.test.ts
//    与裁定书 §1 curl 实录）过 validateHubCatalog——生产消费链（momo-hub.ts load）同校验器
// ③ 语义不变式：versions[0] === version（latest = semver max 落位首元素——studio 侧
//    T2 的「缺省装取 latest」消费锚）；非法形状（versions 非数组）仍拒——validate 未放松
// 版本 introspection 直读包内 package.json：单入口规则（protocol.ts）约束的是协议符号
// import；此处是 pin 锁定断言，目的不同，不走协议面。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { validateHubCatalog, type HubCatalog } from '../../src/main/hub/protocol';

const hubDirRequire = createRequire(`${__dirname}/../../src/main/hub/`);
const pkg = JSON.parse(readFileSync(hubDirRequire.resolve('momo-hub-protocol/package.json'), 'utf8')) as {
  version: string;
};

/** hub v0.1.5 乱序发布实录样本（发布序 1.0.0 → 2.0.0 → 1.5.0）：
 *  latest = versions 全集 semver max（2.0.0），versions semver 降序。 */
function semverCatalogSample(): HubCatalog {
  return {
    version: '1.2.0',
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

describe('hub pin v0.1.6（M3.0-P2）', () => {
  it('pin 生效：实装 momo-hub-protocol 版本 = 0.1.6（electron/package.json #v0.1.6）', () => {
    expect(pkg.version).toBe('0.1.6');
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
});
