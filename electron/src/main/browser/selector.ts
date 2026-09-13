// electron/src/main/browser/selector.ts
//
// selector 引擎——纯解析层（spec 2026-09-11 §3.3 四语法表）。
//   parseSelector     原始字符串 → { kind, value }（非法/空/纯前缀抛 BrowserSelectorError）
//   parseAriaClauses  aria 值的 [role="x"][name="y"] 子句解析（TS 侧完成，页内免正则）
//   buildResolveScript 生成注入页内的解析脚本源码（IIFE 自含；kind/value 经 JSON 转义
//                      内嵌防注入；尾部 JSON.stringify 返回字符串）
//
// 【内部 executeJavaScript 不受 evaluate 开关约束】（spec §3.3）：browser_evaluate 的
// 设置开关只门 browser_evaluate 工具（任意 JS 表达式、结果回传 LLM）；本文件的解析
// 脚本是内部固定脚本——只返回元素坐标与人读描述（未命中时附可交互元素前 5 提示），
// 不回传任意页面数据，因此不经该开关。此区分同样写入 actions.ts。
import { BrowserSelectorError } from './errors';

/** 四种 selector 语法（无前缀 = css；css: 前缀为 §3.4 snapshot 提示行的可复制形态） */
export interface ParsedSelector {
  kind: 'css' | 'text' | 'xpath' | 'aria';
  value: string;
}

/** 带 `=` 分隔的前缀（值内 `=` 不误拆——首个 `=` 即分隔符，text=a=b 取 a=b） */
const EQUAL_PREFIXES: ReadonlyArray<{ kind: 'text' | 'xpath'; prefix: string }> = [
  { kind: 'text', prefix: 'text=' },
  { kind: 'xpath', prefix: 'xpath=' },
];

/** 无 `=` 的前缀（aria/ 与 css:——后者为提示行友好写法，语义等同无前缀 css） */
const SLASH_PREFIX = 'aria/';
const CSS_PREFIX = 'css:';

/**
 * 解析原始 selector 字符串。非法输入（空/纯空白/纯前缀）抛 BrowserSelectorError——
 * 非法 selector 属于调用方（LLM）输入错误，需明确报错而非静默按 css 查询。
 */
export function parseSelector(raw: string): ParsedSelector {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new BrowserSelectorError(raw);
  }
  for (const { kind, prefix } of EQUAL_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      if (value === '') throw new BrowserSelectorError(raw);
      return { kind, value };
    }
  }
  if (trimmed.startsWith(SLASH_PREFIX)) {
    const value = trimmed.slice(SLASH_PREFIX.length).trim();
    if (value === '') throw new BrowserSelectorError(raw);
    return { kind: 'aria', value };
  }
  if (trimmed.startsWith(CSS_PREFIX)) {
    const value = trimmed.slice(CSS_PREFIX.length).trim();
    if (value === '') throw new BrowserSelectorError(raw);
    return { kind: 'css', value };
  }
  return { kind: 'css', value: trimmed };
}

/** aria 子句（[role="button"] / [name="提交"] 拆出的键值对） */
export interface AriaClause {
  key: 'role' | 'name';
  val: string;
}

/**
 * 解析 aria 值中的 [role="x"][name="y"] 子句（支持双引号/单引号/不带引号三种写法）。
 * 在 TS 侧完成而非页内——页内脚本免正则（模板字符串转义易错），且本函数可纯单测。
 * 空值子句与未知键跳过；全部为空 → 返回 []（页内按未命中处理，靠提示纠偏）。
 */
export function parseAriaClauses(value: string): AriaClause[] {
  const clauses: AriaClause[] = [];
  const re = /\[\s*(role|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const key = m[1] === 'role' || m[1] === 'name' ? m[1] : null;
    if (!key) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (val.trim() === '') continue;
    clauses.push({ key, val: val.trim() });
  }
  return clauses;
}

/**
 * 生成注入页内的元素解析脚本（IIFE）。返回值为 JSON 字符串（Electron executeJavaScript
 * 经 V8 context bridge 序列化回传）：
 *   命中   {"rect":{"x","y","width","height","description"},"hints":[]}
 *   未命中 {"rect":null,"hints":["button \"登录\" → text=登录", ...]}（可交互元素前 5）
 *
 * 四语法分派（spec §3.3 表）：
 *   css   document.querySelector
 *   text  文本节点树遍历取「首个包含目标文本的文本节点」→ 属主元素 → 取首个可交互祖先
 *         （文本节点是叶子，天然规避「容器元素 textContent 包含一切」的误配）
 *   xpath document.evaluate（FIRST_ORDERED_NODE_TYPE 取首个）
 *   aria  role（显式属性或标签隐式映射）+ accessible name（aria-label/title/placeholder/
 *         textContent，大小写不敏感包含）匹配；子句由 parseAriaClauses 预解析注入
 */
export function buildResolveScript(sel: ParsedSelector): string {
  const aria = sel.kind === 'aria' ? parseAriaClauses(sel.value) : [];
  return `(() => {
  const KIND = ${JSON.stringify(sel.kind)};
  const VALUE = ${JSON.stringify(sel.value)};
  const ARIA = ${JSON.stringify(aria)};
  const INTERACTIVE = 'a,button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable]';
  const HINT_LIMIT = 5;
  function describe(el) {
    const tag = (el.tagName || '').toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 30);
    if (text) return tag + ' "' + text + '" → text=' + text;
    const al = el.getAttribute('aria-label') || '';
    if (al) return tag + ' "' + al + '" → css:[aria-label="' + al + '"]';
    const ph = el.getAttribute('placeholder') || '';
    if (ph) return tag + ' [placeholder="' + ph + '"] → css:[placeholder="' + ph + '"]';
    const ti = el.getAttribute('title') || '';
    if (ti) return tag + ' "' + ti + '" → css:[title="' + ti + '"]';
    return tag;
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height, description: describe(el) };
  }
  function climbInteractive(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches && cur.matches(INTERACTIVE)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  function matchAria() {
    if (ARIA.length === 0) return null;
    const wantRole = ARIA.filter(function (c) { return c.key === 'role'; })[0];
    const wantName = ARIA.filter(function (c) { return c.key === 'name'; })[0];
    const IMPLICIT = { button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'image' };
    const INPUT_TYPE_ROLES = { submit: 'button', button: 'button', checkbox: 'checkbox', radio: 'radio', text: 'textbox', search: 'searchbox', email: 'textbox', password: 'textbox', url: 'textbox', tel: 'textbox', number: 'textbox' };
    function axName(el) {
      return (el.getAttribute('aria-label') || '') || (el.getAttribute('title') || '') || (el.getAttribute('placeholder') || '') || (el.textContent || '').trim();
    }
    const cands = wantRole ? document.querySelectorAll('*') : document.querySelectorAll(INTERACTIVE);
    const nodes = Array.prototype.slice.call(cands);
    for (const el of nodes) {
      if (wantRole) {
        const tag = (el.tagName || '').toLowerCase();
        const implicit = tag === 'input' ? (INPUT_TYPE_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox') : IMPLICIT[tag];
        const role = el.getAttribute('role') || implicit;
        if (!role || role.toLowerCase() !== wantRole.val.toLowerCase()) continue;
      }
      if (wantName) {
        const n = axName(el).trim().toLowerCase();
        if (n === '' || n.indexOf(wantName.val.trim().toLowerCase()) < 0) continue;
      }
      return el;
    }
    return null;
  }
  let el = null;
  try {
    if (KIND === 'css') {
      el = document.querySelector(VALUE);
    } else if (KIND === 'text') {
      const root = document.body || document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node = null;
      while ((node = walker.nextNode()) !== null) {
        if (node.nodeValue && node.nodeValue.indexOf(VALUE) >= 0) {
          el = node.parentElement;
          break;
        }
      }
      if (el) el = climbInteractive(el);
    } else if (KIND === 'xpath') {
      el = document.evaluate(VALUE, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } else {
      el = matchAria();
    }
  } catch (err) {
    el = null;
  }
  if (el) {
    const rect = rectOf(el);
    if (rect) return JSON.stringify({ rect: rect, hints: [] });
  }
  const hints = [];
  try {
    const cands = Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE));
    for (const c of cands) {
      if (hints.length >= HINT_LIMIT) break;
      const h = describe(c);
      if (h !== '') hints.push(h);
    }
  } catch (err) {
    /* hints 收集失败不阻塞，返回空提示 */
  }
  return JSON.stringify({ rect: null, hints: hints });
})()`;
}
