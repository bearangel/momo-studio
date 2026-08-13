// electron/tests/p2p/local-transport.test.ts
//
// LocalTransport（C 子系统 C2）测试：
//   - start 后 discoverNodes 返回自身（唯一节点）
//   - send 自身节点 = 本地派发（onMessage 触发 + payload 一致）
//   - send 其他节点 = 抛错（local 传输仅支持发给自己）
//
// 不依赖网络/文件 IO，纯内存事件派发。
import { describe, it, expect } from 'vitest';
import { LocalTransport } from '../../src/main/p2p/local-transport';
import { generateIdentity } from '../../src/main/p2p/identity';
import type { IncomingMessage } from '../../src/main/p2p/types';

describe('LocalTransport', () => {
  it('start 后 discoverNodes 返回自身', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    const nodes = t.discoverNodes();
    expect(nodes.length).toBe(1);
    expect(nodes[0].nodeId).toBe(id.nodeId);
    // LocalTransport 仅在 discoverNodes 标记自身为 'local'（不在外部枚举 'lan'/'hub' 内）
    expect(nodes[0].transport).toBe('local');
    await t.stop();
  });

  it('send 自身节点 = 本地派发（onMessage 触发）', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    const received: IncomingMessage[] = [];
    t.onMessage((m) => received.push(m));
    await t.send(id.nodeId, { targetNodeId: id.nodeId, type: 'message', body: { text: 'self' } });
    expect(received.length).toBe(1);
    expect(received[0].fromNodeId).toBe(id.nodeId);
    expect(received[0].payload.body).toEqual({ text: 'self' });
    expect(received[0].receivedAt).toBeGreaterThan(0);
    await t.stop();
  });

  it('send 其他节点 = 抛错（local 仅支持自身）', async () => {
    const id = generateIdentity('me');
    const t = new LocalTransport(id);
    await t.start();
    await expect(
      t.send('node_other', { targetNodeId: 'node_other', type: 'message', body: {} }),
    // 大小写不敏感：实现抛 'LocalTransport 不支持...'，匹配 'local.*不支持'
    ).rejects.toThrow(/local.*不支持/i);
    await t.stop();
  });
});