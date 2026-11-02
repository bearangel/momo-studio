// electron/tests/browser/policy-relative.test.ts
//
// policy 层与「工作空间相对路径 → 绝对 file:// URL」的衔接契约（spec 2026-11-02 §5.3）：
//   1. assertUrl 对 file 分支的返回值必须保留入参的 search / hash（否则 `a.html#p2`
//      端到端落到第 1 页——单测全绿而用户看不到的典型陷阱）
//   2. 越界 / 根不可访问两类 BrowserFileAccessError 文案必须带工作空间根与可执行建议
//   3. 边界判定仍只作用于 pathname：带 ?query#fragment 的越界 URL 照样拒绝
//
// 平台中立：不限 posix、不 mock process.platform，直接用真实 fs + mkdtemp。越界目标
// 用 tmpdir 下的绝对路径构造（不用 `file:///etc/passwd`——win32 的 fileURLToPath 会先
// 抛 BrowserProtocolError，越界文案根本走不到，用例会假红）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserPolicy } from '../../src/main/browser/policy';
import { BrowserFileAccessError } from '../../src/main/browser/errors';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';

const settings: WorkspaceBrowserSettings = {
  trust: 'always',
  evaluateEnabled: false,
  blacklist: [],
  whitelist: [],
};

describe('BrowserPolicy 与相对路径衔接（真实 fs，平台中立）', () => {
  let wsDir = '';
  const cleanup: string[] = [];

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-policy-rel-'));
    cleanup.push(wsDir);
  });
  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const mkPolicy = () => new BrowserPolicy(() => ({ ...settings }), wsDir);

  it('file:// 的 hash 与 query 在返回值中保留', () => {
    const page = path.join(wsDir, 'a.html');
    fs.writeFileSync(page, '<html></html>');
    const out = mkPolicy().assertUrl('ws1', `${pathToFileURL(page).href}?x=1#p2`);
    expect(out.endsWith('a.html?x=1#p2')).toBe(true);
    // 顺序锁：query 在 hash 前（URL 序列化语义，反了浏览器就不认）
    expect(out).toBe(`${pathToFileURL(page).href}?x=1#p2`);
  });

  it('只有 hash 时也保留（锚点导航的主用途）', () => {
    const page = path.join(wsDir, 'a.html');
    const out = mkPolicy().assertUrl('ws1', `${pathToFileURL(page).href}#p2`);
    expect(out.endsWith('#p2')).toBe(true);
  });

  it('越界错误文案含工作空间根与相对路径建议', () => {
    // 平台中立越界目标：绝对但不在 workspace 内
    const outside = path.resolve(os.tmpdir(), 'momo-policy-outside-test.html');
    const outsideUrl = pathToFileURL(outside).href;
    expect(() => mkPolicy().assertUrl('ws1', outsideUrl)).toThrow(BrowserFileAccessError);
    const err = (() => {
      try {
        mkPolicy().assertUrl('ws1', outsideUrl);
      } catch (e) {
        return e as Error;
      }
      throw new Error('应当抛出 BrowserFileAccessError');
    })();
    expect(err.message).toMatch(/工作空间根.*report\.html|report\.html.*工作空间根/s);
    // 根路径本身也要在文案里（LLM 需要知道边界在哪）
    expect(err.message).toContain(wsDir);
  });

  it('带 ?query#fragment 的越界 URL 仍拒绝（search/hash 不得掺进路径比对）', () => {
    const outside = path.resolve(os.tmpdir(), 'momo-policy-outside-test.html');
    const outsideUrl = `${pathToFileURL(outside).href}?x=1#p2`;
    expect(() => mkPolicy().assertUrl('ws1', outsideUrl)).toThrow(BrowserFileAccessError);
  });

  it('workspace 根不可访问的文案同样带根路径与相对路径建议', () => {
    const goneRoot = path.join(wsDir, 'deleted-root');
    fs.mkdirSync(goneRoot);
    fs.rmSync(goneRoot, { recursive: true, force: true });
    const p = new BrowserPolicy(() => ({ ...settings }), goneRoot);
    const inside = pathToFileURL(path.join(goneRoot, 'a.html')).href;
    expect(() => p.assertUrl('ws1', inside)).toThrow(/workspace 目录不可访问/);
    expect(() => p.assertUrl('ws1', inside)).toThrow(/report\.html/);
    expect(() => p.assertUrl('ws1', inside)).toThrow(
      new RegExp(goneRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});
