// electron/src/main/hub/http-errors.ts
//
// hub HTTP 资源端点（/resources/publish、/resources/unpublish）的错误体人话单源
// （M5.0 §7.2 / hub 协议 1.8.0）：403 not_owner 错误体 `{error:'not_owner',
// owner_name}` → 「该资源属于节点 {owner_name}，无法{发布新版/下架}」。
//
// 与 M4.1 ws 错误契约（rpc-error 前缀）分工：publish/unpublish 走 HTTP 而非 ws
// RPC，错误在主进程 HTTP 映射层直接落人话（publish.ts 既有「错误映射人话」模式
// 的延伸）——本模块是两链共用单源，防两处文案漂移（一义一名）。
//
// 旧 hub（<1.8）无领地判定 → 不产生 403 not_owner，本映射零触发——安全降级。

/**
 * 解析 403 响应体中的 owner 名（hub §3/§4：`{error:'not_owner', owner_name}`）。
 * 形状不符（旧 hub 异构体 / 网关页 / 空体）返回 undefined——调用方落不带名的兜底文案。
 */
export function parseOwnerName(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const name = (body as { error?: unknown; owner_name?: unknown }).owner_name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * not_owner 人话（spec §7.2 逐字）：有 owner_name 携名，缺失落「其他节点」兜底。
 * action ∈ '发布新版' | '下架'——两链各自传入，其余文案单点。
 */
export function humanizeNotOwner(action: '发布新版' | '下架', ownerName: string | undefined): string {
  return `该资源属于节点 ${ownerName ?? '其他节点'}，无法${action}`;
}
