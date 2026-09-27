// renderer/src/lib/asset-data-url.ts
//
// 气泡缩略图 data URL 取数层（2026-09-26 多模态 spec §10）。
// 模块级 Promise 缓存：MessageBubble 在 stream 更新 / 列表重渲染时会高频重挂载，
// 直连 IPC 会形成同图重复请求风暴。缓存 key 只用 path——`.momo/assets/<sha1-12>.<ext>`
// 是内容寻址命名（asset:saveImage），同 path 必同字节，workspace 维度天然冗余。
// 缓存存 Promise（成功与失败都缓存）：并发挂载去重 + 失败后不重发（spec §11 删图
// 场景直接稳定降级，不在每次重渲染上重打注定失败的 IPC）。
import { ipc } from '../ipc/client';

const dataUrlCache = new Map<string, Promise<string>>();

/** 取图 data URL：同 path 全 session 只发一次真实 IPC（含失败） */
export function loadAssetDataUrl(workspaceId: string, path: string): Promise<string> {
  const hit = dataUrlCache.get(path);
  if (hit) return hit;
  const p = ipc.asset.readDataUrl(workspaceId, path);
  dataUrlCache.set(path, p);
  return p;
}

/** 测试专用：清空缓存（生产不调用） */
export function __resetAssetDataUrlCacheForTests(): void {
  dataUrlCache.clear();
}
