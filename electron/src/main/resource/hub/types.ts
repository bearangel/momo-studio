// electron/src/main/resource/hub/types.ts
//
// 主进程 hub provider 契约（spec §4.1）。renderer 侧经 resource:registryList IPC
// 消费，不直接 import 本文件——字段形状经 IPC 序列化后在 renderer/types.d.ts
// 侧以 RegistryListEntry 镜像（跨 workspace 各自维护，仅结构对齐）。

import type { ResourceItem, ResourceType } from '../types';

/** hub 条目——与 renderer 侧 RegistryEntry 同构（网络获取模式的统一形状） */
export interface HubEntry {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  item: ResourceItem;
}

export interface HubListResult {
  entries: HubEntry[];
  /** 命中退避窗口（上次失败后未重试）——UI 置灰信号，不隐藏 */
  degraded: boolean;
  /** 请求页之后还有更多页（smithery 按 pagination.totalPages 判定；错误路径恒 false） */
  hasMore: boolean;
}

/** hub provider 契约——每个网络注册表一个实现（smithery；modelscope 已于 P2.1 移除） */
export interface HubProvider {
  readonly key: 'smithery';
  readonly label: string;
  readonly region: 'intl' | 'cn';
  readonly types: ResourceType[];
  /** page 1 起始（2026-09-23 实测 Smithery page 参数 1 起、page=0 被 422 拒绝） */
  list(type: ResourceType, query?: string, page?: number): Promise<HubListResult>;
}
