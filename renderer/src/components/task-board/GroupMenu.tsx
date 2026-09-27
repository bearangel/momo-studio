// renderer/src/components/task-board/GroupMenu.tsx
//
// 分组菜单（看板重构 Task 14）：MoreHorizontal 触发的下拉菜单——重命名（菜单内
// 联输入，或经 onRenameRequest 委托宿主行内编辑）/ 换色（GROUP_PALETTE 固定
// 5 语义色色板 + 原生 input type=color 自定义 hex，UX 波 2 #5）/ 归档组
// （ConfirmDialog 确认，文案 N 实时算）。
//
// 点外关闭（UX 波 2 #4）：菜单打开时渲染全屏透明遮罩（fixed inset-0，照
// BoardCard 右键菜单先例）；details 本体 z 序抬高——再点触发按钮本身仍切换。
//
// 两处消费：Lane 泳道头（Task 12 占位实装）与 GroupManageList 行菜单——
// 逻辑全部走 useGroupActions 公共 hook，行为单源。
//
// 可达性细节：details 用受控 open（jsdom 不派发 summary 默认激活行为，显式
// onClick 切换保证测试确定性）；菜单内容仅在 open 时渲染（关闭态不落 DOM，
// 避免宿主测试的 role 查询误命中菜单项）。
import { useRef, useState, type CSSProperties } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { groupColorStyle, isGroupHexColor } from '../../lib/board';
import type { GroupRow } from '../../ipc/types';
import { GROUP_PALETTE, useGroupActions } from './useGroupActions';

/** input type=color 初始值兜底（当前组色非 hex 时）：与 accent-500 同值的靛蓝 */
const DEFAULT_CUSTOM_COLOR = '#5e6ad2';

interface GroupMenuProps {
  group: GroupRow;
  /** 触发器可及名（区分宿主：如「分组菜单 组A」/「泳道菜单 组A」） */
  triggerLabel: string;
  /** 重命名委托：传入则菜单只触发回调（宿主自行行内编辑），缺省在菜单内输入 */
  onRenameRequest?: () => void;
}

export function GroupMenu({ group, triggerLabel, onRenameRequest }: GroupMenuProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  /** 菜单内模式：idle 常规三项 / rename 内联输入 / color 色板 */
  const [mode, setMode] = useState<'idle' | 'rename' | 'color'>('idle');
  const [renameValue, setRenameValue] = useState('');
  const { runRename, runSetColor, requestArchive, archiveConfirm } = useGroupActions(
    group.workspaceId,
  );

  const closeMenu = (): void => {
    setOpen(false);
    setMode('idle');
  };

  const handleRenameClick = (): void => {
    if (onRenameRequest) {
      onRenameRequest();
      closeMenu();
      return;
    }
    setRenameValue(group.name);
    setMode('rename');
  };

  const submitRename = (): void => {
    const name = renameValue.trim();
    closeMenu();
    if (name !== '' && name !== group.name) void runRename(group.id, name);
  };

  return (
    <>
      {open && (
        <div
          aria-hidden
          data-testid="group-menu-overlay"
          className="fixed inset-0 z-10"
          onClick={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        />
      )}
      <details
        ref={menuRef}
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
        className="relative z-20 ml-auto"
      >
        <summary
          aria-label={triggerLabel}
          className="cursor-pointer list-none rounded px-0.5 leading-none text-tertiary hover:text-primary [&::-webkit-details-marker]:hidden"
          onClick={(e) => {
            // jsdom/浏览器统一走显式切换（受控 open）
            e.preventDefault();
            if (!open) setMode('idle');
            setOpen(!open);
          }}
        >
          <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
        </summary>
        {open && (
          <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-subtle bg-canvas py-1 text-xs shadow-lg">
            {mode === 'idle' && (
              <>
                <button
                  type="button"
                  className="block w-full px-3 py-1 text-left text-secondary hover:bg-surface-2"
                  onClick={handleRenameClick}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1 text-left text-secondary hover:bg-surface-2"
                  onClick={() => setMode('color')}
                >
                  换色
                </button>
                <button
                  type="button"
                  className="block w-full px-3 py-1 text-left text-secondary hover:bg-surface-2"
                  onClick={() => {
                    requestArchive(group);
                    closeMenu();
                  }}
                >
                  归档组
                </button>
              </>
            )}
            {mode === 'rename' && (
              <div className="px-2 py-1">
                <input
                  aria-label={`菜单内重命名${group.name}`}
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename();
                    if (e.key === 'Escape') closeMenu();
                  }}
                  className="w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-xs text-primary focus:border-focus focus:outline-none"
                />
              </div>
            )}
            {mode === 'color' && (
              <div className="flex items-center gap-1.5 px-3 py-1.5">
                {GROUP_PALETTE.map((color) => {
                  const css = groupColorStyle(color);
                  // 组色点：语义 token 的 CSS 变量串 / 自定义 hex 原值（用户内容色，
                  // 豁免设计系统禁 inline 色——UI chrome 才受限）；未知色回退中性
                  const dotStyle: CSSProperties = css
                    ? { backgroundColor: css }
                    : { backgroundColor: 'rgb(var(--text-tertiary))' };
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={`设为${color}`}
                      title={color}
                      onClick={() => {
                        void runSetColor(group.id, color);
                        closeMenu();
                      }}
                      className={`rounded-full border border-subtle ${
                        group.color === color ? 'ring-1 ring-focus' : ''
                      }`}
                      style={dotStyle}
                    >
                      <span className="block h-3 w-3" aria-hidden />
                    </button>
                  );
                })}
                {/* 自定义色（UX 波 2 #5）：选色即存 hex（小写入库），存后关菜单 */}
                <input
                  type="color"
                  aria-label="自定义组色"
                  title="自定义颜色"
                  value={isGroupHexColor(group.color) ? group.color : DEFAULT_CUSTOM_COLOR}
                  onChange={(e) => {
                    void runSetColor(group.id, e.target.value.toLowerCase());
                    closeMenu();
                  }}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-full border border-subtle bg-transparent p-0"
                />
              </div>
            )}
          </div>
        )}
      </details>
      {/* 归档确认框（useGroupActions 持有文案与级联刷新逻辑） */}
      {archiveConfirm}
    </>
  );
}
