// electron/tests/browser/dev-server-probe.test.ts
//
// dev server 探活测试（v2.7 McpBrowser Task 10，spec §5.4）。
//
// 保真原则（momo-test-rules）：起**真 net.createServer** 两端口——
//   - A：收到数据回真实 HTTP 200 应答（模拟 vite dev server）
//   - B：裸 tcp 接受连接但永不应答（模拟被占用但非 HTTP 的端口）
// 断言只列 A。另覆盖 5xx / 连接拒绝两个排除路径（spec §13 风险表：
// 「端口被占用但非 http 服务」的误报防线——HEAD 校验）。
//
// 端口注入：probeDevServers(ports) 支持传入端口列表（生产缺省五端口），
// 测试用 listen(0) 的临时端口，不依赖特权端口可用性。

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { probeDevServers, DEV_SERVER_PORTS } from '../../src/main/browser/dev-server-probe';

/** 测试结束需要关闭的服务器集合 */
const servers: net.Server[] = [];

function closeAll(): void {
  for (const s of servers) s.close();
  servers.length = 0;
}
afterEach(closeAll);

/** 起一个应答指定 HTTP 状态行的服务器（Connection: close 单请求语义） */
function startHttpServer(statusLine: string): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      socket.end(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** 起一个裸 tcp 服务器：接受连接但不应答任何数据 */
function startBareTcpServer(): Promise<number> {
  const server = net.createServer(() => {
    // 刻意不写任何应答——占用端口但不是 HTTP 服务
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('probeDevServers', () => {
  it('缺省探测五端口 [5173,3000,8080,4200,8000]（spec §5.4 端口表）', async () => {
    // 无监听环境下全空——锁端口表本身（缺省形态契约）
    expect(DEV_SERVER_PORTS).toEqual([5173, 3000, 8080, 4200, 8000]);
    const result = await probeDevServers([]);
    expect(result).toEqual([]);
  });

  it('只列 HEAD 200 应答的端口；裸 tcp（接受连接不应答）不列', async () => {
    const httpPort = await startHttpServer('200 OK');
    const barePort = await startBareTcpServer();
    const result = await probeDevServers([httpPort, barePort]);
    expect(result).toEqual([{ port: httpPort, url: `http://localhost:${httpPort}` }]);
  });

  it('4xx 应答也列为存活（服务在跑且是 HTTP——404 只是路径语义）', async () => {
    const port = await startHttpServer('404 Not Found');
    const result = await probeDevServers([port]);
    expect(result).toEqual([{ port, url: `http://localhost:${port}` }]);
  });

  it('5xx 应答不列（服务在跑但已病态——spec「非 2xx/3xx/4xx 不列」）', async () => {
    const port = await startHttpServer('500 Internal Server Error');
    const result = await probeDevServers([port]);
    expect(result).toEqual([]);
  });

  it('无监听端口（ECONNREFUSED）不列也不抛错', async () => {
    // 临时占一个端口再关掉，拿到一个「大概率无人监听」的端口
    const holder = net.createServer();
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, '127.0.0.1', () => {
        const addr = holder.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    const result = await probeDevServers([port]);
    expect(result).toEqual([]);
  });

  it('3xx 应答列为存活（重定向也是健康 HTTP 服务）', async () => {
    const port = await startHttpServer('302 Found');
    const result = await probeDevServers([port]);
    expect(result).toEqual([{ port, url: `http://localhost:${port}` }]);
  });
});
