// electron/tests/browser/policy.test.ts
// 信任门阻塞等待语义（用户决定直接驱动 agent 走向）+ 会话授权 + 域名策略 + file://
// 限定（含 .. 与 symlink 逃逸）。BrowserPolicy 是纯逻辑（settings 读取器闭包注入）；
// file:// 用例需要真实 fs（realpath 反逃逸），用 os.tmpdir 建 workspace root。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPolicy, TRUST_WAIT_TIMEOUT_MS } from '../../src/main/browser/policy';
import type { WorkspaceBrowserSettings } from '../../src/main/browser/types';
import {
  BrowserNotTrustedError,
  BrowserDeniedError,
  BrowserTrustRefusedError,
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

describe('信任门（阻塞等待——用户决定直接驱动 agent 走向）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 排空一拍宏任务（含微任务队列）后断言仍未 settle：阻塞语义的核心形状 */
  async function assertPending(p: Promise<unknown>): Promise<void> {
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
  }

  describe('ask 未授 → 单飞阻塞等待', () => {
    it('返回 pending Promise（不 sync throw）+ 推一张卡（等待文案含 3 分钟有效期）', async () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      const gate = p.assertAllowed('ws1');
      expect(gate).toBeInstanceOf(Promise);
      await assertPending(gate);
      expect(pushNotice).toHaveBeenCalledTimes(1);
      expect(pushNotice).toHaveBeenCalledWith(
        'trust-request',
        'agent 请求访问浏览器——正在等待你授权（3 分钟内有效）',
        'ws1',
      );
      p.resolveTrustWait('ws1', 'deny'); // 收尾：终止等待，不留悬挂 timer
      await expect(gate).rejects.toThrow(BrowserTrustRefusedError);
    });

    it('pushNotice 缺省 → 挂起且不抛（policy 不依赖 IPC 边界——单测友好）', async () => {
      const p = mkPolicy();
      const gate = p.assertAllowed('ws1');
      await assertPending(gate);
      p.resolveTrustWait('ws1', 'deny');
      await expect(gate).rejects.toThrow(BrowserTrustRefusedError);
    });

    it('并发 3 个 assertAllowed → pushNotice 恰 1 次（单飞一张卡），allow 决定下三者全部 resolve', async () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      const gates = [p.assertAllowed('ws1'), p.assertAllowed('ws1'), p.assertAllowed('ws1')];
      expect(pushNotice).toHaveBeenCalledTimes(1);
      // 用户点「本次会话允许」→ answerTrust('session') 语义：grantSession + resolveTrustWait('allow')
      p.grantSession('ws1');
      p.resolveTrustWait('ws1', 'allow');
      await Promise.all(gates);
      expect(pushNotice).toHaveBeenCalledTimes(1);
    });

    it('并发 3 个 assertAllowed → deny 决定下三者全部 reject（同一决定统一 settle）', async () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      const gates = [p.assertAllowed('ws1'), p.assertAllowed('ws1'), p.assertAllowed('ws1')];
      expect(pushNotice).toHaveBeenCalledTimes(1);
      p.resolveTrustWait('ws1', 'deny');
      for (const g of gates) {
        await expect(g).rejects.toThrow('用户已拒绝本次浏览器授权');
      }
    });
  });

  describe('等待出口三态', () => {
    it('allow → 重验通过后 resolve（grantSession 已生效）', async () => {
      const p = mkPolicy();
      const gate = p.assertAllowed('ws1');
      p.grantSession('ws1');
      p.resolveTrustWait('ws1', 'allow');
      await expect(gate).resolves.toBeUndefined();
    });

    it('allow 但设置竞态变为 deny → reject BrowserNotTrustedError（重验防线）', async () => {
      let trust: 'ask' | 'deny' = 'ask';
      const p = new BrowserPolicy(() => ({ ...settings, trust }), '/ws/root');
      const gate = p.assertAllowed('ws1');
      p.grantSession('ws1');
      trust = 'deny'; // 用户点允许的同一时刻设置页被改为 deny
      p.resolveTrustWait('ws1', 'allow');
      await expect(gate).rejects.toThrow(BrowserNotTrustedError);
    });

    it('deny → reject BrowserTrustRefusedError（用户已拒绝——LLM 拿到明确事实）；code 消费字段', async () => {
      const p = mkPolicy();
      const gate = p.assertAllowed('ws1');
      p.resolveTrustWait('ws1', 'deny');
      const err = await gate.then(
        () => {
          throw new Error('应当 reject');
        },
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(BrowserTrustRefusedError);
      expect(err.message).toBe('用户已拒绝本次浏览器授权');
      expect((err as BrowserTrustRefusedError).code).toBe('trust_refused');
    });

    it('超时（TRUST_WAIT_TIMEOUT_MS=180s）→ reject 超时文案（设置/重试指引）+ pending 清空', async () => {
      vi.useFakeTimers();
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      expect(TRUST_WAIT_TIMEOUT_MS).toBe(180_000); // 导出常量锁（桥分档联动依赖该值）

      const gate = p.assertAllowed('ws1');
      await vi.advanceTimersByTimeAsync(179_999);
      let settled = false;
      void gate.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // 临界点前一毫秒仍在等待

      await vi.advanceTimersByTimeAsync(1);
      await expect(gate).rejects.toThrow('等待浏览器授权超时（3 分钟未应答）');
      await expect(gate).rejects.toThrow(/设置→浏览器/);

      // pending 清空：超时后新调用建新等待（再推一张卡），而非 join 已消散的 entry
      const gate2 = p.assertAllowed('ws1');
      expect(pushNotice).toHaveBeenCalledTimes(2);
      p.resolveTrustWait('ws1', 'deny');
      await expect(gate2).rejects.toThrow(BrowserTrustRefusedError);
    });
  });

  describe('迟到应答与等待生命周期', () => {
    it('迟到 resolveTrustWait 对无 pending 是 no-op：超时后补点卡 = 为下一次调用授权', async () => {
      vi.useFakeTimers();
      const p = mkPolicy();
      const gate = p.assertAllowed('ws1');
      // 预挂观察者：rejection 在推进计时器时发生，先附 handler 防 unhandledRejection 误报
      const observed = gate.then(
        () => {
          throw new Error('应当 reject');
        },
        (e: Error) => e,
      );
      await vi.advanceTimersByTimeAsync(TRUST_WAIT_TIMEOUT_MS);
      expect((await observed).message).toMatch(/超时/);

      // 用户在超时后才点「本次会话允许」：answerTrust 先 grantSession 再 resolveTrustWait
      expect(() => {
        p.grantSession('ws1');
        p.resolveTrustWait('ws1', 'allow');
      }).not.toThrow();
      // 授权已入账：下一次调用直接走快路径
      await expect(p.assertAllowed('ws1')).resolves.toBeUndefined();
    });

    it('pushNotice 抛错 → IPC 故障向上穿透（非信任错误）且不悬挂等待', async () => {
      let broken = true;
      const pushNotice = vi.fn(() => {
        if (broken) throw new Error('IPC 通道断');
      });
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      const err = await p.assertAllowed('ws1').then(
        () => {
          throw new Error('应当 reject');
        },
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/IPC 通道断/);
      expect(err).not.toBeInstanceOf(BrowserTrustRefusedError);
      expect(pushNotice).toHaveBeenCalledTimes(1);

      // 无悬挂 entry：恢复后再次调用重新推卡（若泄漏了 entry，本次会 join 而不推）
      broken = false;
      const gate2 = p.assertAllowed('ws1');
      expect(pushNotice).toHaveBeenCalledTimes(2);
      p.resolveTrustWait('ws1', 'deny');
      await expect(gate2).rejects.toThrow(BrowserTrustRefusedError);
    });
  });

  describe('快路径与回归', () => {
    it('ask 且本会话已授权 → 立即 resolve（零等待零推卡）；grantSession 幂等；ws 隔离', async () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      p.grantSession('ws1');
      p.grantSession('ws1'); // 幂等：重复授权不抛、不改变行为
      await expect(p.assertAllowed('ws1')).resolves.toBeUndefined();
      expect(pushNotice).not.toHaveBeenCalled();
      // 会话授权按 workspace 隔离：ws2 仍进入等待
      const gate2 = p.assertAllowed('ws2');
      await assertPending(gate2);
      p.resolveTrustWait('ws2', 'deny');
      await expect(gate2).rejects.toThrow(BrowserTrustRefusedError);
    });

    it('always → 立即放行；deny → 立即 reject BrowserDeniedError（不推卡不等待）', async () => {
      const pushAlways = vi.fn();
      const pAlways = new BrowserPolicy(() => ({ ...settings, trust: 'always' }), '/ws/root', pushAlways);
      await expect(pAlways.assertAllowed('ws1')).resolves.toBeUndefined();
      expect(pushAlways).not.toHaveBeenCalled();

      const pushDeny = vi.fn();
      const pDeny = new BrowserPolicy(() => ({ ...settings, trust: 'deny' }), '/ws/root', pushDeny);
      await expect(pDeny.assertAllowed('ws1')).rejects.toThrow(BrowserDeniedError);
      await expect(pDeny.assertAllowed('ws1')).rejects.toThrow(/设置→浏览器/);
      expect(pushDeny).not.toHaveBeenCalled();
    });

    it('等待中设置页改为 always → 新调用走快路径；挂起等待仍由点卡/超时收口（出口仅三态）', async () => {
      let trust: 'ask' | 'always' = 'ask';
      const p = new BrowserPolicy(() => ({ ...settings, trust }), '/ws/root');
      const gate = p.assertAllowed('ws1');
      await assertPending(gate);
      trust = 'always'; // 设置页直接改 always（不经信任卡）
      await expect(p.assertAllowed('ws1')).resolves.toBeUndefined();
      await assertPending(gate);
      p.resolveTrustWait('ws1', 'allow');
      await expect(gate).resolves.toBeUndefined();
    });
  });

  // N1：isAllowed 纯判定——BrowserState.trusted 推导面（manager.isTrusted 高频只读路径）
  describe('isAllowed 纯判定（N1）', () => {
    it('四态判定：ask 未授 / deny → false；ask 已授 / always → true；零副作用', () => {
      const pushNotice = vi.fn();
      const p = new BrowserPolicy(() => ({ ...settings }), '/ws/root', pushNotice);
      expect(p.isAllowed('ws1')).toBe(false);
      p.grantSession('ws1');
      expect(p.isAllowed('ws1')).toBe(true);
      // 会话授权按 workspace 隔离
      expect(p.isAllowed('ws2')).toBe(false);
      expect(new BrowserPolicy(() => ({ ...settings, trust: 'always' }), '/ws/root', pushNotice).isAllowed('ws1')).toBe(true);
      expect(new BrowserPolicy(() => ({ ...settings, trust: 'deny' }), '/ws/root', pushNotice).isAllowed('ws1')).toBe(false);
      expect(pushNotice).not.toHaveBeenCalled();
    });

    it('判定面与等待面同构：isAllowed=true ⟹ 立即 resolve；false ⟹ 绝不 resolve 成功', async () => {
      const cases: BrowserPolicy[] = [
        mkPolicy({ trust: 'ask' }),
        mkPolicy({ trust: 'always' }),
        mkPolicy({ trust: 'deny' }),
      ];
      const granted = mkPolicy();
      granted.grantSession('ws1');
      cases.push(granted);
      for (const p of cases) {
        let resolved = false;
        const gate = p.assertAllowed('ws1');
        void gate.then(
          () => {
            resolved = true;
          },
          () => {},
        );
        await new Promise<void>((r) => setImmediate(r));
        expect(resolved).toBe(p.isAllowed('ws1'));
        p.resolveTrustWait('ws1', 'deny'); // 收尾挂起的等待（对已 settle 的 entry 是 no-op）
        await Promise.resolve();
      }
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

    it('workspace 根目录不存在（如运行中被删）→ BrowserFileAccessError 而非裸 ENOENT 逃逸（审查 Nit）', () => {
      const goneRoot = path.join(tmpRoot, 'deleted-root');
      fs.mkdirSync(goneRoot);
      fs.rmSync(goneRoot, { recursive: true, force: true });
      const p = new BrowserPolicy(() => ({ ...settings }), goneRoot);
      // URL 字符串边界在根内（走到 realpath 步骤），但根已不存在
      const inside = pathToFileURL(path.join(goneRoot, 'a.html')).href;
      expect(() => p.assertUrl('ws1', inside)).toThrow(BrowserFileAccessError);
      expect(() => p.assertUrl('ws1', inside)).toThrow(/workspace 目录不可访问/);
      expect(() => p.assertUrl('ws1', inside)).toThrow(new RegExp(goneRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
