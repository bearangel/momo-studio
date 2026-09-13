// electron/src/main/browser/policy.ts
//
// 浏览器工具策略层（纯逻辑，无 Electron 依赖）——信任门 / evaluate 门 / 域名策略 /
// file:// workspace 限定。BrowserManager 与 BrowserTools 的每次工具调用先过本层
//（spec 2026-09-11 §6 权限与安全）。真实 settings 读取器由 T6 注入（workspace_settings
// 六列）；本类只依赖闭包签名，单测用闭包构造。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import {
  BrowserDeniedError,
  BrowserDomainBlockedError,
  BrowserFileAccessError,
  BrowserNotTrustedError,
  BrowserProtocolError,
  EvaluateDisabledError,
} from './errors';
import type { WorkspaceBrowserSettings } from './types';

/** 视为本地 dev server 的主机名：http/https 恒放行，不受黑白名单约束（spec §6.3） */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 域名是否命中名单条目：精确匹配或子域匹配（x.evil.com 命中 evil.com；
 * notevil.com 不命中——dot 边界）。大小写不敏感。
 */
function domainMatches(hostname: string, entry: string): boolean {
  const h = hostname.toLowerCase();
  const e = entry.trim().toLowerCase();
  return h === e || h.endsWith(`.${e}`);
}

/** 通知推送钩子——构造注入（与 BrowserManagerHooks.pushNotice 同形态；缺省不推）。
 * workspaceId 缺省回退空串——main 端 push 链路在 BrowserPolicy 场景下恒有 wsId 上下文，
 * 透传给 renderer 信任卡路由用（spec §3.7 / v2.7 review M7）。 */
export type BrowserPolicyPushNotice = (kind: string, text: string, workspaceId: string) => void;

export class BrowserPolicy {
  /** 本会话已授权的 workspace（信任卡「本次会话允许」；按 workspace 隔离，app 生命周期内有效） */
  private sessionGranted = new Set<string>();

  constructor(
    private readSettings: (wsId: string) => WorkspaceBrowserSettings,
    private workspaceRoot: string,
    /** 可选信任门 notice 推送（boot 注入 manager.pushNotice 同源；缺省即静默，policy 不依赖 IPC 边界） */
    private pushNotice?: BrowserPolicyPushNotice,
  ) {}

  /**
   * 切换 file:// 边界根（T10 boot / workspace 切换钩子调用）：
   * 单 policy 实例服务全部 workspace，根必须跟随当前活跃 ws 的目录
   * （manager.onWorkspaceActivated 同步）。http(s) 域名策略不受影响。
   */
  setWorkspaceRoot(dir: string): void {
    this.workspaceRoot = dir;
  }

  /** 信任卡「本次会话允许」应答入口；幂等 */
  grantSession(wsId: string): void {
    this.sessionGranted.add(wsId);
  }

  /**
   * 信任门纯判定（N1）：读 settings + sessionGranted，零副作用（不推 notice、不抛错）。
   * 供 BrowserState.trusted 等只读推导（manager.isTrusted）——did-navigate /
   * page-title-updated 等状态推送高频走此路径，绝不触发信任卡。
   * 判定面与 assertAllowed 失败面同构（deny / ask 未授 → false）。
   */
  isAllowed(wsId: string): boolean {
    const settings = this.readSettings(wsId);
    if (settings.trust === 'deny') return false;
    if (settings.trust === 'ask' && !this.sessionGranted.has(wsId)) return false;
    // 'always' 或 'ask'+本会话已授权 → 放行
    return true;
  }

  /**
   * 信任门（spec §6.1 / §5.2 step 3）——agent 门（带副作用，仅工具执行路径使用）：
   *   deny → BrowserDeniedError（不推卡——用户主动拒绝的永久态）；
   *   ask 且本会话未授 → 推 trust-request notice 给 renderer 触发右下角信任卡，再抛 BrowserNotTrustedError；
   *   'always' 或 'ask'+本会话已授权 → 放行。
   * 推送与抛错的顺序契约：notice 必须在抛错前发出，否则 LLM 看到 BrowserNotTrustedError
   * 后无限重试，renderer 永远收不到卡、用户永远无法授权——review fix（C1）。
   * notice 携带 workspaceId（M7）：renderer 信任卡路由用，避免单活跃 ws 推导脆弱。
   */
  assertAllowed(wsId: string): void {
    if (this.isAllowed(wsId)) return;
    if (this.readSettings(wsId).trust === 'deny') throw new BrowserDeniedError();
    this.pushNotice?.('trust-request', 'agent 请求访问浏览器（请在右下角授权）', wsId);
    throw new BrowserNotTrustedError();
  }

  /** evaluate 门：browser_evaluate 默认关（spec §6.2），false 即拒绝 */
  assertEvaluate(wsId: string): void {
    if (!this.readSettings(wsId).evaluateEnabled) throw new EvaluateDisabledError();
  }

  /** 返回归一化 URL（file:// 转为绝对路径形式）；协议/域名/路径三检查 */
  assertUrl(wsId: string, rawUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BrowserProtocolError('非法 URL');
    }

    if (parsed.protocol === 'file:') {
      return this.assertFilePath(parsed);
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      this.assertDomain(wsId, parsed.hostname);
      return parsed.toString();
    }
    // ftp/javascript/data/chrome 等其余协议一律拒绝（spec §6.3）
    throw new BrowserProtocolError();
  }

  /**
   * 域名策略（spec §6.2）：localhost 恒放行（dev server 前提）；白名单优先于黑名单
   * （显式白名单命中压过黑名单）；黑名单命中即拒；白名单非空时仅白名单放行。
   */
  private assertDomain(wsId: string, hostname: string): void {
    if (LOCAL_HOSTNAMES.has(hostname.toLowerCase())) return;
    const { blacklist, whitelist } = this.readSettings(wsId);

    const whitelisted = whitelist.length > 0 && whitelist.some((e) => domainMatches(hostname, e));
    if (whitelisted) return; // 白名单优先：显式放行压过黑名单

    if (blacklist.some((e) => domainMatches(hostname, e))) {
      throw new BrowserDomainBlockedError(hostname);
    }
    if (whitelist.length > 0) {
      throw new BrowserDomainBlockedError(hostname); // 白名单非空 = 仅白名单放行
    }
  }

  /**
   * file:// 限定（spec §6.3 硬安全边界）：与 wsFs.assertInWorkspace 同源规则——
   * resolve 归一后 path.relative 判定必须落在 workspaceRoot 之下（拒 .. 越界）；
   * 最近存在祖先 realpath 反符号链接逃逸。通过则返回归一化 file:// 绝对 URL。
   */
  private assertFilePath(url: URL): string {
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      // 带远程 host / 非法 percent-encoding 的 file:// URL 无法映射本地路径
      throw new BrowserProtocolError('非法 file:// URL');
    }
    const root = path.resolve(this.workspaceRoot);
    const normalized = path.resolve(filePath);

    // 1) 字符串边界：resolve 已消除 .. 穿越与冗余段。isInsideDir 统一承载，
    //    语义覆盖原 relative 变体（rel === '..' 或 '..' + sep 前缀或异盘绝对
    //    形态，等价于 resolve 归一后不在 root 内），并接入 win32 大小写不敏感
    //    比对（PATH_SEMANTICS_WIN32 显式入口，随当前 path 模块语义分叉）。
    if (!isInsideDir(root, normalized, { win32: PATH_SEMANTICS_WIN32 })) {
      throw new BrowserFileAccessError();
    }

    // 2) 符号链接逃逸：向上找真实存在的最近祖先，realpath 解析后不得脱离 workspace
    //    真实根。逐级向上而非直接 realpath(normalized)，是为了支持尚未创建的文件
    //    路径（与 wsFs 同策）。
    const realRoot = fs.realpathSync(root);
    let anchor = normalized;
    while (anchor !== root && !fs.existsSync(anchor)) {
      anchor = path.dirname(anchor);
    }
    if (anchor !== root) {
      const realAnchor = fs.realpathSync(anchor);
      // 2) 锚定段同样走 isInsideDir（等价于原 realAnchor !== realRoot 且不
      //    startsWith(realRoot + sep) 的合取形态；win32 态大小写不敏感）
      if (!isInsideDir(realRoot, realAnchor, { win32: PATH_SEMANTICS_WIN32 })) {
        throw new BrowserFileAccessError();
      }
    }

    return pathToFileURL(normalized).href;
  }
}
