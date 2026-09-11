// electron/tests/browser/protocol.test.ts
//
// browser-shot:// 自定义协议测试（v2.7 McpBrowser Task 10，spec §3.7/§12.3）。
//
// `browser-shot://<wsId>/<file>` → `<screenshotDir>/<wsId>/<file>` 文件字节。
// 安全边界：路径穿越（`..` / URL 编码穿越 / 绝对路径注入）→ 403 风格拒绝；
// 文件不存在 → 404。protocol 经结构性注入（生产传 electron protocol，测试传捕获桩）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBrowserShotProtocol, BROWSER_SHOT_SCHEME } from '../../src/main/browser/protocol';

let root: string;
/** protocol.handle 捕获桩：scheme → handler */
let handler: ((req: { url: string }) => Promise<Response>) | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-browser-shot-'));
  handler = undefined;
  registerBrowserShotProtocol(
    {
      handle: (_scheme, fn) => {
        handler = fn as typeof handler;
      },
    },
    root,
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 直呼捕获的 handler（模拟 Chromium 发起的协议请求） */
function fetchShot(url: string): Promise<Response> {
  if (!handler) throw new Error('handler 未注册');
  return handler({ url });
}

describe('registerBrowserShotProtocol', () => {
  it('注册 scheme 常量为 browser-shot（preload/引用方契约）', () => {
    expect(BROWSER_SHOT_SCHEME).toBe('browser-shot');
    expect(handler).toBeTypeOf('function');
  });

  it('合法文件返回原始字节', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    fs.mkdirSync(path.join(root, 'ws-1'));
    fs.writeFileSync(path.join(root, 'ws-1', 'shot-a.png'), bytes);
    const res = await fetchShot('browser-shot://ws-1/shot-a.png');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('嵌套子目录文件合法（filename 含路径分隔的生产形态）', async () => {
    const bytes = Buffer.from('nested');
    fs.mkdirSync(path.join(root, 'ws-1', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ws-1', 'sub', 'x.png'), bytes);
    const res = await fetchShot('browser-shot://ws-1/sub/x.png');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
  });

  it('路径穿越 `..` → 403 且不读盘', async () => {
    // 先在 root 外放一个诱惑文件——穿越若未被拦会读到它
    const outside = path.join(path.dirname(root), 'evil-marker.txt');
    fs.writeFileSync(outside, 'secret');
    try {
      const res = await fetchShot(`browser-shot://ws-1/..%2F..%2F${path.basename(root)}/evil-marker.txt`);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('拒绝');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('明文 .. 段被 WHATWG URL 归一化收纳在 ws 目录内（永不逃逸）', async () => {
    // new URL 把 `/../ws-2/secret.png` 归一化为 `/ws-2/secret.png`——穿越段在
    // URL 空间即被收纳（指向 ws-1 内的 ws-2/ 子路径，不可能越出 wsRoot），
    // 文件不存在 → 404。编码形态（%2e%2e）才原样到达 handler，由上面用例拦 403。
    const res = await fetchShot('browser-shot://ws-1/../ws-2/secret.png');
    expect(res.status).toBe(404);
  });

  it('文件不存在 → 404', async () => {
    const res = await fetchShot('browser-shot://ws-1/missing.png');
    expect(res.status).toBe(404);
  });

  it('空 wsId（host 为空）→ 403', async () => {
    const res = await fetchShot('browser-shot:///etc/passwd');
    expect(res.status).toBe(403);
  });
});
