// electron/src/main/browser/ipc.ts
//
// 浏览器命名空间 IPC（v2.7 McpBrowser Task 7，spec §3.6 通道表 + T7 的
// browser:updateSettings + T9 的 browser:getSettings / browser:clearBrowsingData，
// 共 14 个 r→m invoke 通道）+ m→r 统一推送接线
// （browser:state / browser:notice）。
//
// 依赖全部注入（零 electron import——T10 boot 传真 ipcMain / win.webContents，
// 单测传捕获桩）：manager / policy（answerTrust 的 grantSession 在 policy 上）/
// store（answerTrust always 与折叠态落库）/ probeDevServers（T10 才有真实现，
// 此处只依赖函数签名——测试注入 mock）。
//
// 统一状态推送：manager 的 pushState/pushNotice 钩子经 createBrowserPushHooks
// 接到 webContentsLike.send——boot 组装序为「先 createBrowserPushHooks(webContents)
// 构造 manager，再 registerBrowserIpc(...)"（钩子是构造注入，注册函数不回填）。
//
// IPC 无类型边界防线（momo-boundary-rules + T6 review Important 裁定）：
//   - 各通道入参做最小运行时校验（字符串/数字/布尔/rect 四数字），非法值抛
//     中文 Error（invoke 拒绝，UI 直接呈现）；
//   - browser:updateSettings 做专项净化（构造 patch 跳过 undefined 键、
//     名单非数组丢弃该键 + warn），净化后仍可能的异常（非法 trust 枚举由
//     store.write fail-fast 抛出）包装为 { ok:false, error } 结构化返回——
//     IPC 边界不裸抛，错误文案面向用户中文呈现。

import { logger } from '../logger';
import type { BrowserManager, BrowserManagerHooks, SidebarRect } from './manager';
import type { BrowserPolicy } from './policy';
import type { BrowserSettingsPatch, BrowserSettingsStore } from './settings-store';

/** dev server 探活结果（T10 dev-server-probe.ts 生产；端口 + 可直开 URL） */
export interface BrowserDevServer {
  port: number;
  url: string;
}

/** 探活函数依赖签名（注入点：测试 mock / T10 真实现） */
export type ProbeDevServers = () => Promise<BrowserDevServer[]>;

/** m→r 非模态通知载荷（spec §3.7：信任卡 kind='trust-request'）。
 * workspaceId 是发送方所在的 workspace（v2.7 review M7）——renderer 信任卡按该字段路由
 * 应答目标，不再脆弱地依赖「单活跃 workspace」推导。 */
export interface BrowserNotice {
  kind: string;
  text: string;
  workspaceId: string;
}

/** ipcMain 的结构性子集（注入——生产传 electron ipcMain，测试传捕获桩） */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** webContents 的结构性子集（注入——生产传 win.webContents，测试传捕获桩） */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

/** registerBrowserIpc 依赖集（全部构造注入，零全局单例） */
export interface BrowserIpcDeps {
  manager: BrowserManager;
  policy: BrowserPolicy;
  store: BrowserSettingsStore;
  /** T10 前由测试注入 mock；T10 boot 接 dev-server-probe 真实现 */
  probeDevServers: ProbeDevServers;
}

/** updateSettings 结构化返回：成功 / 失败（中文错误，IPC 边界不裸抛） */
export type BrowserUpdateSettingsResult = { ok: true } | { ok: false; error: string };

// =================================================================================
// 入参运行时校验（IPC 无类型边界——renderer 侧类型不越界到此）
// =================================================================================

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`参数 ${what} 必须为字符串`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`参数 ${what} 必须为有限数字`);
  }
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`参数 ${what} 必须为布尔值`);
  return value;
}

/** sidebar 占位区 rect：x/y/width/height 四数字（与 Electron setBounds 同构） */
function asSidebarRect(value: unknown): SidebarRect {
  if (typeof value !== 'object' || value === null) {
    throw new Error('browser:setSidebarBounds 参数 rect 需含 x/y/width/height 四个数字');
  }
  const o = value as Record<string, unknown>;
  const x = o.x;
  const y = o.y;
  const width = o.width;
  const height = o.height;
  if (
    typeof x !== 'number' || typeof y !== 'number' ||
    typeof width !== 'number' || typeof height !== 'number'
  ) {
    throw new Error('browser:setSidebarBounds 参数 rect 需含 x/y/width/height 四个数字');
  }
  return { x, y, width, height };
}

// =================================================================================
// updateSettings 净化（T6 review Important，硬性项）
// =================================================================================

/** 允许写入的设置键（与 BrowserSettings 六字段一一对应，未知键一律丢弃） */
const PATCH_KEYS = [
  'trust',
  'evaluateEnabled',
  'blacklist',
  'whitelist',
  'sidebarCollapsed',
  'sidebarWidth',
] as const;

/**
 * patch 净化规则（测试锁定）：
 *   - 非对象 → 空 patch（后续 write 等价于「读改写既有值」，无副作用）
 *   - 显式 undefined 值 → 跳过该键（防 undefined 合并进名单列触发
 *     normalizeDomainList 的英文 TypeError）
 *   - blacklist/whitelist 非数组 → 丢弃该键 + warn（其余键仍生效）
 *   - sidebarWidth 非数字 / 布尔键非布尔 → 丢弃该键 + warn
 *   - trust 原样透传——store.write 的枚举校验是唯一写侧防线（非法值 fail-fast
 *     抛中文错误，由 handler 包装为 { ok:false } 结构化返回）
 */
function sanitizeSettingsPatch(raw: unknown): BrowserSettingsPatch {
  const patch: BrowserSettingsPatch = {};
  if (typeof raw !== 'object' || raw === null) return patch;
  const src = raw as Record<string, unknown>;
  for (const key of PATCH_KEYS) {
    const value = src[key];
    if (value === undefined) continue; // 显式 undefined → 不覆盖既有值
    if (key === 'blacklist' || key === 'whitelist') {
      if (!Array.isArray(value)) {
        logger.warn('browser:updateSettings 名单字段非数组，丢弃该键', { key });
        continue;
      }
      patch[key] = value as string[];
      continue;
    }
    if (key === 'trust') {
      patch.trust = value as BrowserSettingsPatch['trust']; // 枚举校验由 store 兜底
      continue;
    }
    if (key === 'evaluateEnabled' || key === 'sidebarCollapsed') {
      if (typeof value !== 'boolean') {
        logger.warn('browser:updateSettings 布尔字段类型不符，丢弃该键', { key });
        continue;
      }
      patch[key] = value;
      continue;
    }
    // sidebarWidth
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      logger.warn('browser:updateSettings sidebarWidth 非数字，丢弃该键', { key });
      continue;
    }
    patch.sidebarWidth = value;
  }
  return patch;
}

// =================================================================================
// 统一推送钩子（manager 构造注入 → webContents.send）
// =================================================================================

/** 把 manager 的 pushState/pushNotice 钩子接到 m→r 推送通道（§3.6） */
export function createBrowserPushHooks(webContentsLike: WebContentsLike): BrowserManagerHooks {
  return {
    pushState: (state) => webContentsLike.send('browser:state', state),
    pushNotice: (kind, text, workspaceId) =>
      webContentsLike.send('browser:notice', { kind, text, workspaceId } satisfies BrowserNotice),
  };
}

// =================================================================================
// 注册（14 invoke 通道）
// =================================================================================

export function registerBrowserIpc(
  deps: BrowserIpcDeps,
  ipcMainLike: IpcMainLike,
  webContentsLike: WebContentsLike,
): void {
  const { manager, policy, store, probeDevServers } = deps;
  // 钩子接线一致性说明：调用方（T10 boot）应以 createBrowserPushHooks(webContentsLike)
  // 构造 manager——推送面与 invoke 面共享同一 webContents。
  void webContentsLike;

  ipcMainLike.handle('browser:getState', (_e, wsId) => manager.getState(asString(wsId, 'workspaceId')));

  ipcMainLike.handle('browser:userNavigate', (_e, wsId, url) =>
    manager.userNavigate(asString(wsId, 'workspaceId'), asString(url, 'url')),
  );

  ipcMainLike.handle('browser:takeover', (_e, wsId) => manager.userTakeover(asString(wsId, 'workspaceId')));

  ipcMainLike.handle('browser:releaseTakeover', (_e, wsId) =>
    manager.releaseTakeover(asString(wsId, 'workspaceId')),
  );

  // tabs 三通道是用户操作（G4：tabs 双方共用）——source='user'：user 态下照常放行，
  // 不经接管门（§3.2 TakenOver 只约束 agent 的 browser_* 工具）。
  ipcMainLike.handle('browser:openTab', (_e, wsId, url) =>
    manager.tabsAction(
      asString(wsId, 'workspaceId'),
      'open',
      undefined,
      url === undefined ? undefined : asString(url, 'url'),
      'user',
    ),
  );

  ipcMainLike.handle('browser:closeTab', (_e, wsId, index) =>
    manager.tabsAction(
      asString(wsId, 'workspaceId'),
      'close',
      index === undefined ? undefined : asNumber(index, 'index'),
      undefined,
      'user',
    ),
  );

  ipcMainLike.handle('browser:switchTab', (_e, wsId, index) =>
    manager.tabsAction(asString(wsId, 'workspaceId'), 'switch', asNumber(index, 'index'), undefined, 'user'),
  );

  ipcMainLike.handle('browser:setSidebarBounds', (_e, rect) => {
    manager.setSidebarBounds(asSidebarRect(rect));
  });

  // 折叠态：视图销毁/重建（manager）+ 落库（store，spec §3.6「联动 + 落库」）
  ipcMainLike.handle('browser:setSidebarCollapsed', (_e, wsId, collapsed) => {
    const id = asString(wsId, 'workspaceId');
    manager.setSidebarCollapsed(id, asBoolean(collapsed, 'collapsed'));
    store.write(id, { sidebarCollapsed: asBoolean(collapsed, 'collapsed') });
  });

  // 信任卡三值分流（spec §5.2）：session → 会话放行（内存态）；always → 落库；
  // deny → 无操作（卡片消散，工具侧保持 NotTrusted 失败语义）
  ipcMainLike.handle('browser:answerTrust', (_e, wsId, answer) => {
    const id = asString(wsId, 'workspaceId');
    if (answer !== 'session' && answer !== 'always' && answer !== 'deny') {
      throw new Error('browser:answerTrust 应答必须是 session / always / deny');
    }
    if (answer === 'session') policy.grantSession(id);
    else if (answer === 'always') store.write(id, { trust: 'always' });
  });

  // 探活：纯透传到注入的 probe（真实现 T10；失败拒绝透传，renderer 显示「未发现」）
  ipcMainLike.handle('browser:listDevServers', () => probeDevServers());

  // 设置写入：净化 → store（非法 trust 由 store fail-fast 抛中文错误）→ 结构化返回
  ipcMainLike.handle('browser:updateSettings', (_e, wsId, patch): BrowserUpdateSettingsResult => {
    const id = asString(wsId, 'workspaceId');
    try {
      store.write(id, sanitizeSettingsPatch(patch));
      return { ok: true };
    } catch (err) {
      // IPC 边界不裸抛：错误信息面向用户中文呈现（momo-boundary-rules）
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 设置读取（T9 设置页/侧栏折叠初始态消费）：store.read 全量六字段（策略四列 +
  // 侧栏折叠/宽度）；读侧对脏数据全容错（settings-store 契约），不抛错
  ipcMainLike.handle('browser:getSettings', (_e, wsId) =>
    store.read(asString(wsId, 'workspaceId')),
  );

  // 清除浏览数据（T9 设置页按钮）：委托 manager → factory.clearData 清 partition
  // storage（cookies/cache 等）；设置页路径不经接管门，不要求 ws 活跃
  ipcMainLike.handle('browser:clearBrowsingData', (_e, wsId) =>
    manager.clearBrowsingData(asString(wsId, 'workspaceId')),
  );

  logger.info('Browser IPC handlers 已注册（14 通道）');
}
