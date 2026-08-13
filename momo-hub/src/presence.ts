// momo-hub/src/presence.ts
//
// 在线节点管理——nodeId → WebSocket session 映射。
import { WebSocket } from 'ws';

interface Session {
  ws: WebSocket;
  boxPublicKey: string;
  displayName: string;
}

const sessions = new Map<string, Session>();

export function registerSession(nodeId: string, ws: WebSocket, info: { boxPublicKey: string; displayName: string }): void {
  sessions.set(nodeId, { ws, ...info });
}

export function unregisterSession(nodeId: string): void {
  sessions.delete(nodeId);
}

export function getOnlineNodes(): Array<{ nodeId: string; displayName: string; boxPublicKey: string }> {
  return Array.from(sessions.entries()).map(([nodeId, s]) => ({
    nodeId, displayName: s.displayName, boxPublicKey: s.boxPublicKey,
  }));
}

export function deliverTo(nodeId: string, msg: Record<string, unknown>): boolean {
  const session = sessions.get(nodeId);
  if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
  session.ws.send(JSON.stringify(msg));
  return true;
}

export function handlePresence(_nodeId: string): void {
  // 广播新 presence 给所有在线节点
  const nodes = getOnlineNodes();
  for (const session of sessions.values()) {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'presence', nodes }));
    }
  }
}