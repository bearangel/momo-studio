// renderer/src/components/resource-library/ExternalMarketplacePopover.tsx
// 外部市场快捷打开（P2.3 spec §4）：三类型页工具栏按钮 + 绝对定位弹层。
// 弹层手法照 AddMenu（relative 容器 + absolute 面板 + document mousedown 收起），
// 另补 Esc 关闭（键盘可达性）。打开动作走 misc:openExternal（Task 2 接线，
// 主进程强制 https 校验）；点击后面板不关——可连开多个市场（spec §4）。
// 失败 → 面板内红字可重试、面板不关闭（spec §7）。momo-hub 预告卡无 url →
// 纯展示 div：无「打开」、无 button 角色（非禁用态欺骗，spec §7）。
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';
import { MARKETPLACES } from './external-marketplaces';

/** 面板标题（spec §4：按类型命名） */
const PANEL_TITLE: Record<ResourceType, string> = {
  agent: 'Agent 市场',
  mcp: 'MCP 市场',
  skill: 'Skill 市场',
};

/** 面板底部两行常驻小字（spec §4 原文，替代 toast 零新基建） */
const FOOTER_LINE_1 = '在浏览器打开 · 应用内不安装';
const FOOTER_LINE_2 =
  '回来怎么装：MCP 用＋菜单「粘贴 MCP JSON / 导入 .dxt .mcpb」；Skill 用＋菜单上传 zip；Agent 用＋菜单新建或导入';

export function ExternalMarketplacePopover({ type }: { type: ResourceType }) {
  const [open, setOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc / 点击外部关闭（mousedown 手法照 AddMenu，挂卸成对）
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);

  const links = MARKETPLACES[type];

  // 打开单个市场：异常进面板红字（可重试），面板保持开（spec §7）
  const handleOpen = async (url: string): Promise<void> => {
    setOpenError(null);
    try {
      await window.api.misc.openExternal(url);
    } catch (err) {
      setOpenError(`打开失败：${(err as Error).message}，可重试`);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1 h-7 px-3 rounded-md bg-surface-3 text-primary text-[13px] font-medium hover:bg-surface-active transition-colors"
        onClick={() => {
          setOpenError(null);
          setOpen((v) => !v);
        }}
      >
        <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
        外部市场
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={PANEL_TITLE[type]}
          className="absolute right-0 top-9 z-10 w-80 rounded-lg border border-subtle bg-surface-3 shadow-lg p-2"
        >
          <div className="px-2 pt-1 pb-2 text-[13px] font-semibold text-primary">
            {PANEL_TITLE[type]}
          </div>
          <div className="flex flex-col gap-0.5">
            {links.map((m) => {
              if (!m.url) {
                // 预告卡：无 url → 纯展示（不可点，无「打开」）
                return (
                  <div key={m.name} className="px-2 py-1.5 rounded-md cursor-default">
                    <span className="block text-[13px] text-primary">{m.name}</span>
                    <span className="block text-xs text-tertiary">{m.description}</span>
                  </div>
                );
              }
              const url = m.url;
              return (
                <button
                  key={m.name}
                  type="button"
                  className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-active transition-colors"
                  onClick={() => void handleOpen(url)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-[13px] text-primary">{m.name}</span>
                      <span className="block text-xs text-tertiary">{m.description}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-accent-600 dark:text-accent-300">
                      打开
                      <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {openError && (
            <div role="alert" className="px-2 py-1.5 text-xs text-status-error">
              {openError}
            </div>
          )}
          <div className="mt-2 border-t border-subtle px-2 pt-2 pb-1 flex flex-col gap-1">
            <p className="text-xs text-tertiary">{FOOTER_LINE_1}</p>
            <p className="text-xs text-tertiary">{FOOTER_LINE_2}</p>
          </div>
        </div>
      )}
    </div>
  );
}
