// renderer/src/services/registry/types.ts
//
// 网络获取（注册表浏览）数据层契约。v1 仅内置 marketplace catalog Provider；
// 未来接 mcphub / skillhub = 新增实现，页面组件零改动（spec §3）。
import type { ResourceItem, ResourceType } from '../../ipc/types';

/** 注册表条目——网络获取模式的统一形状 */
export interface RegistryEntry {
  /** 对应 marketplace item 的 resource id（安装时透传给 installResource，禁止重新生成） */
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  /** 完整资源项（安装链路与详情面板消费） */
  item: ResourceItem;
}

export interface RegistryProvider {
  /** 稳定标识（未来多源选择器的 key） */
  readonly key: string;
  /** 展示名（如「内置市场」） */
  readonly label: string;
  /** 拉取某类型的注册表条目；query 为可选前端模糊过滤。失败抛 Error。 */
  list(type: ResourceType, query?: string): Promise<RegistryEntry[]>;
}