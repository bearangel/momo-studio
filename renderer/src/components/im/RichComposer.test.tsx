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
  it('IME 组字保护：compositionstart~end 之间 input 不触发 onInputText，之后恢复', () => {
    const onInputText = vi.fn();
    mount({ onInputText });
    fireEvent.compositionStart(editor());
    fireEvent.input(editor());
    expect(onInputText).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor());
    fireEvent.input(editor());
    expect(onInputText).toHaveBeenCalledTimes(1);
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
});
