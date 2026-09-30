// renderer/src/components/im/RichComposer.test.tsx
//
// RichComposer 编辑面测试（v3 内联 pill 富输入块 Task 2）：
//   1. segments 往返：setSegments 混排 → getSegments 深等于；相邻文本节点合并 / ZWSP 剥离
//   2. pill DOM 契约：contenteditable=false + data-kind/id/label + 五类语义类名 + 显示文本
//   3. 空编辑器 placeholder（data-placeholder 属性 + empty:before 类——jsdom 不渲染伪元素，断言类名）
//   4. insertPill 替换触发局部（光标前 replaceLen 字符删除 → pill 原位插入）
//   5. insertPill 空选区防御（无 selection → 追加末尾不抛错）
//   6. Backspace 两段式（第一次高亮 data-selected / 第二次连带 ZWSP 删除）
//   7. Delete 删选中 pill（mousedown 选中 → Delete 删除；点文字区清除选中态）
//   8. IME 组字保护（compositionstart~end 之间不触发 onInputText）
//   9. Enter/Escape 回调 + Shift+Enter 不触发 + isComposing/keyCode 229 守卫
//  10. insertTextAtEnd 防粘连（末字符非空白补空格 / 空编辑器恰插入文本）
//  11. disabled 态（contenteditable=false + opacity-50）
//
// jsdom 的 Selection/Range 支持基础操作（createRange + addRange）——测试内用
// setCaret 主动设光标；组件内光标逻辑对「无有效选区」防御兜底，绝不让空态炸组件。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RichComposer, type RichComposerHandle, type RichComposerProps } from './RichComposer';
import type { ComposerSegment, PillSeg } from './composer-segments';

/** handle 承载体（普通对象——普通函数调 useRef 会因无 React dispatcher 崩溃） */
type HandleRef = { current: RichComposerHandle | null };

/** 测试壳：拿 handle + 注入回调 spy（业务零 mock——真实 DOM + 真实组件） */
function harnessUi(handle: HandleRef, props: Partial<RichComposerProps> = {}) {
  return (
    <RichComposer
      ref={(h) => {
        handle.current = h;
      }}
      disabled={props.disabled ?? false}
      placeholder={props.placeholder ?? '输入消息'}
      ariaLabel={props.ariaLabel ?? '消息输入框'}
      onInputText={props.onInputText ?? vi.fn()}
      onEnter={props.onEnter ?? vi.fn()}
      onEscape={props.onEscape ?? vi.fn()}
      onNavigate={props.onNavigate}
      onPasteImage={props.onPasteImage}
    />
  );
}

/** 渲染一个编辑器并返回其 handle（多数用例的最短路径） */
function mount(props: Partial<RichComposerProps> = {}): RichComposerHandle {
  const handle: HandleRef = { current: null };
  render(harnessUi(handle, props));
  return handle.current!;
}

/** 设光标到指定文本节点的 offset（jsdom 下手动建 Range） */
function setCaret(node: Node, offset: number): void {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

const agentPill: PillSeg = { type: 'pill', kind: 'agent', id: 'i1', label: 'coder' };
const filePill: PillSeg = { type: 'pill', kind: 'file', id: 'src/a.ts', label: 'src/a.ts' };
const taskPill: PillSeg = { type: 'pill', kind: 'task', id: 'T-3', label: '修复登录' };
const skillPill: PillSeg = { type: 'pill', kind: 'skill', id: 'code-review', label: '代码审查' };
const commandPill: PillSeg = { type: 'pill', kind: 'command', id: 'compact', label: '压缩' };
const imagePill: PillSeg = {
  type: 'pill', kind: 'image', id: '.momo/assets/ab12cd34.png', label: '截图.png', w: 800, h: 600,
};
// 2026-09-30 跨会话引用 Task 10：会话 pill 视觉定稿（与 file 同底色，靠 @ 前缀区分）
const sessionPill: PillSeg = { type: 'pill', kind: 'session', id: 's-abc', label: '设计讨论' };

function editor(): HTMLElement {
  return screen.getByRole('textbox', { name: '消息输入框' }) as HTMLElement;
}

/** 编辑器内全部 pill span（按 DOM 顺序） */
function pillNodes(): HTMLSpanElement[] {
  return Array.from(editor().querySelectorAll<HTMLSpanElement>('span[data-kind]'));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('RichComposer segments 往返', () => {
  it('setSegments 混排 → getSegments 深等于输入（pill 后 ZWSP 剥离）', () => {
    const h = mount();
    const segs: ComposerSegment[] = [
      { type: 'text', text: '帮 ' },
      agentPill,
      { type: 'text', text: ' 看 ' },
      filePill,
    ];
    h!.setSegments(segs);
    expect(h!.getSegments()).toEqual(segs);
  });

  it('getSegments 合并相邻文本节点（ZWSP-only 节点剥空跳过）', () => {
    const h = mount();
    // 相邻两个 text 段 → DOM 两个相邻文本节点 → 提取时合并
    h!.setSegments([{ type: 'text', text: '帮' }, { type: 'text', text: ' 一下' }]);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '帮 一下' }]);
    // pill 后 ZWSP-only 节点剥空后不产生空文本段
    h!.setSegments([agentPill]);
    expect(h!.getSegments()).toEqual([agentPill]);
  });

  it('setSegments → DOM：pill span contenteditable=false + data-* + 五类语义类名与显示文本', () => {
    const h = mount();
    h!.setSegments([agentPill, filePill, taskPill, skillPill, commandPill]);
    const pills = pillNodes();
    expect(pills).toHaveLength(5);
    for (const p of pills) {
      expect(p.getAttribute('contenteditable')).toBe('false');
      expect(p.dataset.kind).toBeTruthy();
      expect(p.dataset.id).toBeTruthy();
      expect(p.dataset.label).toBeTruthy();
      // 公共类（原子块视觉契约的一部分）
      expect(p.className).toContain('select-none');
    }
    const agent = pills[0]!;
    const file = pills[1]!;
    const task = pills[2]!;
    const skill = pills[3]!;
    const command = pills[4]!;
    expect(agent.dataset.kind).toBe('agent');
    expect(agent.dataset.id).toBe('i1');
    expect(agent.dataset.label).toBe('coder');
    expect(agent.textContent).toBe('@coder');
    expect(agent.className).toContain('bg-accent-600/10');
    expect(file.textContent).toBe('src/a.ts');
    expect(file.className).toContain('bg-surface-active');
    expect(task.textContent).toBe('#T-3 修复登录');
    expect(task.className).toContain('bg-status-success-tint');
    expect(skill.dataset.id).toBe('code-review');
    expect(skill.textContent).toBe('代码审查');
    expect(skill.className).toContain('bg-status-violet-tint');
    expect(command.textContent).toBe('/compact');
    expect(command.className).toContain('bg-status-warning-tint');
  });

  it('空编辑器 placeholder 呈现（data-placeholder 属性 + empty:before 类存在）', () => {
    mount();
    const el = editor();
    expect(el.getAttribute('data-placeholder')).toBe('输入消息');
    expect(el.className).toContain('empty:before:content-[attr(data-placeholder)]');
    expect(el.className).toContain('empty:before:text-disabled');
    expect(el.getAttribute('contenteditable')).toBe('true');
  });

  it('disabled 态：contenteditable=false + opacity-50（不依赖 disabled 属性）', () => {
    mount({ disabled: true });
    const el = editor();
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(el.className).toContain('opacity-50');
    expect(el.getAttribute('disabled')).toBeNull();
  });
});

describe('RichComposer pill 插入', () => {
  it('insertPill 替换光标前触发局部（帮 @co + replaceLen 3 → 帮 + agentPill）', () => {
    const h = mount();
    h!.setSegments([{ type: 'text', text: '帮 @co' }]);
    const textNode = editor().firstChild as Text;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);
    setCaret(textNode, '帮 @co'.length);
    h!.insertPill(agentPill, 3);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '帮 ' }, agentPill]);
    const pills = pillNodes();
    expect(pills).toHaveLength(1);
    expect(pills[0]!.dataset.kind).toBe('agent');
    expect(pills[0]!.dataset.id).toBe('i1');
  });

  it('insertPill 空选区防御：无 selection → pill 追加末尾不抛错', () => {
    const h = mount();
    h!.setSegments([{ type: 'text', text: '开头' }]);
    window.getSelection()?.removeAllRanges();
    expect(() => h!.insertPill(filePill, 0)).not.toThrow();
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '开头' }, filePill]);
    expect(pillNodes()).toHaveLength(1);
  });

  it('insertPill root 元素层光标下删除触发局部（moveCaretToEnd / insertTextAtEnd 后的光标形态）', () => {
    // 用户真实路径：原生敲 @（无防粘连空格）→ 光标经 moveCaretToEnd 落 root 层 → 菜单选 pill
    const h = mount();
    h!.setSegments([{ type: 'text', text: '开头@' }]);
    h!.moveCaretToEnd(); // startContainer = root（元素层）
    h!.insertPill(agentPill, 1);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '开头' }, agentPill]);

    // 审查复现链路：insertTextAtEnd 防粘连补的空格是 insertTextAtEnd 自身语义，
    // 触发局部 '@' 必须删净（空格保留）
    const h2 = mount();
    h2!.setSegments([{ type: 'text', text: '开头' }]);
    h2!.insertTextAtEnd('@');
    h2!.insertPill(agentPill, 1);
    expect(h2!.getSegments()).toEqual([{ type: 'text', text: '开头 ' }, agentPill]);
  });

  it('insertPill 中段插入不吞尾文（replaceLen=0 纯插入，splitText 路径尾文保留）', () => {
    const h = mount();
    // 末尾 offset（=length）：after 分支 → 整段保留 + pill 随后
    h!.setSegments([{ type: 'text', text: 'abc' }]);
    setCaret(editor().firstChild as Text, 3);
    h!.insertPill(agentPill, 0);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: 'abc' }, agentPill]);
    // 中段 offset（< length）：splitText 分支 → 前后文本都保留（同一编辑器两轮）
    h!.clear();
    h!.setSegments([{ type: 'text', text: 'abc' }]);
    setCaret(editor().firstChild as Text, 2);
    h!.insertPill(agentPill, 0);
    expect(h!.getSegments()).toEqual([
      { type: 'text', text: 'ab' },
      agentPill,
      { type: 'text', text: 'c' },
    ]);
  });
});

describe('RichComposer 文本保真（换行 / 粘贴对等）', () => {
  it('Shift+Enter 换行保真：<br> 折叠为 \\n，getSegments 与 beforeCaret 均不丢换行', () => {
    const onInputText = vi.fn();
    const h = mount({ onInputText });
    h!.setSegments([{ type: 'text', text: '第一行' }]);
    // 手工构造 Shift+Enter 浏览器默认产物：<br> + 后续文本
    editor().append(document.createElement('br'), document.createTextNode('第二行'));
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '第一行\n第二行' }]);
    h!.moveCaretToEnd();
    fireEvent.input(editor());
    expect(onInputText).toHaveBeenLastCalledWith('第一行\n第二行', '第一行\n第二行');
  });

  it('粘贴保真：div 内文本递归提取，块级尾补换行（粘贴A\\n续）', () => {
    const h = mount();
    // 手工构造粘贴形态：root 下 <div>文本</div> + 后续文本
    const div = document.createElement('div');
    div.textContent = '粘贴A';
    editor().append(div, document.createTextNode('续'));
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '粘贴A\n续' }]);
  });
});

describe('RichComposer 原子编辑', () => {
  it('Backspace 两段式：第一次高亮 data-selected，第二次连带 ZWSP 删除', () => {
    const h = mount();
    h!.setSegments([agentPill]);
    const pill = pillNodes()[0]!;
    const zwsp = pill.nextSibling as Text;
    // pill 后必须跟 ZWSP 文本节点（光标落点契约）
    expect(zwsp.textContent).toBe('\u200b');
    setCaret(zwsp, 0);
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(pill.dataset.selected).toBe('1');
    expect(pillNodes()).toHaveLength(1);
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(pillNodes()).toHaveLength(0);
    expect(h!.getSegments()).toEqual([]);
  });

  it('Backspace 邻接判定：ZWSP 节点 offset 1（光标在 ZWSP 后）仍高亮', () => {
    const h = mount();
    h!.setSegments([agentPill]);
    const pill = pillNodes()[0]!;
    const zwsp = pill.nextSibling as Text;
    // ZWSP-only 节点任意 offset 均视为紧邻其前 pill——真实浏览器光标落 ZWSP 后的形态
    setCaret(zwsp, 1);
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(pill.dataset.selected).toBe('1');
    expect(pillNodes()).toHaveLength(1);
  });

  it('Delete 删选中 pill；点击文字区清除选中态', () => {
    const h = mount();
    h!.setSegments([agentPill, { type: 'text', text: ' 后文' }]);
    const pill = pillNodes()[0]!;
    fireEvent.mouseDown(pill);
    expect(pill.dataset.selected).toBe('1');
    // 点击文字区（target 非 pill）→ 清除选中态
    fireEvent.mouseDown(editor());
    expect(pill.dataset.selected).toBeUndefined();
    // 重新选中后 Delete 删除
    fireEvent.mouseDown(pill);
    expect(pill.dataset.selected).toBe('1');
    fireEvent.keyDown(editor(), { key: 'Delete' });
    expect(pillNodes()).toHaveLength(0);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: ' 后文' }]);
  });
});

describe('RichComposer IME 与按键', () => {
  it('IME 组字保护 + compositionend 提交补偿（Chromium 序 input(final)→compositionend）', () => {
    const onInputText = vi.fn();
    const h = mount({ onInputText });
    h!.setSegments([{ type: 'text', text: '@任' }]);
    onInputText.mockClear();
    fireEvent.compositionStart(editor());
    // Chromium：final input 先于 compositionend 到达，组合标记仍 true → 跳过
    // （IME 回车提交后菜单不过滤、删一个字符才生效的 P0 根因）
    fireEvent.input(editor());
    expect(onInputText).not.toHaveBeenCalled();
    // compositionend 清标记并补发——提交文本立即触发检测
    fireEvent.compositionEnd(editor());
    expect(onInputText).toHaveBeenCalledTimes(1);
    expect(onInputText).toHaveBeenLastCalledWith('@任', '@任');
    // 组合结束后恢复正常：后续 input 正常派发
    fireEvent.input(editor());
    expect(onInputText).toHaveBeenCalledTimes(2);
  });

  it('onNavigate 裁决：消费时 preventDefault，未消费/未提供放行编辑器默认', () => {
    // Tab 未消费（菜单关闭场景），方向键消费（菜单开）
    const onNavigate = vi.fn((key: string) => key !== 'Tab');
    mount({ onNavigate });
    const el = editor();
    const captured: KeyboardEvent[] = [];
    el.addEventListener('keydown', (e) => captured.push(e as KeyboardEvent));
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(onNavigate).toHaveBeenCalledWith('ArrowDown');
    expect(captured[0]?.defaultPrevented).toBe(true);
    fireEvent.keyDown(el, { key: 'Tab' });
    expect(onNavigate).toHaveBeenCalledWith('Tab');
    expect(captured[1]?.defaultPrevented).toBe(false);
    // Enter/普通键不经 onNavigate（Enter 走 onEnter 通道）
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('Enter/Escape 回调；Shift+Enter 与 isComposing 的 Enter 不触发 onEnter', () => {
    const onEnter = vi.fn();
    const onEscape = vi.fn();
    mount({ onEnter, onEscape });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true });
    expect(onEnter).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true });
    expect(onEnter).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor(), { key: 'Enter', keyCode: 229 });
    expect(onEnter).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('RichComposer insertTextAtEnd', () => {
  it('防粘连：已有文字「帮」末尾插入 @ → 帮 @；空编辑器恰 @；onInputText 携带 beforeCaret', () => {
    const onInputText = vi.fn();
    const h = mount({ onInputText });
    h!.setSegments([{ type: 'text', text: '帮' }]);
    h!.insertTextAtEnd('@');
    expect(onInputText).toHaveBeenCalledTimes(1);
    expect(onInputText).toHaveBeenLastCalledWith('帮 @', '帮 @');
    // 空编辑器：不补空格，恰为插入文本
    h!.clear();
    onInputText.mockClear();
    h!.insertTextAtEnd('@');
    expect(onInputText).toHaveBeenCalledTimes(1);
    expect(onInputText).toHaveBeenCalledWith('@', '@');
  });

  it('末尾是 pill 时插入 @：pill 折叠单空格且不与 @ 粘连（Task 3 触发检测契约）', () => {
    const onInputText = vi.fn();
    const h = mount({ onInputText });
    h!.setSegments([agentPill]);
    h!.insertTextAtEnd('@');
    expect(onInputText).toHaveBeenCalledTimes(1);
    expect(onInputText).toHaveBeenLastCalledWith(' @', ' @');
  });
});

// === image pill + 粘贴/拖入拦截（2026-09-26 多模态 spec §10）===
describe('RichComposer image pill 渲染（spec §10）', () => {
  it('image pill DOM：data-kind/id/label/w/h + 图标 svg + 文件名文本 + 语义类名', () => {
    const h = mount();
    h!.setSegments([imagePill]);
    const pills = pillNodes();
    expect(pills).toHaveLength(1);
    const p = pills[0]!;
    expect(p.dataset.kind).toBe('image');
    expect(p.dataset.id).toBe('.momo/assets/ab12cd34.png');
    expect(p.dataset.label).toBe('截图.png');
    // w/h 落 DOM——getSegments 反向提取契约（序列化进 context.images）
    expect(p.dataset.w).toBe('800');
    expect(p.dataset.h).toBe('600');
    expect(p.textContent).toBe('截图.png');
    // lucide Image 图标（禁 emoji——图标以 svg 呈现）与既有 pill 语义 token 体系
    expect(p.querySelector('svg')).not.toBeNull();
    expect(p.className).toContain('bg-surface-active');
    expect(p.className).toContain('text-accent-600');
  });

  it('image pill segments 往返：w/h 经 DOM data-* 保真（缺 w/h 的外来 span 不炸）', () => {
    const h = mount();
    h!.setSegments([{ type: 'text', text: '图 ' }, imagePill]);
    expect(h!.getSegments()).toEqual([{ type: 'text', text: '图 ' }, imagePill]);
    // 防御：伪造 data-kind=image 但无 w/h 的 span（外来源 HTML 粘贴）——提取不抛错，
    // w/h 缺省（序列化层 validImageDims 会把它挡在 context.images 之外）
    const el = editor();
    el.textContent = '';
    const foreign = document.createElement('span');
    foreign.setAttribute('contenteditable', 'false');
    foreign.dataset.kind = 'image';
    foreign.dataset.id = 'x.png';
    foreign.dataset.label = 'x.png';
    el.append(foreign, document.createTextNode('\u200b'));
    expect(() => h!.getSegments()).not.toThrow();
  });

  it('Backspace 删除 image pill 后补发 onInputText（提示行随 pill 删除刷新）', () => {
    const onInputText = vi.fn();
    const h = mount({ onInputText });
    h!.setSegments([imagePill]);
    onInputText.mockClear();
    const pill = pillNodes()[0]!;
    const zwsp = pill.nextSibling as Text;
    setCaret(zwsp, 0);
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(pill.dataset.selected).toBe('1');
    expect(onInputText).not.toHaveBeenCalled();
    fireEvent.keyDown(editor(), { key: 'Backspace' });
    expect(pillNodes()).toHaveLength(0);
    // 删除即补发——上层（MentionInput 能力提示行）无需等下一次键入才感知
    expect(onInputText).toHaveBeenCalledTimes(1);
  });
});

// === session pill 视觉默认值锁定（2026-09-30 跨会话引用 Task 10）===
describe('RichComposer session pill 视觉默认值', () => {
  it('session pill DOM：data-kind/id/label + @ 前缀 + 视觉默认值（bg-surface-active text-secondary）', () => {
    const h = mount();
    h!.setSegments([sessionPill]);
    const pills = pillNodes();
    expect(pills).toHaveLength(1);
    const p = pills[0]!;
    expect(p.dataset.kind).toBe('session');
    expect(p.dataset.id).toBe('s-abc');
    expect(p.dataset.label).toBe('设计讨论');
    expect(p.getAttribute('contenteditable')).toBe('false');
    // 显示文本以 @ 前缀（spec §6 跨会话引用，与 agent pill 同形）
    expect(p.textContent).toBe('@设计讨论');
    // 视觉默认值：与 file 同底色，靠 @ 前缀区分（Task 10 预览门禁延后由 controller 真实 GUI 截图定稿）
    expect(p.className).toContain('bg-surface-active');
    expect(p.className).toContain('text-secondary');
  });

  it('session pill segments 往返：getSegments 深等于 setSegments 输入', () => {
    const h = mount();
    h!.setSegments([{ type: 'text', text: '看 ' }, sessionPill, { type: 'text', text: ' 续' }]);
    expect(h!.getSegments()).toEqual([
      { type: 'text', text: '看 ' },
      sessionPill,
      { type: 'text', text: ' 续' },
    ]);
  });
});

describe('RichComposer 粘贴/拖入图片拦截（spec §10 paste/drop）', () => {
  function imageFile(name = 'shot.png'): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  }
  /** 捕获 native paste/drop 事件，事后读 defaultPrevented（React 合成 preventDefault 在根容器派发时才落回原生——须延迟读取，同 onNavigate 用例的存事件后读法） */
  function captureNative(el: HTMLElement, type: 'paste' | 'drop'): () => boolean {
    let evt: Event | null = null;
    el.addEventListener(type, (e) => {
      evt = e;
    });
    return () => evt?.defaultPrevented ?? false;
  }

  it('粘贴 2 张图片 → onPasteImage 一次收齐两张 + 默认粘贴被阻止', () => {
    const onPasteImage = vi.fn();
    mount({ onPasteImage });
    const el = editor();
    const getPrevented = captureNative(el, 'paste');
    const f1 = imageFile('a.png');
    const f2 = imageFile('b.jpg');
    fireEvent.paste(el, { clipboardData: { files: [f1, f2] } });
    expect(onPasteImage).toHaveBeenCalledTimes(1);
    expect(onPasteImage).toHaveBeenCalledWith([f1, f2]);
    expect(getPrevented()).toBe(true);
  });

  it('纯文本粘贴 → onPasteImage 不调用 + 默认粘贴行为保留', () => {
    const onPasteImage = vi.fn();
    mount({ onPasteImage });
    const el = editor();
    const getPrevented = captureNative(el, 'paste');
    fireEvent.paste(el, { clipboardData: { files: [], getData: () => '纯文本' } });
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(getPrevented()).toBe(false);
  });

  it('混合文件粘贴（图片 + 非图片）→ 只上抛图片且默认行为阻止（非图片不重复处理）', () => {
    const onPasteImage = vi.fn();
    mount({ onPasteImage });
    const el = editor();
    const getPrevented = captureNative(el, 'paste');
    const img = imageFile('a.png');
    const txt = new File([new Uint8Array([1])], 'note.txt', { type: 'text/plain' });
    fireEvent.paste(el, { clipboardData: { files: [txt, img] } });
    expect(onPasteImage).toHaveBeenCalledTimes(1);
    expect(onPasteImage).toHaveBeenCalledWith([img]);
    expect(getPrevented()).toBe(true);
  });

  it('拖入 2 张图片 → onPasteImage 一次收齐 + 默认 drop 被阻止', () => {
    const onPasteImage = vi.fn();
    mount({ onPasteImage });
    const el = editor();
    const getPrevented = captureNative(el, 'drop');
    const f1 = imageFile('a.png');
    const f2 = imageFile('b.png');
    fireEvent.drop(el, { dataTransfer: { files: [f1, f2] } });
    expect(onPasteImage).toHaveBeenCalledTimes(1);
    expect(onPasteImage).toHaveBeenCalledWith([f1, f2]);
    expect(getPrevented()).toBe(true);
  });

  it('未提供 onPasteImage（可选 prop）→ 图片粘贴不拦截也不上抛，组件不炸', () => {
    mount();
    const el = editor();
    const getPrevented = captureNative(el, 'paste');
    expect(() =>
      fireEvent.paste(el, { clipboardData: { files: [imageFile()] } }),
    ).not.toThrow();
    expect(getPrevented()).toBe(false);
  });
});
