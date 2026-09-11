// electron/src/main/browser/dev-server-probe.ts
//
// dev server 探活（v2.7 McpBrowser Task 10，spec §5.4 / §13）。
//
// sidebar 探活下拉打开 → IPC browser:listDevServers → 本模块：
//   1. 对候选端口 net.connect 试连（~100ms 超时）——纯 TCP 层存活判定
//   2. 存活者发 HTTP HEAD 校验——端口被占用但非 HTTP 服务（误报防线，spec §13）
//      只列 2xx/3xx/4xx 应答（5xx = 服务病态；无 HTTP 应答 = 非 HTTP 占用）
//
// agent 侧无需代码：bash 输出的 vite banner 由 LLM 阅读后自行 navigate。
// 纯 Node 模块（零 Electron import），单测直接驱动。

import net from 'node:net';

/** 候选端口表（spec §5.4：vite 5173 / node 3000 / 常见 8080 / ng 4200 / django 8000） */
export const DEV_SERVER_PORTS: readonly number[] = [5173, 3000, 8080, 4200, 8000];

/** TCP 试连超时（毫秒）——spec「~100ms」 */
const CONNECT_TIMEOUT_MS = 100;

/** HEAD 应答等待超时（毫秒）——裸 tcp 占用者永不应答，必须超时排除 */
const HEAD_TIMEOUT_MS = 500;

/** 探活结果：存活端口 + 可直开 URL（点击即 userNavigate） */
export interface DevServerProbeResult {
  port: number;
  url: string;
}

/**
 * TCP 试连：成功建立连接 → true；连接拒绝 / 超时 → false（绝不 reject——
 * 单端口失败是探活的正常分支，不是错误）。
 */
function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * HEAD 校验：在存活端口上发 `HEAD /`，等待任何 HTTP 应答字节并解析状态行。
 *   - 2xx/3xx/4xx → true（健康 HTTP 服务；4xx 只是路径语义，服务在跑）
 *   - 5xx / 非 HTTP 应答 / 超时无应答 → false
 */
function headProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(HEAD_TIMEOUT_MS, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      socket.write('HEAD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    });
    socket.once('data', (chunk: Buffer) => {
      // 状态行形如 `HTTP/1.1 200 OK`——解析首行数字部分
      const head = chunk.toString('latin1');
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
      if (!match || !match[1]) {
        finish(false); // 非 HTTP 应答（私有协议占用端口）
        return;
      }
      const status = Number(match[1]);
      finish(status >= 200 && status < 500);
    });
  });
}

/**
 * 探活入口（IPC browser:listDevServers 消费点）。
 * ports 参数供测试注入临时端口；生产缺省五端口表。
 */
export async function probeDevServers(ports: readonly number[] = DEV_SERVER_PORTS): Promise<DevServerProbeResult[]> {
  // 阶段 1：并发 TCP 试连（每个独立 100ms 超时，互不阻塞）
  const tcpAlive = await Promise.all(
    ports.map(async (port) => ({ port, alive: await tcpProbe(port) })),
  );
  // 阶段 2：存活者并发 HEAD 校验
  const verified = await Promise.all(
    tcpAlive
      .filter((p) => p.alive)
      .map(async (p) => ({ port: p.port, http: await headProbe(p.port) })),
  );
  return verified
    .filter((p) => p.http)
    .map((p) => ({ port: p.port, url: `http://localhost:${p.port}` }));
}
