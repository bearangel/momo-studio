// electron/tests/browser/snapshot.test.ts
//
// snapshot 模块测试（spec 2026-09-11 §3.4 / §4 工具 2）——两块语义：
//   formatAxTree  纯格式化：fixture AX 树 JSON → selector 提示行（spec §3.4 样例 verbatim
//                 锁定）+ presentational/ignored/容器跳过 + 空树引导 + 200 行截断页脚
//   takeSnapshot  懒附加链路：spy debugger 断言 attach('1.3') → sendCommand(
//                 'Accessibility.getFullAXTree') → detach 调用顺序；异常路径 finally
//                 仍 detach；attach 互斥失败不误 detach
//
// mock 收窄在 DebugPort 边界（结构性接口——与 view-factory.ts wrapDebugger 输出同构，
// momo-test-rules：mock 仿真真实 Electron debugger 面，不 mock 被测模块自身）。
import { describe, expect, it, vi, type Mock } from 'vitest';
import { formatAxTree, takeSnapshot } from '../../src/main/browser/snapshot';
import { BrowserSnapshotError } from '../../src/main/browser/errors';
import type { DebugPort, ManagedWebContents } from '../../src/main/browser/manager';

// =================================================================================
// fixture 构造（CDP Accessibility.getFullAXTree 响应形态——nodes 平铺先序 + childIds；
// 字段 wrapper 形态 { type, value }，与真实 Chromium 输出一致）
// =================================================================================

interface AxProp {
  name: string;
  value: { type: string; value: unknown };
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role: { type: 'role'; value: string };
  name?: { type: 'string'; value: string };
  properties?: AxProp[];
}

function axNode(role: string, name?: string, extra: Partial<AxNode> = {}): AxNode {
  return {
    nodeId: `n-${role}-${name ?? 'anon'}-${Math.random().toString(36).slice(2, 8)}`,
    role: { type: 'role', value: role },
    ...(name !== undefined ? { name: { type: 'string', value: name } } : {}),
    ...extra,
  };
}

/** spec §3.4 输出样例的等价输入树：登录页五元素（含文档容器嵌套——RootWebArea→WebArea→元素） */
const SPEC_TREE = {
  nodes: [
    axNode('RootWebArea', '登录'),
    axNode('WebArea', '登录'),
    axNode('heading', '登录到控制台', { properties: [{ name: 'level', value: { type: 'integer', value: 1 } }] }),
    axNode('textbox', '邮箱', {
      properties: [{ name: 'placeholder', value: { type: 'string', value: 'you@example.com' } }],
    }),
    axNode('button', '登录'),
    axNode('link', '注册账号'),
    axNode('image', '验证码'),
  ],
};

// =================================================================================
// spy debugger（takeSnapshot 依赖面——DebugPort 结构性接口；order 数组记录跨方法调用序）
// =================================================================================

interface DebugSpy {
  dbg: DebugPort;
  order: string[];
  attach: Mock;
  detach: Mock;
  sendCommand: Mock;
}

function mkDebugSpy(impl: { attachError?: Error; result?: unknown } = {}): DebugSpy {
  const order: string[] = [];
  const attach = vi.fn((_protocolVersion?: string) => {
    if (impl.attachError) throw impl.attachError;
    order.push('attach');
  });
  const detach = vi.fn(() => {
    order.push('detach');
  });
  const sendCommand = vi.fn(async (_method: string) => {
    order.push('sendCommand');
    return impl.result ?? { nodes: [] };
  });
  const dbg: DebugPort = { attach, detach, sendCommand };
  return { dbg, order, attach, detach, sendCommand };
}

/** takeSnapshot 目标对象——只带 debugger（模块依赖面即 Pick<ManagedWebContents,'debugger'>） */
function mkTarget(dbg: DebugPort): Pick<ManagedWebContents, 'debugger'> {
  return { debugger: dbg };
}

// =================================================================================
// formatAxTree（纯函数）
// =================================================================================

describe('formatAxTree', () => {
  it('spec §3.4 五行样例 verbatim——heading 裸行 / textbox placeholder / button·link text= / image css:img[alt]', () => {
    expect(formatAxTree(SPEC_TREE)).toEqual([
      '- heading "登录到控制台"',
      '- textbox "邮箱" placeholder="you@example.com"  → css:[placeholder="you@example.com"]',
      '- button "登录"  → text=登录',
      '- link "注册账号"  → text=注册账号',
      '- image "验证码"  → css:img[alt="验证码"]',
    ]);
  });

  it('跳过规则：ignored / RootWebArea·WebArea 容器 / generic·none 无名 / presentational·InlineTextBox；generic 有名保留', () => {
    const tree = {
      nodes: [
        axNode('generic'),                                     // 无名布局容器 → 跳过
        axNode('generic', '侧栏'),                              // 有名容器（aria-label）→ 保留（定位线索）
        axNode('none'),                                        // presentational → 跳过
        axNode('presentational', '装饰'),                       // 显式装饰角色 → 跳过
        axNode('InlineTextBox', '内部文本'),                     // CDP 内部文本节点 → 跳过
        axNode('button', '隐藏按钮', { ignored: true }),          // a11y 树不可见 → 跳过
        axNode('RootWebArea', '页'),                            // 文档容器 → 跳过
        axNode('WebArea', '页'),                                // 文档容器 → 跳过
        axNode('button', '正常'),                                // 保留
      ],
    };
    expect(formatAxTree(tree)).toEqual([
      '- generic "侧栏"',
      '- button "正常"  → text=正常',
    ]);
  });

  it('textbox 无 placeholder 有 name → aria/ 提示（selector.ts 四语法之一，可直接进 browser_click）', () => {
    const tree = { nodes: [axNode('textbox', '密码')] };
    expect(formatAxTree(tree)).toEqual(['- textbox "密码"  → aria/[role="textbox"][name="密码"]']);
  });

  it('textbox 无 placeholder 属性（properties 缺失 / 形态异常）→ 降级 aria/ 提示不抛错', () => {
    const tree = {
      nodes: [
        { role: { type: 'role', value: 'textbox' }, name: { type: 'string', value: '搜索' }, properties: 'garbage' },
      ],
    };
    expect(formatAxTree(tree)).toEqual(['- textbox "搜索"  → aria/[role="textbox"][name="搜索"]']);
  });

  it('非交互有名角色（heading 等）不附提示；无 role 节点（无论有名无名）跳过', () => {
    const tree = {
      nodes: [
        axNode('heading', '二级标题'),
        { name: { type: 'string', value: '无角色' } },  // 无 role 有 name → 跳过（行产出以 role 为前提）
        { ignored: false },                               // 无 role 无 name → 跳过
      ],
    };
    expect(formatAxTree(tree)).toEqual(['- heading "二级标题"']);
  });

  it('空树（nodes:[]）→ 单行引导文案（建议 browser_screenshot）', () => {
    expect(formatAxTree({ nodes: [] })).toEqual(['页面无可访问元素，建议 browser_screenshot']);
  });

  it('全部节点被跳过 → 同空树引导（有输入但无可产出行）', () => {
    const tree = { nodes: [axNode('generic'), axNode('none'), axNode('InlineTextBox', 't')] };
    expect(formatAxTree(tree)).toEqual(['页面无可访问元素，建议 browser_screenshot']);
  });

  it('异常形态（null / 字符串 / 无 nodes 字段）→ 不抛错，按空树引导降级', () => {
    expect(formatAxTree(null)).toEqual(['页面无可访问元素，建议 browser_screenshot']);
    expect(formatAxTree('garbage')).toEqual(['页面无可访问元素，建议 browser_screenshot']);
    expect(formatAxTree({})).toEqual(['页面无可访问元素，建议 browser_screenshot']);
  });

  it('截断：250 个可产出节点 → 恰 200 行 + 1 行页脚（含总数与 browser_scroll 指引）', () => {
    const nodes: AxNode[] = [];
    for (let i = 0; i < 250; i++) nodes.push(axNode('button', `按钮${i}`));
    const lines = formatAxTree({ nodes });
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe('- button "按钮0"  → text=按钮0');
    expect(lines[199]).toBe('- button "按钮199"  → text=按钮199');
    const footer = lines[200]!;
    expect(footer).toMatch(/已截断/);
    expect(footer).toContain('250');
    expect(footer).toContain('browser_scroll');
  });

  it('恰 200 行不触发页脚（边界含等于）；201 行触发', () => {
    const mk = (n: number) => ({
      nodes: Array.from({ length: n }, (_, i) => axNode('link', `链${i}`)),
    });
    const exactly = formatAxTree(mk(200));
    expect(exactly).toHaveLength(200);
    expect(exactly[199]).toBe('- link "链199"  → text=链199');
    expect(formatAxTree(mk(201))).toHaveLength(201); // 200 行 + 1 行页脚
  });
});

// =================================================================================
// takeSnapshot（懒附加链路）
// =================================================================================

describe('takeSnapshot', () => {
  it('链路顺序：attach("1.3") → sendCommand("Accessibility.getFullAXTree") → detach；输出为换行 join 的字符串', async () => {
    const spy = mkDebugSpy({ result: { nodes: [axNode('button', '登录'), axNode('link', '注册')] } });
    const out = await takeSnapshot(mkTarget(spy.dbg));
    expect(spy.order).toEqual(['attach', 'sendCommand', 'detach']);
    expect(spy.attach).toHaveBeenCalledWith('1.3');
    expect(spy.sendCommand).toHaveBeenCalledWith('Accessibility.getFullAXTree');
    expect(spy.detach).toHaveBeenCalledTimes(1);
    expect(out).toBe('- button "登录"  → text=登录\n- link "注册"  → text=注册');
  });

  it('空树 → 引导文案单行字符串（spec §13 空树风险缓解）', async () => {
    const spy = mkDebugSpy({ result: { nodes: [] } });
    const out = await takeSnapshot(mkTarget(spy.dbg));
    expect(out).toBe('页面无可访问元素，建议 browser_screenshot');
    expect(spy.order).toEqual(['attach', 'sendCommand', 'detach']);
  });

  it('sendCommand reject → BrowserSnapshotError（message 含底层 detail）且 finally 仍 detach', async () => {
    const spy = mkDebugSpy();
    // 两次断言各消费一次 reject（Once 只覆盖一次——第二次走 standing resolve 会假绿）；
    // Once 替换实现后 order 不再记录 sendCommand，故此处用调用次数断言（顺序已由快乐路径锁定）
    (spy.sendCommand as Mock)
      .mockRejectedValueOnce(new Error('cdp-fail'))
      .mockRejectedValueOnce(new Error('cdp-fail'));
    await expect(takeSnapshot(mkTarget(spy.dbg))).rejects.toThrow(BrowserSnapshotError);
    await expect(takeSnapshot(mkTarget(spy.dbg))).rejects.toThrow(/cdp-fail/);
    expect(spy.attach).toHaveBeenCalledTimes(2);
    expect(spy.sendCommand).toHaveBeenCalledTimes(2);
    expect(spy.detach).toHaveBeenCalledTimes(2);
  });

  it('attach 失败（用户已开 DevTools 互斥）→ BrowserSnapshotError 且不触 sendCommand / 不误 detach', async () => {
    const spy = mkDebugSpy({ attachError: new Error('Another debugger is already attached') });
    await expect(takeSnapshot(mkTarget(spy.dbg))).rejects.toThrow(BrowserSnapshotError);
    await expect(takeSnapshot(mkTarget(spy.dbg))).rejects.toThrow(/Another debugger/);
    expect(spy.sendCommand).not.toHaveBeenCalled();
    expect(spy.detach).not.toHaveBeenCalled();
  });
});
