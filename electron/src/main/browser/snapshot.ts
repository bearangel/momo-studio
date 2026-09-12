// electron/src/main/browser/snapshot.ts
//
// a11y 快照层（spec 2026-09-11 §3.4 / §4 工具 2）。T4 起取代 manager 内嵌的 T2 最小
// 格式化器（formatAxTreeMinimal）——格式化与采集单一归属本模块，manager 只做视图定位
// 与门控（与 T3 actions.ts 同一接缝模式）。
//
//   formatAxTree  纯函数：getFullAXTree 响应 → selector 提示行数组
//   takeSnapshot  懒附加链路：attach('1.3') → sendCommand → finally detach
//
// 【懒附加互斥面最小化】debugger 占用被压到调用瞬间（attach→detach 毫秒级）——与用户
// 在 sidebar 页面开 DevTools 互斥的窗口极小（spec §3.4 / §12.3 已知边界）。
//
// 【行格式】`- <role> "<name>"[ attr]  → <selector>`；提示必须可直接复制进 browser_click
// （与 selector.ts 四语法一致：text= / css: / aria/）。heading 等非交互角色不附提示
// （spec §3.4 样例 ground truth）。
//
// 【跳过规则】ignored:true（a11y 树不可见）/ RootWebArea·WebArea（文档容器——title 已由
// navigate 回传）/ generic·none 无名（纯布局容器）/ presentational·InlineTextBox（装饰
// 与内部文本节点）——对 LLM 决策无信息量且占行数预算。
//
// 【上下文预算】行数上限 200，超出截断并附页脚行（LLM context budget——超长页面建议
// browser_scroll 分段 snapshot 或直接 browser_screenshot）。
import { BrowserSnapshotError } from './errors';
import type { ManagedWebContents } from './manager';

/** CDP 协议版本（懒附加 attach 用；Electron Debugger.sendCommand 覆盖 Accessibility 域） */
const CDP_PROTOCOL_VERSION = '1.3';

/** 输出行数上限（LLM 上下文预算；超出截断 + 页脚行） */
const MAX_LINES = 200;

/** 空树 / 异常形态引导文案（spec §13 空树风险缓解——建议改用截图） */
const EMPTY_TREE_HINT = '页面无可访问元素，建议 browser_screenshot';

/** 文档容器角色——整文档级节点，title 已由 navigate 回传，不产出行动行 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['RootWebArea', 'WebArea']);

/** 装饰 / 内部节点角色——无条件跳过（presentational 无语义；InlineTextBox 为 CDP 文本内部节点） */
const PRESENTATIONAL_ROLES: ReadonlySet<string> = new Set(['presentational', 'InlineTextBox']);

/** 无名时跳过的布局角色（有名 generic 如 aria-label 容器仍保留——可成为定位线索） */
const UNNAMED_SKIP_ROLES: ReadonlySet<string> = new Set(['generic', 'none']);

/** 名字来自内容的可点击角色——text= 提示（spec §3.4 样例：button/link） */
const TEXT_HINT_ROLES: ReadonlySet<string> = new Set(['button', 'link']);

// =================================================================================
// AX 节点字段读取（unknown 逐层收窄——CDP AXNode wrapper 形态 { type, value }）
// =================================================================================

/** 读取嵌套字段 wrapper.value（n.role.value / n.name.value 等；形态异常返回 ''） */
function axField(node: Record<string, unknown>, field: string): string {
  const inner = node[field];
  if (typeof inner !== 'object' || inner === null) return '';
  const v = (inner as Record<string, unknown>)['value'];
  return typeof v === 'string' ? v : '';
}

/** properties[] 中取字符串属性（placeholder 等；缺失 / 形态异常返回 ''——不掩盖、不抛错） */
function axStringProperty(node: Record<string, unknown>, prop: string): string {
  const props = node['properties'];
  if (!Array.isArray(props)) return '';
  for (const p of props) {
    if (typeof p !== 'object' || p === null) continue;
    const entry = p as Record<string, unknown>;
    if (entry['name'] !== prop) continue;
    const wrapper = entry['value'];
    if (typeof wrapper !== 'object' || wrapper === null) continue;
    const v = (wrapper as Record<string, unknown>)['value'];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/** 单节点 → 提示行；命中跳过规则返回 null */
function formatNode(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as Record<string, unknown>;
  if (n['ignored'] === true) return null;
  const role = axField(n, 'role');
  const name = axField(n, 'name');
  // 无 role 节点一律跳过（形态退化——T2 起行产出以 role 为前提，无名 role 裸行亦同）
  if (role === '') return null;
  if (CONTAINER_ROLES.has(role) || PRESENTATIONAL_ROLES.has(role)) return null;
  if (UNNAMED_SKIP_ROLES.has(role) && name === '') return null;

  // attr 与 selector 提示按角色合成（提示形态与 selector.ts parseSelector 可解析集合一致）
  let attrs = '';
  let hint = '';
  const placeholder = axStringProperty(n, 'placeholder');
  if (role === 'textbox' && placeholder !== '') {
    attrs = ` placeholder="${placeholder}"`;
    hint = `css:[placeholder="${placeholder}"]`;
  } else if (role === 'textbox' && name !== '') {
    // 有名无 placeholder：名字多来自关联 label，text= 定位不到 input——aria/ 子句精确匹配
    hint = `aria/[role="textbox"][name="${name}"]`;
  } else if (TEXT_HINT_ROLES.has(role) && name !== '') {
    hint = `text=${name}`;
  } else if (role === 'image' && name !== '') {
    // image 名字通常来自 alt——合成 css:img[alt=...]（spec §3.4 样例）
    hint = `css:img[alt="${name}"]`;
  }
  const base = name !== '' ? `- ${role} "${name}"` : `- ${role}`;
  return hint !== '' ? `${base}${attrs}  → ${hint}` : base;
}
// =================================================================================
// 公共 API
// =================================================================================

/**
 * 把 getFullAXTree 响应格式化为提示行数组（纯函数）。nodes 序即行序（CDP 先序遍历，
 * 天然全序——与 message_events.seq 同理，无需二次排序）。空树 / 全部跳过 / 形态异常
 * （非对象、无 nodes 字段）一律降级为单行引导文案——采集成功但无内容不是错误。
 */
export function formatAxTree(axTree: unknown): string[] {
  const root = typeof axTree === 'object' && axTree !== null ? (axTree as Record<string, unknown>) : null;
  const nodes = root && Array.isArray(root['nodes']) ? (root['nodes'] as unknown[]) : [];
  const lines: string[] = [];
  let overflow = 0;
  for (const node of nodes) {
    const line = formatNode(node);
    if (line === null) continue;
    if (lines.length < MAX_LINES) lines.push(line);
    else overflow++;
  }
  if (overflow > 0) {
    lines.push(
      `… 已截断：共 ${lines.length + overflow} 个元素，仅显示前 ${MAX_LINES} 个（可 browser_scroll 后再 snapshot，或用 browser_screenshot）`,
    );
  }
  return lines.length > 0 ? lines : [EMPTY_TREE_HINT];
}

/**
 * 采集 a11y 快照：懒附加 debugger（'1.3'）→ Accessibility.getFullAXTree → 格式化 →
 * finally detach（用完即还——与用户 DevTools 互斥面最小化，spec §3.4）。
 * CDP 失败（attach 互斥 / sendCommand reject）包装为 BrowserSnapshotError（detail 透传，
 * agent 可读原始错误自决重试）。attach 失败时未成功附加，不调 detach（防二次抛错）。
 */
export async function takeSnapshot(wc: Pick<ManagedWebContents, 'debugger'>): Promise<string> {
  const dbg = wc.debugger;
  try {
    dbg.attach(CDP_PROTOCOL_VERSION);
  } catch (err) {
    throw new BrowserSnapshotError(errMessage(err));
  }
  try {
    const tree: unknown = await dbg.sendCommand('Accessibility.getFullAXTree');
    return formatAxTree(tree).join('\n');
  } catch (err) {
    throw new BrowserSnapshotError(errMessage(err));
  } finally {
    dbg.detach();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
