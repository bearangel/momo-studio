// 工作组管理客户端（M2b spec §3.1）——组六方法经 hub client 的 RPC 关联器直达；
// hub 端错误（forbidden/not_found/…）由 client.request 以 Error(RpcErrorPayload.message)
// 原样抛出（人话在 hub 侧生成），本层不再二次包装。
// 工厂形态解耦模块依赖：request 函数由调用方注入（ipc.handlers 接 index.hubRequest），
// 本模块不 import index——避免 index（事件桥消费本模块）↔ 本模块 循环引用。
import {
  RPC, EVT,
  type EventEnvelope, type GroupChangedEvent,
  type GroupCreateRes, type GroupJoinRes, type GroupLeaveRes,
  type GroupListReq, type GroupListRes, type GroupTransferRes, type InviteInfo,
} from './protocol';

export type HubRequestFn = <T>(method: string, payload: unknown, timeoutMs?: number) => Promise<T>;

export interface GroupClient {
  list(): Promise<GroupListRes>;
  create(groupName: string): Promise<GroupCreateRes>;
  invite(groupId: string): Promise<InviteInfo>;
  join(inviteCode: string): Promise<GroupJoinRes>;
  leave(groupId: string): Promise<GroupLeaveRes>;
  transfer(groupId: string, toNodeId: string): Promise<GroupTransferRes>;
}

export function createGroupClient(request: HubRequestFn): GroupClient {
  return {
    list: () => {
      const payload: GroupListReq = {};
      return request<GroupListRes>(RPC.group.list, payload);
    },
    create: (groupName) => request<GroupCreateRes>(RPC.group.create, { groupName }),
    invite: (groupId) => request<InviteInfo>(RPC.group.invite, { groupId }),
    join: (inviteCode) => request<GroupJoinRes>(RPC.group.join, { inviteCode }),
    leave: (groupId) => request<GroupLeaveRes>(RPC.group.leave, { groupId }),
    transfer: (groupId, toNodeId) => request<GroupTransferRes>(RPC.group.transfer, { groupId, toNodeId }),
  };
}

/**
 * group.changed → hub:groupChanged 推送桥（index.ts onEvent 消费；广播通道单点在 index）。
 * 六字段显式挑出（协议 GroupChangedEvent 形状），不透传整个 payload 防信封杂字段渗入
 * renderer 契约——与 resourcePublished 桥同款纪律。
 */
export function bridgeGroupChanged(
  evt: EventEnvelope,
  broadcast: (channel: string, payload: unknown) => void,
): void {
  if (evt.method !== EVT.groupChanged) return;
  const p = evt.payload as GroupChangedEvent;
  broadcast('hub:groupChanged', { groupId: p.groupId, kind: p.kind, nodeId: p.nodeId });
}
