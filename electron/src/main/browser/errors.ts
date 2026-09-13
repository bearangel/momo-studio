// electron/src/main/browser/errors.ts
//
// 浏览器工具错误体系（spec 2026-09-11 §8 错误处理表）。错误类统一形态：
// name + 中文 message（面向 LLM，含可行动指引）+ code（供 UI/日志分类）。
// 恢复原则：全部可重试（agent 自决）；需用户介入的（信任/接管）信息中带明确指引。
// T3 增补 invalid_key（pressKey 白名单外按键，spec §4 工具 6）。
// T4 增补 snapshot（a11y 快照 CDP 采集失败，spec §3.4——attach 互斥 / getFullAXTree 失败）。

/** 错误分类码（UI 徽标 / 日志聚类的稳定标识） */
export type BrowserErrorCode =
  | 'not_trusted'
  | 'denied'
  | 'evaluate_disabled'
  | 'taken_over'
  | 'selector'
  | 'file_access'
  | 'domain_blocked'
  | 'protocol'
  | 'navigation'
  | 'no_view'
  | 'invalid_key'
  | 'snapshot';

/** 浏览器工具错误基类：code 供 UI/日志分类，message 面向 LLM（含指引） */
export class BrowserError extends Error {
  constructor(public readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** 信任未授（ask 且本会话未授权）：已推信任卡，授权后重试同一工具即通过 */
export class BrowserNotTrustedError extends BrowserError {
  constructor() {
    super('not_trusted', '已请求浏览器权限，请在右下角卡片授权后重试');
  }
}

/** 信任拒绝（设置 trust=deny） */
export class BrowserDeniedError extends BrowserError {
  constructor() {
    super('denied', '浏览器已被设置禁用（设置→浏览器）');
  }
}

/** browser_evaluate 被设置禁用（默认关，spec §6.2） */
export class EvaluateDisabledError extends BrowserError {
  constructor() {
    super('evaluate_disabled', 'browser_evaluate 已被设置禁用');
  }
}

/** 用户接管中：任一 browser_* 工具立即失败，等待用户显式释放 */
export class BrowserTakenOverError extends BrowserError {
  constructor() {
    super('taken_over', '浏览器被用户接管，等待释放后重试');
  }
}

/** selector 未命中（T3 selector 引擎抛出，spec §3.3）：信息含「已匹配 0 个」+ 页面可交互元素前 5 条提示助 LLM 改写 */
export class BrowserSelectorError extends BrowserError {
  constructor(selector: string, hints: readonly string[] = []) {
    const top5 = hints.slice(0, 5).join('；');
    super('selector', `选择器 "${selector}" 已匹配 0 个元素；可交互元素前 5：${top5 || '（页面无可交互元素）'}`);
  }
}

/** pressKey 白名单外按键（T3，spec §4 工具 6）——防修饰键/快捷键注入；白名单见 actions.ts */
export class BrowserInvalidKeyError extends BrowserError {
  constructor(key: string) {
    super(
      'invalid_key',
      `按键 "${key}" 不受支持（白名单：Enter/Tab/Escape/PageDown/PageUp/ArrowUp/ArrowDown/Home/End）`,
    );
  }
}

/** file:// 越界（workspace 目录限定硬安全边界，spec §6.3）。
 *  detail 可携带具体场景信息（如 workspace 根不可访问时的路径）。 */
export class BrowserFileAccessError extends BrowserError {
  constructor(detail?: string) {
    super('file_access', detail ?? 'file:// 仅限 workspace 目录内');
  }
}

/** 域名策略命中（黑名单命中，或白名单非空且不在白名单） */
export class BrowserDomainBlockedError extends BrowserError {
  constructor(domain: string) {
    super('domain_blocked', `域名 "${domain}" 被浏览器策略拦截`);
  }
}

/** 协议不支持：仅 http(s) 与 workspace 内 file://；URL 解析失败场景传具体信息 */
export class BrowserProtocolError extends BrowserError {
  constructor(message = '仅支持 http(s) 与 workspace 内 file://') {
    super('protocol', message);
  }
}

/** 导航失败（T2 拦截 did-fail-load 时抛出，description 透传） */
export class BrowserNavigationError extends BrowserError {
  constructor(description: string) {
    super('navigation', `导航失败: ${description}`);
  }
}

/** 无活跃视图（先 browser_navigate 打开页面） */
export class BrowserNoViewError extends BrowserError {
  constructor() {
    super('no_view', '浏览器未打开（先 browser_navigate）');
  }
}

/** a11y 快照采集失败（T4 snapshot.ts 抛出）：attach 互斥（用户已开 DevTools）或 CDP 命令失败 */
export class BrowserSnapshotError extends BrowserError {
  constructor(detail: string) {
    super('snapshot', `快照获取失败: ${detail}（若页面正在使用 DevTools 请关闭后重试）`);
  }
}
