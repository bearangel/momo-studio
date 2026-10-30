// hub pin 形状锁（M2.3 T2b v0.1.5 / 裁定书 p1-0 §4.2；M3.0-P2 pin bump v0.1.6；
// M3.1 pin bump v0.1.7——协议 1.3.0：task.answer RPC + waiting 态 + 决策列 +
// task.answered 事件；M3.2 pin bump v0.1.8——协议 1.4.0：view.workspaces /
// view.files 两方法 + view.* 可选 groupId + files 限额常量；M3.4 pin bump
// v0.1.9——协议 1.5.0：SnapshotResourceRef.version? / HubCatalog.revision /
// EVT.resourceUnpublished；M4.2 pin bump v0.2.0——协议 1.6.0：TaskRecord.groupId? /
// ViewAppendedEvent.groupId? 两可选字段，PROTOCOL_VERSION 对齐；M4.3 pin bump
// v0.3.0——协议 1.7.0：DelegationTask.dependsOn? 可选字段（外派依赖元数据，
// 纯透传不校验存在性），PROTOCOL_VERSION 对齐；M5.0 pin bump v0.4.0——协议
// 1.8.0：HubResourceMeta.ownerNodeId? / ResourcePublishedEvent.ownerNodeId? /
// hello nodeName? 语义注释 + 错误码 name_conflict（403 not_owner 为 HTTP 端点
// 错误体扩展，不走 ws 错误码表），PROTOCOL_VERSION 对齐——锁八件事：
// ① pin 生效：node_modules 实装 momo-hub-protocol 版本 = pin 目标（0.5.0）——
//    防「lockfile-only 更新后未 install」/「pin 漂移」两类事故（构建新鲜度红线）
// ② v0.1.5 语义目录样本（hub 乱序发布产物，形状锚自 hub 仓 resources-latest-semver.test.ts
//    与裁定书 §1 curl 实录）过 validateHubCatalog——生产消费链（momo-hub.ts load）同校验器
// ③ 语义不变式：versions[0] === version（latest = semver max 落位首元素——studio 侧
//    T2 的「缺省装取 latest」消费锚）；非法形状（versions 非数组）仍拒——validate 未放松
// ④ 1.5.0 三面（M3.4 §2.1）：manifest resources[].version? 透传（缺省合法 /
//    在场保留 / 非法拒收）；HubCatalog.revision 容错归一（旧 hub 1.4 不发 → 0；
//    非整数/负数仍拒）；EVT.resourceUnpublished 事件名登记
// ⑤ 1.6.0 两面（M4.2 §2.1）：TaskRecord.groupId? 与 ViewAppendedEvent.groupId?
//    变体锁——在场合法（组归属消费面：委派板组徽标 / view.appended 桥透传）且
//    缺省合法（旧 hub 1.5 形状零变化——可选字段，消费面门控渲染不崩）
// ⑥ 1.7.0 一面（M4.3 §2.1）：DelegationTask.dependsOn? 变体锁——在场合法
//    （leader 侧 brief 透传面：dispatch-submit 组装带出）且缺省合法不带键
//    （1.6 载荷向后兼容）；上限校验（≤50 项/项 ≤128 字符）在 hub 侧白名单
//    （hub 仓 delegations.test.ts 锁死——studio 侧纯类型面，不重复运行时锁）
// ⑦ 1.8.0 三面（M5.0 §6/§8）：HubResourceMeta.ownerNodeId? 变体锁——在场
//    round-trip / 缺省不带键（旧 hub 目录零变化）/ 非串拒收；错误码
//    name_conflict 登记（hello 改名撞名——studio client.ts 人话覆写消费）；
//    ResourcePublishedEvent.ownerNodeId? 在场合法（studio 目录增量合并保留——
//    momo-hub.ts upsertPublished 消费）
// ⑧ 1.9.0 三面（M5.3 §5.1/§5.4）：DelegationTask.team? 变体锁——在场合法
//    （接收端多成员建会）且缺省不带键（1.8 载荷向后兼容——单 agent 路径零变化）；
//    TEAM_DELEGATION_REQUIRED_MINOR 常量（studio 派发闸与 hub 权威门禁共用的
//    门槛 minor——勿硬编码）；GroupMember.protoVer? 在线成员可选携带（离线
//    不带键，routingPrecheck nodeCaps 数据源）；team 段形状校验在 hub 侧
//    （hub 仓 delegations.test.ts 锁死——studio 侧纯类型面，不重复运行时锁）
// 版本 introspection 直读包内 package.json：单入口规则（protocol.ts）约束的是协议符号
// import；此处是 pin 锁定断言，目的不同，不走协议面。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  EVT,
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  TEAM_DELEGATION_REQUIRED_MINOR,
  validateHubCatalog,
  validateSnapshotManifest,
  type DelegationTask,
  type GroupMember,
  type HubCatalog,
  type TaskRecord,
  type ViewAppendedEvent,
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

describe('hub pin v0.5.0（M5.3）', () => {
  it('pin 生效：实装 momo-hub-protocol 版本 = 0.5.0（electron/package.json #v0.5.0）', () => {
    expect(pkg.version).toBe('0.5.0');
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

  describe('1.6.0：TaskRecord.groupId? / ViewAppendedEvent.groupId? 变体锁（M4.2 组归属）', () => {
    /** 最小合法 TaskRecord（1.5 七字段形状——groupId 缺省态的载体） */
    function recordSample(): TaskRecord {
      return {
        taskId: 'tk-1',
        workspaceName: 'product-dev',
        targetNodeId: 'node-b',
        status: 'running',
        title: '重构登录模块',
        createdAt: 1_000,
        updatedAt: 1_000,
      };
    }

    /** 最小合法 ViewAppendedEvent（1.5 形状） */
    function appendedSample(): ViewAppendedEvent {
      return { sessionId: 'sess-1', events: [] };
    }

    it('TaskRecord.groupId 在场合法（0.2.0 hub 投影——委派板组徽标数据源）', () => {
      const r: TaskRecord = { ...recordSample(), groupId: 'g-dev' };
      expect(r.groupId).toBe('g-dev');
    });

    it('TaskRecord.groupId 缺省合法且不带键（旧 hub 1.5 形状零变化——徽标门控不崩）', () => {
      const r: TaskRecord = recordSample();
      expect('groupId' in r).toBe(false);
    });

    it('ViewAppendedEvent.groupId 在场合法（订阅组锚定透传——index.ts 桥消费）', () => {
      const e: ViewAppendedEvent = { ...appendedSample(), groupId: 'g-dev' };
      expect(e.groupId).toBe('g-dev');
    });

    it('ViewAppendedEvent.groupId 缺省合法且不带键（旧订阅形状逐字节零变化）', () => {
      const e: ViewAppendedEvent = appendedSample();
      expect('groupId' in e).toBe(false);
    });
  });

  describe('1.7.0：DelegationTask.dependsOn? 变体锁（M4.3 外派依赖透传）', () => {
    /** 最小合法 DelegationTask（1.6 三字段形状——dependsOn 缺省态的载体） */
    function delegationTaskSample(): DelegationTask {
      return { title: '联调登录链路', prompt: '按任务书执行联调' };
    }

    it('dependsOn 在场合法（leader 侧 brief 透传面——dispatch-submit 组装带出）', () => {
      const t: DelegationTask = { ...delegationTaskSample(), dependsOn: ['T-001', 'T-002'] };
      expect(t.dependsOn).toEqual(['T-001', 'T-002']);
    });

    it('dependsOn 缺省合法且不带键（1.6 载荷向后兼容——无依赖外派零变化）', () => {
      const t: DelegationTask = delegationTaskSample();
      expect('dependsOn' in t).toBe(false);
    });
  });

  describe('1.8.0：HubResourceMeta.ownerNodeId? 变体锁（M5.0 资源归属）', () => {
    it('协议版本对齐：PROTOCOL_VERSION = 1.8.0（归属投影 + name_conflict）', () => {
      expect(PROTOCOL_VERSION).toBe('1.8.0');
    });

    it('在场 → validateHubCatalog round-trip 保留（徽标/按钮收敛判定输入）', () => {
      const sample = semverCatalogSample();
      sample.items[0]!.ownerNodeId = 'node-owner-1';
      const validated = validateHubCatalog(sample);
      expect(validated).not.toBeNull();
      expect(validated!.items[0]!.ownerNodeId).toBe('node-owner-1');
    });

    it('缺省 → 合法且不带键（旧 hub <1.8 目录零变化——判 unknown 安全降级）', () => {
      const validated = validateHubCatalog(semverCatalogSample());
      expect(validated).not.toBeNull();
      expect('ownerNodeId' in validated!.items[0]!).toBe(false);
    });

    it('非串（如数字）→ 拒收（null）——容错 ≠ 放松校验', () => {
      const sample = semverCatalogSample() as unknown as Record<string, unknown>;
      (sample.items as Array<Record<string, unknown>>)[0]!.ownerNodeId = 42;
      expect(validateHubCatalog(sample)).toBeNull();
    });

    it('错误码 name_conflict 登记（hello 改名撞名——client.ts 人话覆写消费）', () => {
      // RPC_ERROR_CODES 为协议包导出的合法错误码表（name_conflict 只增不改义）
      const codes = RPC_ERROR_CODES as readonly string[];
      expect(codes).toContain('name_conflict');
    });
  });

  describe('1.9.0：DelegationTask.team? / TEAM_DELEGATION_REQUIRED_MINOR / GroupMember.protoVer?（M5.3 外派团队）', () => {
    it('协议版本对齐：PROTOCOL_VERSION = 1.9.0（team 段 + 版本门）', () => {
      expect(PROTOCOL_VERSION).toBe('1.9.0');
    });

    it('team 在场合法（接收端 handleAssigned 多成员建会分支的消费面）', () => {
      const t: DelegationTask = {
        title: '联调登录链路',
        prompt: '按任务书执行联调',
        team: { members: [{ name: 'PM', isLeader: true }, { name: 'Coder', isLeader: false }] },
      };
      expect(t.team?.members).toHaveLength(2);
      expect(t.team?.members[0]?.isLeader).toBe(true);
    });

    it('team 缺省合法且不带键（1.8 载荷向后兼容——单 agent 外派零变化）', () => {
      const t: DelegationTask = { title: '联调登录链路', prompt: '按任务书执行联调' };
      expect('team' in t).toBe(false);
    });

    it('TEAM_DELEGATION_REQUIRED_MINOR = 9（派发闸门槛单源——studio 闸与 hub 门禁共用，勿硬编码）', () => {
      expect(TEAM_DELEGATION_REQUIRED_MINOR).toBe(9);
    });

    it('GroupMember.protoVer 在线携带 / 离线缺省合法（nodeCaps 数据源——两形状都不得崩）', () => {
      const online: GroupMember = { nodeId: 'node-a', name: 'office-mac', online: true, protoVer: '1.9.0' };
      expect(online.protoVer).toBe('1.9.0');
      const offlineLegacy: GroupMember = { nodeId: 'node-b', name: 'lab-node', online: false };
      expect('protoVer' in offlineLegacy).toBe(false);
    });
  });
});
