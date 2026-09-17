// renderer/src/components/im/RichComposer.tsx
//
// 内联 pill 富输入块的编辑面（spec 2026-09-17-rich-composer-inline-pills-design §2/§4）：
//   非受控 contentEditable div——五类引用（agent/文件/任务/技能/命令）是文字流中的
//   原子 pill span（contenteditable=false + data-kind/id/label + 后随 ZWSP 文本节点
//   作光标落点）。DOM 只经 insertPill/setSegments/clear/用户输入变动，React 绝不
//   传 children / 不用 dangerouslySetInnerHTML 管内容。
//   本组件独立交付（Task 3 才接入 MentionInput）；序列化纯函数层在 composer-segments.ts。
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ComposerSegment, PillKind, PillSeg } from './composer-segments';

/** pill 后随的零宽空格——光标落点；getSegments / 光标前文本一律剥离 */
const ZWSP = '\u200b';

/** pill 公共类（原子块视觉契约；Tailwind 类需静态字符串书写保证生成） */
const PILL_BASE_CLASS =
  'rounded px-1.5 text-xs leading-5 inline-flex items-center align-baseline select-none';

/** 五类 pill 语义底色（全语义 token，spec D-2 填充底色式） */
const PILL_CLASS: Record<PillKind, string> = {
  agent: 'bg-accent-600/10 text-accent-600 dark:text-accent-300',
  file: 'bg-surface-active text-secondary',
  skill: 'bg-status-violet-tint text-status-violet',
  command: 'bg-status-warning-tint text-status-warning',
  task: 'bg-status-success-tint text-status-success',
};

/** 选中态追加（两段式 Backspace 高亮 / 点击选中；data-selected="1" 同时落 DOM） */
const PILL_SELECTED_CLASS = 'ring-1 ring-accent-500';

/** 编辑器基类：placeholder 用 :empty 伪元素呈现；disabled 态条件追加 opacity-50（div 无 disabled 属性） */
const ROOT_CLASS =
  'w-full min-h-[2.6rem] max-h-48 overflow-y-auto bg-transparent px-3 pt-2 text-sm text-primary focus:outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-disabled disabled:opacity-50';

/** pill 显示文本：命令无前缀图标（D-3——斜杠本身即前缀标识），无 emoji 图标 */
function pillDisplayText(pill: PillSeg): string {
  switch (pill.kind) {
    case 'agent':
      return `@${pill.label}`;
    case 'file':
      return pill.label; // label = 文件路径
    case 'task':
      return `#${pill.id} ${pill.label}`;
    case 'skill':
      return pill.label;
    case 'command':
      return `/${pill.id}`;
  }
}

/** 建 pill DOM 节点（data-* 是 getSegments 反向提取的契约） */
function buildPillNode(pill: PillSeg): HTMLSpanElement {
  const span = document.createElement('span');
  // 直接落 attribute（property 赋值在部分环境不反射——attribute 是最可靠的原子块契约）
  span.setAttribute('contenteditable', 'false');
  span.dataset.kind = pill.kind;
  span.dataset.id = pill.id;
  span.dataset.label = pill.label;
  span.className = `${PILL_BASE_CLASS} ${PILL_CLASS[pill.kind]}`;
  span.textContent = pillDisplayText(pill);
  return span;
}

function isPill(node: Node | null | undefined): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.dataset.kind !== undefined;
}

/** Task 3 依赖的 handle 契约（签名与 brief 逐字一致） */
export interface RichComposerHandle {
  focus(): void;
  moveCaretToEnd(): void;
  insertPill(pill: PillSeg, replaceLen: number): void;
  insertTextAtEnd(text: string): void;
  getSegments(): ComposerSegment[];
  setSegments(segs: ComposerSegment[]): void;
  clear(): void;
}

export interface RichComposerProps {
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  /** beforeCaret：光标前文本（pill 折叠单空格、剥 ZWSP——供触发检测）；allText：全文同规则 */
  onInputText(beforeCaret: string, allText: string): void;
  onEnter(): void;
  onEscape(): void;
}

export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(
  function RichComposer(
    { disabled, placeholder, ariaLabel, onInputText, onEnter, onEscape },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    /** IME 组字标记：compositionstart~end 之间不触发 onInputText、按键拦截逻辑跳过 */
    const composingRef = useRef(false);

    /** 光标落到指定节点末尾（文本节点取 length，元素取 childNodes.length） */
    const setCaretEndOf = (node: Node): void => {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      const end = node.nodeType === Node.TEXT_NODE ? (node as Text).length : node.childNodes.length;
      range.setStart(node, end);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    const moveCaretToEnd = (): void => {
      const root = rootRef.current;
      const sel = window.getSelection();
      if (!root || !sel) return;
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    /** 末尾追加 pill + ZWSP，返回 ZWSP 节点（光标落点） */
    const appendPillNode = (root: HTMLDivElement, pill: PillSeg): Text => {
      const zwsp = document.createTextNode(ZWSP);
      root.append(buildPillNode(pill), zwsp);
      return zwsp;
    };

    /**
     * 光标上下文：遍历 root——文本节点累加文字、pill 节点折叠为单个空格
     * （防 pill 文字与 @ 局部粘连误触发），统一剥 ZWSP。
     * 无有效选区时 before 兜底 = all（追加末尾语义，绝不让 getSelection 空态炸组件）。
     */
    const caretContext = (): { before: string; all: string } => {
      const root = rootRef.current;
      if (!root) return { before: '', all: '' };
      const sel = window.getSelection();
      let startContainer: Node | null = null;
      let startOffset = 0;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (root.contains(r.startContainer)) {
          startContainer = r.startContainer;
          startOffset = r.startOffset;
        }
      }
      let before = '';
      let all = '';
      let past = false;
      // entries 元组解构在 noUncheckedIndexedAccess 下仍是完整元素类型
      for (const [i, node] of Array.from(root.childNodes).entries()) {
        // 光标在 root 元素层：offset 起的节点都在光标后
        if (startContainer === root && !past && i >= startOffset) past = true;
        if (isPill(node)) {
          if (!past) before += ' ';
          all += ' ';
          continue;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const raw = node.textContent ?? '';
          if (!past) {
            if (node === startContainer) {
              before += raw.slice(0, startOffset);
              past = true;
            } else {
              before += raw;
            }
          }
          all += raw;
        }
      }
      if (startContainer === null) before = all;
      return { before: before.replaceAll(ZWSP, ''), all: all.replaceAll(ZWSP, '') };
    };

    const emitInput = (): void => {
      const { before, all } = caretContext();
      onInputText(before, all);
    };

    const getSegments = (): ComposerSegment[] => {
      const root = rootRef.current;
      if (!root) return [];
      const segs: ComposerSegment[] = [];
      for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent ?? '').replaceAll(ZWSP, '');
          if (text === '') continue; // ZWSP-only 节点剥空跳过
          const last = segs[segs.length - 1];
          if (last !== undefined && last.type === 'text') last.text += text; // 相邻文本节点合并
          else segs.push({ type: 'text', text });
        } else if (isPill(node)) {
          segs.push({
            type: 'pill',
            kind: node.dataset.kind as PillKind,
            id: node.dataset.id ?? '',
            label: node.dataset.label ?? '',
          });
        }
        // 其它节点类型忽略（防御——正常编辑协议下不产生）
      }
      return segs;
    };

    /** 重建 DOM（清空后逐段建节点；不经过 React children） */
    const setSegments = (segs: ComposerSegment[]): void => {
      const root = rootRef.current;
      if (!root) return;
      root.textContent = '';
      for (const seg of segs) {
        if (seg.type === 'text') root.append(document.createTextNode(seg.text));
        else appendPillNode(root, seg);
      }
    };

    const clear = (): void => {
      if (rootRef.current) rootRef.current.textContent = '';
    };

    /**
     * 在光标处删除最近 replaceLen 个触发字符（文本节点 deleteData，
     * offset < replaceLen 时防御性钳 0）→ 插 pill + ZWSP → 光标落 ZWSP 后；
     * 无有效选区时追加末尾。
     */
    const insertPill = (pill: PillSeg, replaceLen: number): void => {
      const root = rootRef.current;
      if (!root) return;
      const sel = window.getSelection();
      let c: Node | null = null;
      let offset = 0;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (root.contains(r.startContainer)) {
          c = r.startContainer;
          offset = r.startOffset;
        }
      }
      if (c === null) {
        const zwsp = appendPillNode(root, pill);
        setCaretEndOf(zwsp);
        return;
      }
      // 删除光标前 replaceLen 个触发字符
      if (c.nodeType === Node.TEXT_NODE && offset > 0 && replaceLen > 0) {
        const t = c as Text;
        const take = Math.min(replaceLen, offset);
        t.deleteData(offset - take, take);
        offset -= take;
      }
      const span = buildPillNode(pill);
      const zwsp = document.createTextNode(ZWSP);
      if (c.nodeType === Node.TEXT_NODE) {
        const t = c as Text;
        if (offset >= t.length) {
          t.after(span, zwsp);
        } else {
          const tail = t.splitText(offset);
          tail.before(span, zwsp);
        }
      } else if (c === root) {
        // root 元素层光标（moveCaretToEnd / insertTextAtEnd 后的形态）：
        // 触发局部在前一个子节点（若为文本节点）的尾部；前兄弟是 pill 等元素时无字符可删。
        // 空文本节点留待 getSegments 剥空清理——避免 offset 位移复杂化。
        if (replaceLen > 0 && offset > 0) {
          const prev = root.childNodes[offset - 1];
          if (prev !== undefined && prev.nodeType === Node.TEXT_NODE) {
            const pt = prev as Text;
            const take = Math.min(replaceLen, pt.length);
            if (take > 0) pt.deleteData(pt.length - take, take);
          }
        }
        const refNode = root.childNodes[offset];
        if (refNode !== undefined) {
          root.insertBefore(span, refNode);
          root.insertBefore(zwsp, refNode);
        } else {
          root.append(span, zwsp);
        }
      } else {
        // 选区在异常容器（防御）——追加末尾
        root.append(span, zwsp);
      }
      setCaretEndOf(zwsp);
    };

    /** 末尾追加文字：末可见字符非空白且非开头时补一个空格防粘连 + 光标到末尾 + 触发 onInputText */
    const insertTextAtEnd = (text: string): void => {
      const root = rootRef.current;
      if (!root || text === '') return;
      let insert = text;
      const last = root.lastChild;
      if (last && last.nodeType === Node.TEXT_NODE) {
        const visible = (last.textContent ?? '').replaceAll(ZWSP, '');
        if (visible.length > 0 && !/\s$/.test(visible)) insert = ` ${text}`;
        (last as Text).appendData(insert);
      } else {
        // 空编辑器，或末节点异常（协议下 pill 后必有 ZWSP 文本节点）——新建文本节点
        root.append(document.createTextNode(insert));
      }
      moveCaretToEnd();
      emitInput();
    };

    const selectPill = (pill: HTMLSpanElement): void => {
      pill.dataset.selected = '1';
      pill.classList.add(...PILL_SELECTED_CLASS.split(' '));
    };

    const clearSelectedPills = (): void => {
      rootRef.current
        ?.querySelectorAll<HTMLSpanElement>('span[data-selected]')
        .forEach((p) => {
          delete p.dataset.selected;
          p.classList.remove(...PILL_SELECTED_CLASS.split(' '));
        });
    };

    const selectedPill = (): HTMLSpanElement | null =>
      rootRef.current?.querySelector<HTMLSpanElement>('span[data-selected]') ?? null;

    /** 删除 pill 连带其后 ZWSP（用户在 ZWSP 后打字时同一节点以 ZWSP 开头——只删首字符） */
    const removePill = (pill: HTMLSpanElement): void => {
      const next = pill.nextSibling;
      if (
        next !== null &&
        next.nodeType === Node.TEXT_NODE &&
        (next.textContent ?? '').startsWith(ZWSP)
      ) {
        (next as Text).deleteData(0, 1);
        if ((next.textContent ?? '') === '') next.remove();
      }
      pill.remove();
    };

    /** 光标是否紧邻 pill 之前（Backspace 目标判定）：
     *  文本节点 offset 0 且 previousSibling 为 pill，或所在文本节点为 pill 后的 ZWSP */
    const pillBeforeCaret = (): HTMLSpanElement | null => {
      const root = rootRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!range.collapsed || !root.contains(range.startContainer)) return null;
      const c = range.startContainer;
      if (c === root) {
        const prev = root.childNodes[range.startOffset - 1] ?? null;
        return isPill(prev) ? prev : null;
      }
      if (c.nodeType === Node.TEXT_NODE) {
        const t = c as Text;
        const atStart = t.textContent === ZWSP || range.startOffset === 0;
        if (atStart && isPill(t.previousSibling)) return t.previousSibling;
      }
      return null;
    };

    const handleInput = (): void => {
      if (composingRef.current) return;
      emitInput();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
      // IME 组字守卫（isComposing / keyCode 229 双保险）：一切拦截逻辑跳过
      if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // 阻止换行（Shift+Enter 走默认换行）
        onEnter();
        return;
      }
      if (e.key === 'Escape') {
        onEscape();
        return;
      }
      if (e.key === 'Backspace') {
        const pill = pillBeforeCaret();
        if (pill) {
          e.preventDefault();
          if (pill.dataset.selected === '1') {
            removePill(pill); // 第二次：整块删除（连带 ZWSP）
          } else {
            clearSelectedPills();
            selectPill(pill); // 第一次：仅高亮
          }
        } else {
          clearSelectedPills(); // 普通退格不清高亮会留 stale 选中态
        }
        return;
      }
      if (e.key === 'Delete') {
        const pill = selectedPill();
        if (pill) {
          e.preventDefault();
          removePill(pill);
        }
      }
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
      const target = e.target as HTMLElement;
      const pill = target.closest<HTMLSpanElement>('span[data-kind]');
      if (pill !== null && rootRef.current?.contains(pill)) {
        clearSelectedPills();
        selectPill(pill);
      } else {
        clearSelectedPills(); // 点击文字区清除选中态
      }
    };

    const handleCompositionStart = (): void => {
      composingRef.current = true;
    };

    // compositionend 后浏览器会派发 final input → 届时 emitInput；此处不重复触发
    const handleCompositionEnd = (): void => {
      composingRef.current = false;
    };

    // 省略 deps（每次渲染重建 handle）：回调 props（onEnter 等）闭包永远新鲜，
    // Task 3 每渲染传新函数时不会调到过期闭包
    useImperativeHandle(ref, () => ({
      focus: () => rootRef.current?.focus(),
      moveCaretToEnd,
      insertPill,
      insertTextAtEnd,
      getSegments,
      setSegments,
      clear,
    }));

    return (
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={disabled ? `${ROOT_CLASS} opacity-50` : ROOT_CLASS}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    );
  },
);
