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
}

/** hub provider 契约——每个网络注册表一个实现（smithery / modelscope） */
export interface HubProvider {
  readonly key: 'smithery' | 'modelscope';
  readonly label: string;
  readonly region: 'intl' | 'cn';
  readonly types: ResourceType[];
  list(type: ResourceType, query?: string): Promise<HubListResult>;
}
