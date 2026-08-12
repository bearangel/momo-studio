// renderer/src/lib/resource-helpers.ts
//
// renderer 端 sourceLabel 镜像——与 electron 端 resource/types.ts 的 SOURCE_LABELS
// 保持文案一致（builtin=系统预置 / custom=我的上传 / marketplace=网络资源 / p2p=P2P 共享）。
// 跨 workspace 不共享类型，仅结构对齐（与项目其他 renderer lib 同套做法）。
import type { ResourceSource } from '../ipc/types';

/** source 中文展示名（与 electron 端 SOURCE_LABELS 同步） */
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
