// electron/tests/browser/protocol.win32.test.ts
//
// browser-shot:// 协议边界（v2.10 T2：:70 手工 startsWith 锚定统一换
// isInsideDir——T1 review 裁定的第六模块）win32 语义测试。
// 模板来源：tests/platform/paths.win32.test.ts 文件头。
//
// 说明：safeSegments 已在 URL 段清洗层拒绝 '..' / 反斜杠 / 空段，:70 边界
// 是纵深防御第二道闸——可达输入（wsRoot + 干净段 resolve）恒在界内。本文件
// 锁 win32 形态（反斜杠目录树 / host 大小写）下的正向行为与既有 403/404
// 契约；协议行为全量由 protocol.test.ts 既有 posix 用例覆盖。
//
// mock 策略：
//   - node:path → win32（模板）
//   - node:fs → 仅 statSync / readFileSync 两个触点，按键大小写不敏感命中
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stats } from 'node:fs';
import { registerBrowserShotProtocol } from '../../src/main/browser/protocol';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const FILE = 'C:\\shots\\ws1\\sub\\a.png';
  const lowerFile = FILE.toLowerCase();
  const stats = { isFile: () => true } as unknown as Stats;
  return {
    default: {
      ...actual,
      statSync: (p: string): Stats => {
        if (typeof p === 'string' && p.toLowerCase() === lowerFile) return stats;
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
      readFileSync: (p: string): Buffer => {
        if (typeof p === 'string' && p.toLowerCase() === lowerFile) {
          return Buffer.from('fake-png-win32');
        }
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
    },
  };
});

let handler: ((req: { url: string }) => Promise<Response>) | undefined;

beforeEach(() => {
  handler = undefined;
  registerBrowserShotProtocol(
    {
      handle: (_scheme, fn) => {
        handler = fn as typeof handler;
      },
    },
    'C:\\shots',
  );
});

function fetchShot(url: string): Promise<Response> {
  if (!handler) throw new Error('handler 未注册');
  return handler({ url });
}

describe('registerBrowserShotProtocol（win32 语义）', () => {
  it('win32 反斜杠目录树命中：返回图片字节', async () => {
    const res = await fetchShot('browser-shot://ws1/sub/a.png');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('fake-png-win32');
  });

  it('host 大小写变体（URL host 归一小写）同样命中', async () => {
    const res = await fetchShot('browser-shot://WS1/sub/a.png');
    expect(res.status).toBe(200);
  });

  it('编码分隔符的 .. 穿越段（..%2F 形态）→ 403', async () => {
    // 纯 %2E%2E 段会被 WHATWG URL 在解析期识别为 dot 段并归一（到不了
    // handler）；只有「字面 .. + 编码分隔符」形态原样透传，由 safeSegments 拦
    // （与 protocol.test.ts 既有穿越向量同构）
    const res = await fetchShot('browser-shot://ws1/..%2Fws1/sub/a.png');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('拒绝');
  });

  it('文件不存在 → 404', async () => {
    const res = await fetchShot('browser-shot://ws1/sub/missing.png');
    expect(res.status).toBe(404);
  });
});
