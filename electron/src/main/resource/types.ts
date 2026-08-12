// electron/src/main/resource/types.ts
//
// v1.7 资源库统一类型定义。所有来源（builtin/custom/marketplace/p2p）的资源
// 都映射成 ResourceItem，前端只感知这一种数据结构，不感知 source 差异。
//
// 这是 v1.7 整个 UI + IPC 重构的核心类型——后续 14 个 task（registry / IPC /
// store / UI 组件）都引用本文件导出的符号。字段名严格按 brief 定义，不要改名。

/** 资源类型：agent（子 agent 定义）/ mcp（MCP server 包）/ skill（技能包） */
export type ResourceType = 'agent' | 'mcp' | 'skill';

/**
 * 资源来源：
 *   - builtin      系统预置（随应用分发，不可删除）
 *   - marketplace  网络资源（远程 catalog 下载安装）
 *   - custom       我的上传（用户本地注册 / 上传）
 *   - p2p          P2P 共享（其他 peer 推送过来的资源，v2 引入）
 */
export type ResourceSource = 'builtin' | 'marketplace' | 'custom' | 'p2p';

/** 资源列表过滤条件——所有字段可选，undefined 表示不过滤该维度 */
export interface ResourceFilter {
  type?: ResourceType;
  source?: ResourceSource;
}

/**
 * 统一资源项。v1.7 UI/IPC 的核心数据结构。
 *
 * 顶层字段对所有 source 通用；source 特有信息放在对应的可选 namespace 字段
 * （builtin / marketplace / custom / p2p）中，由消费方按 source 按需读取。
 * 这种"扁平通用字段 + 可选 namespace"的形状让前端列表渲染只需顶层字段，
 * 详情面板再按 source 切换到对应 namespace。
 */
export interface ResourceItem {
  /** 资源全局唯一 id，格式 `${source}-${type}-${slug}`，由 buildResourceId 生成 */
  id: string;
  type: ResourceType;
  source: ResourceSource;
  /** source 内的业务标识（agent slug / mcp name / skill slug），不含 source/type 前缀 */
  slug: string;
  /** 展示名（i18n 后的中文/英文名，区别于 slug） */
  name: string;
  description: string;
  version?: string;
  iconEmoji?: string;
  /** 是否已安装到本地（builtin 永远 true） */
  installed: boolean;
  /** 是否可安装（builtin = false；p2p 未确认时 = false） */
  installable: boolean;
  /** 是否可删除（仅 builtin = false） */
  removable: boolean;
  /** builtin 项的扩展元数据 */
  builtin?: { category?: string; tags?: string[] };
  /** marketplace 项的扩展元数据（校验状态 / 下载地址 / 统计等） */
  marketplace?: {
    author: string;
    readme: string;
    downloadUrl: string;
    /** sha256 hex 校验和 */
    checksum: string;
    verificationStatus: 'official' | 'verified' | 'community' | 'unverified';
    sizeBytes?: number;
    installCount?: number;
    tags: string[];
    category: string;
  };
  /** custom 项的扩展元数据（安装时间 / mcp 配置 / skill frontmatter / prompt hash） */
  custom?: {
    installedAt: string;
    mcpConfig?: { command: string; args: string[]; env?: Record<string, string> };
    skillFrontmatter?: { name?: string; version?: string };
    agentSystemPromptHash?: string;
  };
  /** p2p 项的扩展元数据（来源 peer 标识） */
  p2p?: { peerId: string; peerName: string };
};

/** sourceLabel 的中文文案表，UI 列表 / Tab / 徽标共用 */
const SOURCE_LABELS: Record<ResourceSource, string> = {
  builtin: '系统预置',
  custom: '我的上传',
  marketplace: '网络资源',
  p2p: 'P2P 共享',
};

/**
 * 返回某 source 的中文展示名。
 * 例：sourceLabel('builtin') === '系统预置'
 */
export function sourceLabel(source: ResourceSource): string {
  return SOURCE_LABELS[source];
}

/**
 * 由 (source, type, slug) 三元组拼出全局唯一资源 id。
 * 格式：`${source}-${type}-${slug}`，slug 可含连字符（如 UUID）。
 */
export function buildResourceId(source: ResourceSource, type: ResourceType, slug: string): string {
  return `${source}-${type}-${slug}`;
}

/**
 * 反解资源 id 为三元组。非法 id（空 slug / 未知 source / 未知 type）返回 null。
 *
 * 正则说明：
 *   - source / type 用白名单交替组严格匹配，未知值直接判负
 *   - slug 部分用贪婪 `.+` 匹配，允许 UUID 中的连字符（如 abc-123-def）
 *   - `.+` 至少 1 字符，因此 `builtin-agent-`（空 slug）不匹配 → 返回 null
 */
export function parseResourceId(id: string): { source: ResourceSource; type: ResourceType; slug: string } | null {
  // slug 部分允许任意非空字符（包括 UUID 中的连字符），用贪婪匹配
  const m = id.match(/^(builtin|marketplace|custom|p2p)-(agent|mcp|skill)-(.+)$/);
  if (!m || !m[3]) return null;
  return {
    source: m[1] as ResourceSource,
    type: m[2] as ResourceType,
    slug: m[3],
  };
}
