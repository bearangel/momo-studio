// electron/src/main/p2p/resource-transfer.ts
//
// 资源导入请求/供给落地（P4 Task 5）。
//
// 设计要点：
//   - requestId 配对 Promise 模式（参照 dispatch-wait 的 pending Map + 超时）：
//     需求方 requestResourceImport 注册 pending → 单发 resource-request →
//     供给方 handleResourceRequest 查本地 custom 资源回 resource-provide →
//     handleResourceProvide 按 requestId resolve。30s 无回执 → 'timeout'。
//     注册 pending 必须先于发送（防对端回执先到丢回执——dispatch-wait 同款竞态防御）
//   - definition: null 是显式 not-found 标记（协议层 guard 已放行，见 protocols.ts）
//   - 落地语义：agent 走 createCustomDef 等价路径（global + 不落 assignment——导入后
//     用户手动加入 workspace，同资源库现有 agent 安装语义）；mcp 走 registerMcpDefinition
//     （name 幂等覆盖——DB UNIQUE(name) + INSERT OR REPLACE 既有语义）
//   - agent slug 冲突：本地已存在同 slug def 时后缀 `-from-{nodeId前4}`，再冲突追加
//     `-2`/`-3`...；最多尝试 20 次，超出抛错（按本地 def 数量几乎不可能触发——兜底）
//   - 模型配置不跨节点传输（机器本地信息）：agent 定义不含 provider/model 字段，
//     落地时空串走 createCustomDef 的 defaultChatModel 兜底
//   - 依赖装配镜像 task-broadcast.ts：deps 由 initP2p 注入 / stopP2p 清空，
//     未装配时需求方抛错（install handler 需感知）、供给方静默 no-op
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { listCustomResources } from '../resource/custom';
import { createCustomDef, getAgentDefinition, listAgentDefinitions } from '../agent/crud';
import type { ToolRef } from '../agent/types';
import { SAFE_MINIMUM_TOOLS } from '../agent/tools/catalog';
import { registerMcpDefinition } from '../mcp/host-manager';
import type { P2pSync } from './sync';
import { getSharedResources } from './resource-share';
import type { ResourceProvide, ResourceRequest } from './protocols';

/** 导入结果：ok=落地成功 / not-found=对端未找到 / timeout=30s 无回执 */
export type ResourceImportResult = 'ok' | 'not-found' | 'timeout';

/** P2P 可共享资源类型（与目录构建范围一致——skill 排除，2.1 遗留） */
export type P2pResourceType = 'agent' | 'mcp';

/** 装配依赖——initP2p 成功后注入（Pick 收窄到本模块实际用到的能力） */
export interface ResourceTransferDeps {
  /** 单发通道（P2pSync 实例；结构类型便于测试注入最小桩） */
  sync: Pick<P2pSync, 'sendResourceRequest' | 'sendResourceProvide'>;
}

/** 供给回执等待超时——对端需查库 + 网络往返，30s 覆盖正常路径且不无限挂起 */
const PROVIDE_TIMEOUT_MS = 30_000;

/** defaultTools 钳制白名单（安全最小集）——P2P 导入不放大权限 */
const SAFE_TOOL_REFS: ReadonlySet<string> = new Set<string>(SAFE_MINIMUM_TOOLS);

/** 模块级单例（initP2p 装配，stopP2p 清空） */
let deps: ResourceTransferDeps | null = null;

/** initP2p 装配调用：注入 P2pSync 单发通道 */
export function setResourceTransferDeps(next: ResourceTransferDeps): void {
  deps = next;
}

/** stopP2p 清空调用：回到"P2P 未启用"状态（挂起中的请求由各自 30s 定时器自然收敛） */
export function clearResourceTransferDeps(): void {
  deps = null;
}

/** pending 供给回执的 resolve 结果：timeout 与 provided(null) 必须可区分 */
type ProvideOutcome =
  | { kind: 'timeout' }
  | { kind: 'provided'; definition: Record<string, unknown> | null };

interface PendingProvide {
  resolve: (outcome: ProvideOutcome) => void;
  timer: NodeJS.Timeout;
}

/** pending 供给回执：requestId → 等待中的 Promise（requestResourceImport 注册） */
const pendingProvides = new Map<string, PendingProvide>();

/**
 * 需求方：向指定节点请求导入某资源的完整定义并落地。
 *
 * 流程：注册 pending（防竞态）→ sendResourceRequest → 等待 provide（30s 超时）→
 * definition null → 'not-found'；否则落地（agent → custom def / mcp → mcp_definitions）
 * → 'ok'。落地失败（畸形定义 / 模型兜底缺失）原样上抛给调用方（install handler）。
 */
export async function requestResourceImport(
  nodeId: string,
  type: P2pResourceType,
  slug: string,
): Promise<ResourceImportResult> {
  if (!deps) throw new Error('P2P 未启用，无法导入资源');

  // P5 安全修复：请求时快照本地目录条目，provide 抵达后核对（防 bait-and-switch——
  // 目录展示 A、实际供给 B）。本地无该条目（目录已 prune / 非目录入口发起）直接拒绝，
  // 不给"无预期可核对"的供给留落地通道。
  const expected = findExpectedCatalogEntry(nodeId, type, slug);
  if (!expected) {
    throw new Error(
      `本地目录无节点 ${nodeId} 的 ${type} 资源 ${slug} 条目（目录可能已过期，请刷新资源库后重试）`,
    );
  }

  const requestId = randomUUID();
  // 先注册 pending 再发送——若先发送后注册，对端极快回执时 provide 会在
  // pending.set 之前到达，handleResourceProvide 找不到 pending 导致回执丢失
  const outcomePromise = new Promise<ProvideOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingProvides.delete(requestId);
      resolve({ kind: 'timeout' });
    }, PROVIDE_TIMEOUT_MS);
    pendingProvides.set(requestId, { resolve, timer });
  });

  try {
    await deps.sync.sendResourceRequest(nodeId, { requestId, resourceType: type, slug });
  } catch (err) {
    // 单发不吞错（与广播的尽力而为策略不同）；清理 pending 防定时器空转
    const pending = pendingProvides.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingProvides.delete(requestId);
    }
    throw new Error(
      `向节点 ${nodeId} 发送资源请求失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const outcome = await outcomePromise;
  if (outcome.kind === 'timeout') return 'timeout';
  if (outcome.definition === null) return 'not-found';
  validateProvidedDefinition(outcome.definition, expected, type, slug, nodeId);
  landImportedDefinition(type, outcome.definition, nodeId);
  return 'ok';
}

/**
 * 从 resource-share 目录缓存取请求目标条目（请求时刻快照——之后目录更新不影响本次核对）。
 */
function findExpectedCatalogEntry(
  nodeId: string,
  type: P2pResourceType,
  slug: string,
): { name: string; version?: string } | null {
  const node = getSharedResources().find((n) => n.nodeId === nodeId);
  if (!node) return null;
  const entry = node.items.find((i) => i.type === type && i.slug === slug);
  if (!entry) return null;
  return entry.version !== undefined
    ? { name: entry.name, version: entry.version }
    : { name: entry.name };
}

/**
 * P5 安全修复：provide 与请求时刻的目录快照核对（名称 + 版本，按请求 type 隐含核对）。
 * 不匹配即拒绝落地并记中文告警——"目录展示与实际供给不一致"是 bait-and-switch 信号。
 * 注：当前协议无 checksum 字段，指纹核对以 name/version 为界；2.1 可在目录/provide
 * 中加内容哈希后在此扩展。
 */
function validateProvidedDefinition(
  definition: Record<string, unknown>,
  expected: { name: string; version?: string },
  type: P2pResourceType,
  slug: string,
  fromNodeId: string,
): void {
  const actualName = typeof definition.name === 'string' ? definition.name : '';
  if (actualName !== expected.name) {
    logger.warn('P2P 资源供给与目录条目不符（name），已拒绝导入', {
      from: fromNodeId,
      type,
      slug,
      expectedName: expected.name,
      actualName: actualName || '(缺失)',
    });
    throw new Error(
      `对端供给的资源名称与目录不符（期望 ${expected.name}，实际 ${actualName || '(缺失)'}），已拒绝导入`,
    );
  }
  if (expected.version !== undefined) {
    const actualVersion = typeof definition.version === 'string' ? definition.version : '';
    if (actualVersion !== expected.version) {
      logger.warn('P2P 资源供给与目录条目不符（version），已拒绝导入', {
        from: fromNodeId,
        type,
        slug,
        expectedVersion: expected.version,
        actualVersion: actualVersion || '(缺失)',
      });
      throw new Error(
        `对端供给的资源版本与目录不符（期望 ${expected.version}，实际 ${actualVersion || '(缺失)'}），已拒绝导入`,
      );
    }
  }
}

/**
 * 需求方入站：收到 resource-provide → 按 requestId resolve pending。
 * 迟到/未知回执（超时后到达或重复回执）静默丢弃。
 * 由 initP2p 的 onResourceProvide 回调接线调用。
 */
export function handleResourceProvide(prov: ResourceProvide, _fromNodeId: string): void {
  const pending = pendingProvides.get(prov.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingProvides.delete(prov.requestId);
  pending.resolve({ kind: 'provided', definition: prov.definition });
}

/**
 * 供给方入站：收到 resource-request → 查本地 custom 资源 → 单发 resource-provide
 * （未找到回 definition: null）。由 initP2p 的 onResourceRequest 回调接线调用；
 * 发送失败仅记日志不抛（调用方在 router 分发链上，抛错会打断消息循环——
 * 需求方按 30s 超时自然收敛）。
 */
export function handleResourceRequest(req: ResourceRequest, fromNodeId: string): void {
  if (!deps) return;
  const definition = buildProvideDefinition(req);
  void deps.sync
    .sendResourceProvide(fromNodeId, { requestId: req.requestId, definition })
    .catch((err) => {
      logger.warn('P2P 资源供给发送失败', {
        requestId: req.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * 供给方：构建完整资源定义。匹配范围与目录构建一致（listCustomResources 的
 * custom 项）——能广告的才能供给。agent 清单元数据只有 prompt 指纹，
 * 完整定义按 def.id（= 目录 slug，custom.ts 口径）反查 agent_definitions。
 */
function buildProvideDefinition(req: ResourceRequest): Record<string, unknown> | null {
  const match = listCustomResources().find((r) => r.type === req.resourceType && r.slug === req.slug);
  if (!match) return null;

  if (req.resourceType === 'mcp') {
    const cfg = match.custom?.mcpConfig;
    if (!cfg) return null;
    return {
      name: match.slug,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      version: match.version,
    };
  }

  const def = getAgentDefinition(req.slug);
  if (!def || def.source !== 'custom') return null;
  return {
    name: def.name,
    slug: def.slug,
    systemPrompt: def.systemPrompt,
    iconEmoji: def.iconEmoji,
    description: def.description,
    defaultTools: def.defaultTools,
    version: def.version,
  };
}

/** 落地入口：按类型分流（畸形字段上抛——对端可能是旧版本节点，错误信息帮助定位） */
function landImportedDefinition(
  type: P2pResourceType,
  definition: Record<string, unknown>,
  fromNodeId: string,
): void {
  if (type === 'agent') {
    landAgentDefinition(definition, fromNodeId);
  } else {
    landMcpDefinition(definition);
  }
}

function landAgentDefinition(definition: Record<string, unknown>, fromNodeId: string): void {
  const name = requireString(definition, 'agent', 'name');
  const originalSlug = requireString(definition, 'agent', 'slug');
  const systemPrompt = requireString(definition, 'agent', 'systemPrompt');

  const slug = findFreeAgentSlug(originalSlug, fromNodeId);

  // modelProviderId 空串 → createCustomDef 内部走本机 defaultChatModel 兜底
  // （未配置时抛出可操作错误，经 install handler 透传给用户）
  createCustomDef(null, {
    name,
    slug,
    description: optionalString(definition, 'description'),
    systemPrompt,
    iconEmoji: optionalString(definition, 'iconEmoji'),
    modelProviderId: '',
    modelName: '',
    // P5 安全修复：显式钳制到安全最小集——字段缺省 → createCustomDef 填
    // SAFE_MINIMUM_TOOLS；字段存在（对端可控）→ 只保留最小集内的 builtin 引用
    defaultTools: readToolRefs(definition, fromNodeId),
  });
  logger.info('P2P agent 定义已导入', { slug, from: fromNodeId });
}

/** agent slug 冲突后缀上限——超出几乎等于本地已被同节点 def 占满，视为异常 */
const SLUG_COLLISION_MAX_ATTEMPTS = 20;

/**
 * 找一个未被本地 def 占用的 agent slug。
 * 候选顺序：原始 → -from-{nodeId前4} → -from-{nodeId前4}-2 → ... → -from-...-N。
 * 上限 20 次（防御性兜底——正常场景一次/两次即落定）。
 */
function findFreeAgentSlug(originalSlug: string, fromNodeId: string): string {
  const existing = new Set(listAgentDefinitions().map((d) => d.slug));
  if (!existing.has(originalSlug)) return originalSlug;
  const base = `${originalSlug}-from-${fromNodeId.slice(0, 4)}`;
  if (!existing.has(base)) return base;
  for (let n = 2; n <= SLUG_COLLISION_MAX_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(
    `agent slug 冲突后缀达到上限（${SLUG_COLLISION_MAX_ATTEMPTS}）：${originalSlug}`,
  );
}

function landMcpDefinition(definition: Record<string, unknown>): void {
  const name = requireString(definition, 'mcp', 'name');
  const command = requireString(definition, 'mcp', 'command');
  registerMcpDefinition({
    id: randomUUID(),
    name,
    version: optionalString(definition, 'version') ?? '1.0.0',
    command,
    args: readStringArray(definition, 'args') ?? [],
    env: readEnv(definition),
    // 导入落 custom（与用户自注册一致——可删可再共享，形成目录回流）
    source: 'custom',
  });
  logger.info('P2P mcp 定义已导入', { name });
}

function requireString(def: Record<string, unknown>, type: P2pResourceType, key: string): string {
  const v = def[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`对端返回的 ${type} 定义缺少 ${key} 字段（可能为旧版本节点）`);
  }
  return v;
}

function optionalString(def: Record<string, unknown>, key: string): string | undefined {
  const v = def[key];
  return typeof v === 'string' ? v : undefined;
}

function readStringArray(def: Record<string, unknown>, key: string): string[] | undefined {
  const v = def[key];
  if (!Array.isArray(v)) return undefined;
  return v.every((s) => typeof s === 'string') ? (v as string[]) : undefined;
}

function readEnv(def: Record<string, unknown>): Record<string, string> | undefined {
  const v = def.env;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return undefined;
    env[k] = val;
  }
  return env;
}

/**
 * defaultTools 白名单收窄（P5 安全修复）：
 * 仅保留形状合法且 ref ∈ 安全最小集的 builtin 引用——bash、未知 ref、非 builtin
 * kind 一律剔除（对端供给的定义不可信，导入不得放大权限），剔除动作记中文告警日志。
 * 字段缺失仍返回 undefined（沿用 createCustomDef 的 SAFE_MINIMUM_TOOLS 缺省语义）。
 */
function readToolRefs(
  definition: Record<string, unknown>,
  fromNodeId: string,
): ToolRef[] | undefined {
  const v = definition.defaultTools;
  if (!Array.isArray(v)) return undefined;
  const kept: ToolRef[] = [];
  let dropped = 0;
  for (const t of v) {
    if (
      typeof t === 'object' &&
      t !== null &&
      (t as Record<string, unknown>).kind === 'builtin' &&
      typeof (t as Record<string, unknown>).ref === 'string' &&
      SAFE_TOOL_REFS.has((t as Record<string, unknown>).ref as string)
    ) {
      kept.push({ kind: 'builtin', ref: (t as Record<string, unknown>).ref as string });
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.warn('P2P 导入 agent 的 defaultTools 含越权工具，已按安全最小集钳制', {
      from: fromNodeId,
      dropped,
    });
  }
  return kept;
}
