// electron/src/main/browser/types.ts
//
// 浏览器模块共享类型（spec 2026-09-11 §3.1 / §6.2）。T2+ 的 BrowserManager /
// IPC 状态推送 / 设置页均消费本文件；T1 仅定义契约。

/** tab 清单行（browser_tabs 工具返回 / sidebar tabs 栏渲染共用） */
export interface TabInfo {
  index: number;
  url: string;
  title: string;
}

/** 统一状态推送（IPC browser:state）载荷——单页共享模型的完整快照 */
export interface BrowserState {
  workspaceId: string;
  tabs: TabInfo[];
  /** 当前 tab 下标（tabs[current] 即活跃页） */
  current: number;
  url: string;
  title: string;
  /** 单页仲裁态：agent 工具可用 / 用户接管中（工具立即失败） */
  takeover: 'agent' | 'user';
  /** 信任卡视角：本会话是否已放行（ask+已授权 或 always/deny 之外的可通行态） */
  trusted: boolean;
}

/** workspace 级浏览器设置（migration v32 落 workspace_settings 的策略四列） */
export interface WorkspaceBrowserSettings {
  /** 信任级别：ask（默认，首次弹卡+立即失败）/ always（直接放行）/ deny（直接拒绝） */
  trust: 'ask' | 'always' | 'deny';
  /** browser_evaluate 单独开关，默认关（spec §6.2） */
  evaluateEnabled: boolean;
  /** 域名黑名单：域名及子域命中即拒 */
  blacklist: string[];
  /** 域名白名单：非空时仅白名单放行（空=全放行）；localhost 恒放行 */
  whitelist: string[];
}
