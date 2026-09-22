// renderer/src/services/registry/types.ts
//
// 网络获取（注册表浏览）数据层契约。P2 起多源经主进程 IPC（resource:registryList）
// 取数，renderer 侧不再有 provider 实现——本文件只保留 RegistryEntry（组件消费）。
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
