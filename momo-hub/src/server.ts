// momo-hub/src/server.ts
//
// momo-hub——轻量级 WebSocket 中转服务器。
// 职责：
//   1. 节点连接认证（authToken）
//   2. 维护在线节点列表（presence）
//   3. 按 nodeId 路由消息（routing）
//   4. 离线消息临时缓存（TTL 7 天）
//
// 不持久化用户数据；hub 看到的所有 payload 都是 E2E 加密密文。
import { WebSocketServer, WebSocket } from 'ws';
import { handlePresence, registerSession, unregisterSession, getOnlineNodes, deliverTo } from './presence';
import { verifyAuthToken, rateLimiter } from './auth';

const PORT = parseInt(process.env.HUB_PORT ?? '8080', 10);
const wss = new WebSocketServer({ port: PORT });

console.log(`momo-hub listening on :${PORT}`);

wss.on('connection', (ws, req) => {
  let nodeId: string | null = null;

  ws.on('message', (raw) => {
    if (rateLimiter.isLimited(req.socket.remoteAddress ?? '')) {
      ws.send(JSON.stringify({ type: 'error', message: 'rate limited' }));
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      const verified = verifyAuthToken(msg.authToken as string);
      if (!verified) {
        ws.send(JSON.stringify({ type: 'error', message: 'auth failed' }));
        ws.close();
        return;
      }
      nodeId = msg.nodeId as string;
      registerSession(nodeId, ws, {
        boxPublicKey: (msg.boxPublicKey as string) ?? '',
        displayName: (msg.displayName as string) ?? 'Unknown',
      });
      // 推送当前在线列表
      ws.send(JSON.stringify({ type: 'presence', nodes: getOnlineNodes() }));
      // 广播新节点上线给其他在线节点
      handlePresence(nodeId);
    } else if (msg.type === 'send' && nodeId) {
      // 路由到目标节点
      const target = msg.to as string;
      const delivered = deliverTo(target, {
        type: 'deliver',
        from: nodeId,
        ciphertext: msg.ciphertext,
        nonce: msg.nonce,
      });
      if (!delivered) {
        // 离线缓存（TTL 7 天）
        // TODO: 写入 Redis 或 in-memory cache
        ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, delivered: false }));
      } else {
        ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, delivered: true }));
      }
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      unregisterSession(nodeId);
      handlePresence(nodeId);  // 通知其他节点此节点下线
    }
  });
});