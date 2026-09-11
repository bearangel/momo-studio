// electron/tests/browser/policy.test.ts
// 信任门三分支 + 会话授权 + 域名策略 + file:// 限定（含 .. 与 symlink 逃逸）+ 信任门
// notice 推送契约（C1 review fix）。
// BrowserPolicy 是纯逻辑（settings 读取器闭包注入）；file:// 用例需要真实 fs
// （realpath 反逃逸），用 os.tmpdir 建 workspace root。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPolicy } from '../../src/main/browser/policy';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';
import {
  BrowserNotTrustedError,
  BrowserDeniedError,
  EvaluateDisabledError,
  BrowserFileAccessError,
  BrowserDomainBlockedError,
  BrowserProtocolError,
} from '../../src/main/browser/errors';

const settings = { trust: 'ask' as const, evaluateEnabled: false, blacklist: ['evil.com'], whitelist: [] as string[] };
// over 用真实设置接口定型（typeof settings 的 trust 会被 'ask' as const 收窄成字面量，
// 传 'always'/'deny' 无法通过——brief 骨架自带矛盾，以真实契约为准）
const mkPolicy = (over: Partial<WorkspaceBrowserSettings> = {}) =>
  new BrowserPolicy(() => ({ ...settings, ...over }), '/ws/root');

describe('信任门', () => {
  it('ask 且未授权 → 抛 BrowserNotTrustedError（含「授权后重试」指引）', () => {
    expect(() => mkPolicy().assertAllowed('ws1')).toThrow(BrowserNotTrustedError);
    expect(() => mkPolicy().assertAllowed('ws1')).toThrow(/授权后重试/);
    // code 供 UI/日志分类（消费字段断言，非占位符）
    expect(new BrowserNotTrustedError().code).toBe('not_trusted');
  });

  it('ask 但本会话已授权 → 放行；grantSession 幂等', () => {
    const p = mkPolicy();
    p.grantSession('ws1');
    p.grantSession('ws1'); // 幂等：重复授权不抛、不改变行为
    expect(() => p.assertAllowed('ws1')).not.toThrow();
    // 会话授权按 workspace 隔离：ws2 仍未授权
    expect(() => p.assertAllowed('ws2')).toThrow(BrowserNotTrustedError);
  });

  it('always → 放行；deny → BrowserDeniedError 含设置指引', () => {
    expect(() => mkPolicy({ trust: 'always' }).assertAllowed('ws1')).not.toThrow();
    expect(() => mkPolicy({ trust: 'deny' }).assertAllowed('ws1')).toThrow(BrowserDeniedError);
    expect(() => mkPolicy({ trust: 'deny' }).assertAllowed('ws1')).toThrow(/设置→浏览器/);
  });

  // C1 review fix：信任门 notice 推送契约——spec §5.2 step 3 要求 ask 未授抛错前
  // 必须推 trust-request notice，否则 renderer 信任卡永不弹出，LLM 永久重试。
  describe('信任门 notice 推送（C1 review fix）', () => {
    it('pushNotice 缺省 → 不抛错且不推（policy 不依赖 IPC 边界——单测友好）', () => {
      const p = mkPolicy();
      expect(() => p.assertAllowed('ws1')).toThrow(BrowserNotTrustedError);
    });

    it('ask 且未授权 → pushNotice 在抛错前推一次「trust-request」+ 中性指引', () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(
        () => ({ ...settings }),
        '/ws/root',
        pushNotice,
      );
      expect(() => p.assertAllowed('ws1')).toThrow(BrowserNotTrustedError);
      // 关键顺序契约：notice 必须在抛错前发出（一次）；载荷携带 wsId（M7 路由）
      expect(pushNotice).toHaveBeenCalledTimes(1);
      expect(pushNotice).toHaveBeenCalledWith(
        'trust-request',
        expect.stringContaining('agent 请求'),
        'ws1',
      );
    });

    it('ask 且本会话已授权 → 不推 notice（已授权路径不应再骚扰用户）', () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      p.grantSession('ws1');
      expect(() => p.assertAllowed('ws1')).not.toThrow();
      expect(pushNotice).not.toHaveBeenCalled();
    });

    it('always / deny 分支 → 不推 trust-request（仅 ask 未授权路径触发）', () => {
      const pushAlways = vi.fn();
      const pAlways = new BrowserPolicy(
        () => ({ ...settings, trust: 'always' }),
        '/ws/root',
        pushAlways,
      );
      expect(() => pAlways.assertAllowed('ws1')).not.toThrow();
      expect(pushAlways).not.toHaveBeenCalled();

      const pushDeny = vi.fn();
      const pDeny = new BrowserPolicy(
        () => ({ ...settings, trust: 'deny' }),
        '/ws/root',
        pushDeny,
      );
      expect(() => pDeny.assertAllowed('ws1')).toThrow(BrowserDeniedError);
      expect(pushDeny).not.toHaveBeenCalled();
    });

    it('pushNotice 抛错 → IPC 故障向上穿透（不静默吞：渲染通道异常必须可见）', () => {
      // 契约：pushNotice 自身抛错不掩盖——IPC 通道断连是真实故障，必须向上穿透到上层
      // （tool execute / LLM 看到 IPC error 而非 BrowserNotTrustedError），便于诊断与告警。
      // 若静默吞回退到 BrowserNotTrustedError，会复现 C1 现象：用户永远看不到卡、LLM
      // 永久重试——这正是 review fix 要消除的反向回归。
      const pushNotice = vi.fn(() => {
        throw new Error('IPC 通道断');
      });
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      let caught: unknown = null;
      try {
        p.assertAllowed('ws1');
      } catch (e) {
        caught = e;
      }
      // IPC 错误向上穿透——不是 BrowserNotTrustedError
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/IPC 通道断/);
      expect(caught).not.toBeInstanceOf(BrowserNotTrustedError);
      expect(pushNotice).toHaveBeenCalledTimes(1);
    });
  });
});

describe('evaluate 门', () => {
  it('evaluateEnabled false → EvaluateDisabledError；true → 放行', () => {
    expect(() => mkPolicy().assertEvaluate('ws1')).toThrow(EvaluateDisabledError);
    expect(() => mkPolicy({ evaluateEnabled: true }).assertEvaluate('ws1')).not.toThrow();
  });
});

describe('URL 策略 assertUrl', () => {
  it('http/https localhost 放行（dev server 前提）', () => {
    expect(mkPolicy().assertUrl('ws1', 'http://localhost:5173')).toBe('http://localhost:5173/');
    expect(() => mkPolicy().assertUrl('ws1', 'https://localhost:3000')).not.toThrow();
    // 环回地址同属 dev server 前提
    expect(() => mkPolicy().assertUrl('ws1', 'http://127.0.0.1:5173')).not.toThrow();
    // localhost 恒放行：即便被显式拉黑（「either way」语义）
    expect(() => mkPolicy({ blacklist: ['localhost'] }).assertUrl('ws1', 'http://localhost:5173')).not.toThrow();
  });

  it('黑名单域名（含子域 evil.com/x.evil.com）→ BrowserDomainBlockedError', () => {
    expect(() => mkPolicy().assertUrl('ws1', 'http://evil.com')).toThrow(BrowserDomainBlockedError);
    // 信息含被拦截域名（agent 需要知道哪个域名被拦）
    expect(() => mkPolicy().assertUrl('ws1', 'http://evil.com')).toThrow(/evil\.com/);
    expect(() => mkPolicy().assertUrl('ws1', 'https://x.evil.com/login')).toThrow(BrowserDomainBlockedError);
    // 子域匹配有 dot 边界：notevil.com 不命中 evil.com；无关域名不受影响
    expect(() => mkPolicy().assertUrl('ws1', 'http://notevil.com')).not.toThrow();
    expect(() => mkPolicy().assertUrl('ws1', 'http://good.com')).not.toThrow();
  });

  it('白名单非空时仅白名单放行', () => {
    const p = mkPolicy({ whitelist: ['good.com'] });
    expect(p.assertUrl('ws1', 'https://good.com')).toBe('https://good.com/');
    expect(() => p.assertUrl('ws1', 'https://other.com')).toThrow(BrowserDomainBlockedError);
    // localhost 不受白名单限制（dev server 前提恒放行）
    expect(() => p.assertUrl('ws1', 'http://localhost:5173')).not.toThrow();
    // 白名单优先于黑名单：显式白名单命中压过黑名单
    const both = mkPolicy({ whitelist: ['evil.com'] });
    expect(() => both.assertUrl('ws1', 'https://evil.com')).not.toThrow();
  });

  describe('file:// workspace 限定', () => {
    // realpath 反逃逸需要真实 fs：tmp workspace root + ws 外目录，用例结束逐个清理
    let tmpRoot = '';
    const cleanup: string[] = [];

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-browser-policy-'));
      cleanup.push(tmpRoot);
    });
    afterEach(() => {
      for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });
    const mkFilePolicy = () => new BrowserPolicy(() => ({ ...settings }), tmpRoot);

    it('file:// 在 workspace 内放行，返回归一化 file:// URL', () => {
      const page = path.join(tmpRoot, 'index.html');
      fs.writeFileSync(page, '<html></html>');
      const p = mkFilePolicy();
      expect(p.assertUrl('ws1', pathToFileURL(page).href)).toBe(pathToFileURL(page).href);
      // 尚未创建的 workspace 内路径同样放行（字符串边界已保证越界不可能，与 wsFs 同策）
      const unborn = path.join(tmpRoot, 'not-yet.html');
      expect(p.assertUrl('ws1', pathToFileURL(unborn).href)).toBe(pathToFileURL(unborn).href);
    });

    it('file:// 带 .. 越界 / 指向 workspace 外 → BrowserFileAccessError', () => {
      const p = mkFilePolicy();
      // .. 归一后落在 workspace 外
      const dotdot = pathToFileURL(path.join(tmpRoot, '..', 'outside.html')).href;
      expect(() => p.assertUrl('ws1', dotdot)).toThrow(BrowserFileAccessError);
      // 直接绝对路径指向 workspace 外
      expect(() => p.assertUrl('ws1', 'file:///etc/passwd')).toThrow(BrowserFileAccessError);
      // dot 边界：名为 '..foo.html' 的 workspace 内合法文件不得被 '..' 前缀误伤
      const tricky = path.join(tmpRoot, '..foo.html');
      expect(p.assertUrl('ws1', pathToFileURL(tricky).href)).toBe(pathToFileURL(tricky).href);
    });

    it('file:// 带远程 host → BrowserProtocolError（非法 file:// URL，无法映射本地路径）', () => {
      // fileURLToPath 对非 localhost host 抛错——file://example.com/share/x 是远程文件语义
      // （SMB / WebDAV / UNC 残影），一律拒绝；信息区分于「协议不支持」
      const p = mkFilePolicy();
      expect(() => p.assertUrl('ws1', 'file://example.com/share/x')).toThrow(BrowserProtocolError);
      expect(() => p.assertUrl('ws1', 'file://example.com/share/x')).toThrow(/非法 file:\/\/ URL/);
    });

    it('symlink 逃逸（realpath 在 workspace 外）→ BrowserFileAccessError', () => {
      // 用 os.tmpdir 真建 symlink：ws 内 link → ws 外 target
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-outside-'));
      cleanup.push(outsideDir);
      const target = path.join(outsideDir, 'secret.html');
      fs.writeFileSync(target, '<html></html>');
      const link = path.join(tmpRoot, 'escape.html');
      fs.symlinkSync(target, link);
      // 字符串边界在 workspace 内，但 realpath 解析到外部 → 拦截
      expect(() => mkFilePolicy().assertUrl('ws1', pathToFileURL(link).href)).toThrow(BrowserFileAccessError);
    });

    it('setWorkspaceRoot：切换后 file:// 边界跟随新根（T10 动态根接线）', () => {
      const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-browser-policy2-'));
      cleanup.push(otherRoot);
      const p = mkFilePolicy();
      // 新根内的文件在旧根语义下越界
      const otherFile = path.join(otherRoot, 'a.html');
      fs.writeFileSync(otherFile, '<html></html>');
      expect(() => p.assertUrl('ws1', pathToFileURL(otherFile).href)).toThrow(BrowserFileAccessError);
      // 切根后放行；旧根内文件反而越界（file:// 永远限定当前活跃 workspace）
      p.setWorkspaceRoot(otherRoot);
      expect(p.assertUrl('ws1', pathToFileURL(otherFile).href)).toBe(pathToFileURL(otherFile).href);
      const oldFile = path.join(tmpRoot, 'index.html');
      expect(() => p.assertUrl('ws1', pathToFileURL(oldFile).href)).toThrow(BrowserFileAccessError);
    });
  });

  it('ftp/javascript/data 等协议 → BrowserProtocolError', () => {
    expect(() => mkPolicy().assertUrl('ws1', 'ftp://example.com/file')).toThrow(BrowserProtocolError);
    expect(() => mkPolicy().assertUrl('ws1', 'javascript:alert(1)')).toThrow(BrowserProtocolError);
    expect(() => mkPolicy().assertUrl('ws1', 'data:text/html,<p>hi</p>')).toThrow(BrowserProtocolError);
    expect(() => mkPolicy().assertUrl('ws1', 'chrome://settings')).toThrow(BrowserProtocolError);
    // 无法解析的裸串 → 非法 URL（信息区分于「协议不支持」）
    expect(() => mkPolicy().assertUrl('ws1', 'not a url')).toThrow(BrowserProtocolError);
    expect(() => mkPolicy().assertUrl('ws1', 'not a url')).toThrow(/非法 URL/);
  });
});
