// renderer/src/components/ui/EmojiPicker.tsx
//
// 图标 emoji 选择器（2026-10-11 P1 预览批准稿）：触发器显示当前 emoji，
// 点击展开分类网格（emoji-presets.ts：6 类 × 16），点选即填。
//
// 取代 4 处 agent/team 表单的「图标」裸文本输入框（CreateAgentDialog /
// TeamDialog / DefinitionEditor / AgentCreateWizard）——iconEmoji 数据契约
// 不变（仍是 string），仅采集 UI 从自由输入改为预设选择。
//
// 弹层定位（溢出 bug 修复）：portal 到 document.body + position:fixed，
// 不再是锚点内 absolute——宿主 Dialog 内容区是 overflow-auto 滚动容器，
// absolute 弹层会被它裁剪（新建智能体向导：图标是末字段，弹层下半被
// 对话框底边截断，用户须滚对话框才能选；EmojiPicker.test 回归锁锁定）。
// 坐标取触发器 getBoundingClientRect：下方优先，视口放不下且上方放得下
// 则上翻；scroll（capture 捕获宿主内部滚动）/ resize 时跟随重定位。
//
// Esc 语义（EmojiPicker.test.tsx 专项用例锁定）：选择器展开时 Esc 只收起
// 选择器、不关闭宿主 Dialog——本组件的 window capture 监听注册于挂载时，
// 同一 commit 内 React 自底向上执行 effect，子组件先于 Dialog 注册故先
// 触发，open 时 stopImmediatePropagation 阻断 Dialog 的全局 Esc 关闭；
// 收起态直接放行，宿主 Esc 行为不变。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Smile } from 'lucide-react';
import { cn } from '../../lib/cn';
import { EMOJI_CATEGORIES, DEFAULT_CATEGORY } from './emoji-presets';

interface Props {
  /** 受控值：emoji 字符串（可不在预设集——触发器照显示，网格内无高亮） */
  value: string;
  /** 选中回调（点选即触发并收起） */
  onChange: (emoji: string) => void;
  /** 表单 label（渲染在触发器上方，对齐 Input 视觉节奏；同时是触发器 aria-label） */
  label?: string;
  /** 禁用（DefinitionEditor 只读态）：触发器不可点、不展开 */
  disabled?: boolean;
}

/** 弹层与触发器的间距 px */
const PANEL_GAP = 6;
/** 弹层贴视口边缘的安全距 px */
const VIEWPORT_MARGIN = 8;

export function EmojiPicker({ value, onChange, label = '图标', disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [activeCat, setActiveCat] = useState(DEFAULT_CATEGORY.key);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Esc 拦截用 open 镜像：监听只注册一次（挂载时），不随 open 重挂
  const openRef = useRef(false);
  openRef.current = open;

  const active = EMOJI_CATEGORIES.find((c) => c.key === activeCat) ?? DEFAULT_CATEGORY;

  /** 视口内摆位：下方优先 → 放不下且上方够则上翻 → 都不够贴底；左右钳制 */
  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const r = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = panel.offsetWidth || 300;
    const ph = panel.offsetHeight || 176;
    let top = r.bottom + PANEL_GAP;
    if (top + ph > vh - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, Math.min(r.top - PANEL_GAP - ph, vh - VIEWPORT_MARGIN - ph));
    }
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, r.left),
      Math.max(VIEWPORT_MARGIN, vw - pw - VIEWPORT_MARGIN),
    );
    setCoords({ top, left });
  }, []);

  // 展开与切分类后、首帧绘制前完成摆位（无闪跳）；coords 未定前弹层不可见
  useLayoutEffect(() => {
    if (open) place();
  }, [open, activeCat, place]);

  // Esc 拦截必须注册于挂载时（空依赖，openRef 镜像读开合）：并入 [open] 门控
  // effect 会在「展开时」才注册——晚于宿主 Dialog 的监听，capture 同序后注册
  // 后执行，stopImmediatePropagation 抢不到先手，Esc 会穿透关掉 Dialog
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !openRef.current) return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    // scroll 不冒泡但走 capture——宿主 Dialog 内容区滚动时弹层跟随触发器
    const onViewportChange = (): void => place();
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
    };
  }, [open, place]);

  // 外点收起：mousedown 落在锚点（触发器）或弹层（已 portal 到 body）之外才关；
  // 触发器自身的点击关停由 toggle 承担，不在此重复处理
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      const inside = anchorRef.current?.contains(target) || panelRef.current?.contains(target);
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    // 展开时定位到当前值所在分类（不在预设集 → 第一分类）
    const containing = EMOJI_CATEGORIES.find((c) => c.emojis.includes(value));
    setActiveCat(containing?.key ?? DEFAULT_CATEGORY.key);
    setCoords(null);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-secondary">{label}</span>
      <div ref={anchorRef} className="w-fit">
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={toggle}
          disabled={disabled}
          className={cn(
            'inline-flex w-[76px] items-center justify-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary',
            'hover:bg-surface-3',
            'disabled:cursor-not-allowed disabled:opacity-50',
            open && 'border-focus',
          )}
        >
          {value ? (
            <span className="text-[17px] leading-none">{value}</span>
          ) : (
            <Smile size={16} strokeWidth={1.75} aria-hidden />
          )}
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="text-tertiary" />
        </button>
        {open
          ? createPortal(
              <div
                ref={panelRef}
                role="group"
                aria-label={`${label}选择`}
                style={
                  coords
                    ? { position: 'fixed', top: `${coords.top}px`, left: `${coords.left}px` }
                    : { position: 'fixed', visibility: 'hidden' }
                }
                className="z-[60] w-[300px] rounded-lg border border-subtle bg-surface-2 p-2.5 shadow-lg"
              >
                <div className="mb-2.5 flex flex-wrap gap-1">
                  {EMOJI_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      aria-pressed={cat.key === activeCat}
                      onClick={() => setActiveCat(cat.key)}
                      className={cn(
                        'rounded-md px-2 py-0.5 text-xs text-secondary hover:bg-surface-3',
                        cat.key === activeCat && 'bg-surface-3 text-primary',
                      )}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-8 gap-0.5">
                  {active.emojis.map((emoji) => {
                    const selected = emoji === value;
                    return (
                      <button
                        key={emoji}
                        type="button"
                        aria-label={emoji}
                        aria-pressed={selected}
                        onClick={() => {
                          onChange(emoji);
                          setOpen(false);
                        }}
                        className={cn(
                          'flex aspect-square items-center justify-center rounded-md border text-lg leading-none hover:bg-surface-3',
                          selected ? 'border-focus bg-surface-active' : 'border-transparent',
                        )}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 border-t border-subtle pt-1.5 text-[11.5px] text-tertiary">
                  {`${value ? `当前：${value}` : '未选择'} · Esc 关闭`}
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
