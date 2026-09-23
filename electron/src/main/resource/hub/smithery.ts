// electron/src/main/resource/hub/smithery.ts
//
// Smithery registry provider（spec §4.1，决策 D4：主进程代理，renderer 经 IPC 消费）。
// 端点与字段以 Task 0 实测核实文档为准（.superpowers/sdd/task-0-api-verify.md）：
//   - GET /servers?pageSize=N&q=关键词&page=页码（无 key；q 搜索已实测可用；
//     page 1 起始——2026-09-23 复测 page=0 被 422 拒绝、page=1 与缺省等价）
//   - 条目标识是 qualifiedName（如 '@owner/weather' / 'brave'），不是 id（那是 UUID）
//   - P2.1 直连翻转：installable 由 isDeployed 驱动（false=未部署不可装）；
//     remote 字段不再是安装开关——hosted 条目经详情 deploymentUrl 直连安装
//   - inactive / unlisted 条目过滤不展示
import { createBackoff } from './backoff';
import type { HubEntry, HubListResult, HubProvider } from './types';
import { buildResourceId, type ResourceItem } from '../types';
import { isValidSlug } from '../../marketplace/types';

const API_BASE = 'https://registry.smithery.ai';
const PAGE_SIZE = 30;
/** 请求超时——与 marketplace/client.ts 同档（3s），避免 UI 长时间卡住 */
const FETCH_TIMEOUT_MS = 3000;

const backoff = createBackoff('smithery');

/**
 * Smithery 服务器条目（字段见 Task 0 核实；全部宽松可选以容错第三方响应）。
 * iconUrl / homepage / createdAt / owner 暂不消费。
 */
interface SmitheryServer {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  verified?: boolean;
  useCount?: number;
  remote?: boolean;
  isDeployed?: boolean;
  inactive?: boolean;
  unlisted?: boolean;
}

/** 从 qualifiedName 提取 namespace 段（去 @ 前缀、取首个 / 之前）——'@owner/weather' → 'owner' */
function namespaceOf(qualifiedName: string): string {
  return qualifiedName.replace(/^@/, '').split('/')[0] ?? '';
}

/**
 * 单条 Smithery 响应 → HubEntry。返回 null 表示跳过该条：
 *   - 缺 qualifiedName / displayName（映射不成立）
 *   - inactive || unlisted（Task 0 过滤规则）
 *   - namespace 段过不了 S1 slug 白名单（该段会进入安装链路，防注入）
 */
function toEntry(raw: SmitheryServer): HubEntry | null {
  const qualifiedName = raw.qualifiedName;
  if (!qualifiedName || !raw.displayName) return null;
  if (raw.inactive || raw.unlisted) return null;
  const namespace = namespaceOf(qualifiedName);
  if (!isValidSlug(namespace)) return null;

  const description = raw.description ?? '';
  const item: ResourceItem = {
    id: buildResourceId('smithery', 'mcp', qualifiedName),
    type: 'mcp',
    source: 'smithery',
    // qualifiedName 整体作 slug——安装标识沿线透传（安装时 GET 详情取 deploymentUrl 直连）
    slug: qualifiedName,
    name: raw.displayName,
    description,
    installed: false,
    // P2.1 直连翻转：isDeployed=false（未部署）展示但不可装；
    // remote（hosted）不再挡安装——详情 deploymentUrl 直连链对所有 hosted 条目开放
    installable: !!raw.isDeployed,
    removable: false,
    marketplace: {
      author: namespace,
      readme: description,
      // P2 无 zip 下载链路——smithery 安装走 Task 3 直连——注册远程 MCP
      downloadUrl: '',
      checksum: '',
      verificationStatus: raw.verified ? 'verified' : 'unverified',
      installCount: raw.useCount,
      tags: [],
      category: 'smithery',
    },
  };
  return {
    id: item.id,
    type: 'mcp',
    name: item.name,
    description,
    tags: [],
    category: 'smithery',
    item,
  };
}

export const smitheryProvider: HubProvider = {
  key: 'smithery',
  label: 'Smithery',
  region: 'intl',
  types: ['mcp'],
  async list(type, query, page = 1): Promise<HubListResult> {
    if (type !== 'mcp') throw new Error(`Smithery 暂只支持 MCP（收到 ${type}）`);
    // 退避窗口内零网络——直接返回 degraded（UI 置灰，不隐藏）
    if (backoff.isBackedOff()) return { entries: [], degraded: true, hasMore: false };
    try {
      const q = query?.trim();
      const url =
        `${API_BASE}/servers?pageSize=${PAGE_SIZE}` +
        (q ? `&q=${encodeURIComponent(q)}` : '') +
        `&page=${page}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        servers?: SmitheryServer[];
        pagination?: { totalPages?: number };
      };
      backoff.recordSuccess();
      const entries = (body.servers ?? [])
        .map(toEntry)
        .filter((e): e is HubEntry => e !== null);
      // hasMore = totalPages > page；响应缺 pagination 时保守视为末页（不渲染加载更多）
      const totalPages = body.pagination?.totalPages;
      return {
        entries,
        degraded: false,
        hasMore: totalPages !== undefined ? totalPages > page : false,
      };
    } catch {
      backoff.recordFailure();
      return { entries: [], degraded: true, hasMore: false };
    }
  },
};

/** registryProviders IPC 消费——当前是否处于失败退避窗口（不打网络） */
export function isSmitheryDegraded(): boolean {
  return backoff.isBackedOff();
}

/** 测试用：清退避（rewind 大数越界任何窗口 + recordSuccess 兜底归零） */
export function __resetHubBackoffForTest(): void {
  backoff.__rewindForTest(Number.MAX_SAFE_INTEGER);
  backoff.recordSuccess();
}
