// renderer/src/components/im/SessionGroupColorPopover.tsx
// 会话分组换色浮层（2026-10-23 对齐任务看板 GroupMenu 换色模式，用户指定参照）：
// 6 预设 swatch（当前色打勾，点选即应用即关）+ 应用内取色器 react-colorful
// （onChange 只更本地预览，零 IPC）+ hex 只读预览 + 「应用」显式提交即关。
// 取代旧 GroupPalette 行内色板（选色后不消失 / ＋号 hex 输入框反直觉两问题）。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HexColorPicker } from 'react-colorful';
import { Check } from 'lucide-react';
import { GROUP_COLOR_PALETTE, groupDotColor, type GroupColorTheme } from '../../lib/group-colors';
import type { SessionGroupRow } from '../../ipc/types';
import { Button } from '../ui/Button';

const POPOVER_WIDTH_PX = 260;
const VIEWPORT_MARGIN_PX = 8;

interface Props {
  /** 弹出坐标（右键点，经视口钳制） */
  x: number;
  y: number;
  group: SessionGroupRow;
  theme: GroupColorTheme;
  /** 应用色（预设点击与「应用」按钮两条提交路径都走此回调） */
  onPick: (color: string) => void;
  onClose: () => void;
}

export function SessionGroupColorPopover({ x, y, group, theme, onPick, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  /** 取色器实时预览（进入时以当前组色重置；onChange 零 IPC） */
  const [preview, setPreview] = useState<string>(group.color.toLowerCase());

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // 浮层锚在 fixed 坐标：滚动/resize 直接关（GroupMenu 先例，不做跟锚重算）
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // 视口钳制（与 SessionContextMenu.MenuShell 同规则）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos({
      left: Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - VIEWPORT_MARGIN_PX)),
      top: Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - VIEWPORT_MARGIN_PX)),
    });
  }, [x, y]);

  return (
    <>
      {createPortal(
        <>
          <div
            data-testid="color-popover-overlay"
            className="fixed inset-0 z-40"
            onClick={onClose}
            onContextMenu={(e) => {
              e.preventDefault();
              onClose();
            }}
          />
          <div
            ref={panelRef}
            data-testid="session-color-popover"
            role="dialog"
            aria-label="设置组色"
            style={{ left: pos.left, top: pos.top }}
            className="fixed z-50 w-[260px] max-w-[min(260px,calc(100vw-16px))] rounded-md border border-subtle bg-canvas py-1 text-xs shadow-lg"
          >
            <div className="px-3 py-2">
              <div className="flex items-center gap-2">
                {GROUP_COLOR_PALETTE.map((hex) => {
                  // swatch 展示色走暗主题提亮档；落库恒发浅档字面量（canonical）
                  const dotStyle: CSSProperties = { backgroundColor: groupDotColor(hex, theme) };
                  const current = group.color.toLowerCase() === hex.toLowerCase();
                  return (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`设为${hex}`}
                      title={hex}
                      onClick={() => {
                        onPick(hex);
                        onClose();
                      }}
                      className={`flex h-[22px] w-[22px] items-center justify-center rounded-md border border-subtle transition-shadow hover:border-strong hover:ring-1 hover:ring-strong ${
                        current ? 'ring-1 ring-focus' : ''
                      }`}
                      style={dotStyle}
                    >
                      {current && (
                        <Check size={12} strokeWidth={2} aria-hidden className="text-inverse drop-shadow" />
                      )}
                    </button>
                  );
                })}
              </div>
              {/* 取色器样式复用 globals.css 的 .group-menu-picker 作用域覆写（232×150） */}
              <div className="group-menu-picker mt-2 flex justify-center">
                <HexColorPicker color={preview} onChange={(hex) => setPreview(hex.toLowerCase())} />
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 rounded-sm border border-subtle"
                  style={{ backgroundColor: preview }}
                />
                <span className="font-mono text-xs text-secondary">{preview}</span>
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    onPick(preview);
                    onClose();
                  }}
                >
                  应用
                </Button>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
