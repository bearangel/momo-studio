// renderer/src/components/task-board/GroupMenu.tsx
//
// 分组菜单（看板重构 Task 14）：MoreHorizontal 触发的下拉菜单——重命名（菜单内
// 联输入，或经 onRenameRequest 委托宿主行内编辑）/ 换色（GROUP_PALETTE 固定
// 5 语义色色板 + react-colorful 应用内取色器自定义 hex）/ 归档组
// （ConfirmDialog 确认，文案 N 实时算）。
//
// 点外关闭（UX 波 2 #4）：菜单打开时渲染全屏透明遮罩（fixed inset-0，照
// BoardCard 右键菜单先例）；details 本体 z 序抬高——再点触发按钮本身仍切换。
//
// 两处消费：Lane 泳道头（Task 12 占位实装）与 GroupManageList 行菜单——
// 逻辑全部走 useGroupActions 公共 hook，行为单源。
//
// 单开纪律（修复「A 组菜单开着再点 B，A 残留叠加、点击穿透错乱」）：
// 上述两类宿主同屏共存，各实例自持 open state 必然多菜单叠加。改为模块级
// zustand 迷你 store 持唯一打开实例 key——打开 B 即占位，A（任意宿主）自然
// 关闭。实例 key 用 useId 而非组 id：同组在侧边栏行与泳道头双宿主同时可见，
// 用组 id 会在两处同开。这是对「open 状态上提宿主」侵入最小的等价实现——
// 无需经 SortableGroupRow / Lane / BoardCanvas 逐层穿受控 props，两类宿主
// 天然互斥。z 序：遮罩 z-40、打开的 details（含菜单）z-50，单开后全页同时
// 至多一遮罩一菜单。
//
// 自定义取色（react-colorful 应用内取色器，替换原生 input type=color）：macOS
// 原生无模式色板会盖住面板内的「应用」按钮，且三平台体验不一致。现全部应用内：
//   1) HexColorPicker onChange（拖动连发）→ 只更本地预览 state（hex 文本 + 色块
//      + 取色器本体受控联动），零 IPC——不发请求故无洪泛；
//   2) 预览旁「应用」Button（sm/primary）→ 显式提交该 hex + 关菜单（唯一提交
//      路径，应用即关故无重复 IPC 面）；
//   3) 预设 5 语义色块行为不变：点击即应用即关。
// 取色器初始值 = 当前组色映射 hex（groupColorHex：语义名→亮色主题 hex / 自定义
// hex 原值 / 无色兜底 #5e6ad2）。样式：react-colorful 自带样式经 globals.css 的
// .group-menu-picker 作用域覆写（约 180×140、圆角与边框对齐设计系统）。
//
// 可达性细节：details 用受控 open（jsdom 不派发 summary 默认激活行为，显式
// onClick 切换保证测试确定性）；菜单内容仅在 open 时渲染（关闭态不落 DOM，
// 避免宿主测试的 role 查询误命中菜单项）。
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { MoreHorizontal } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { groupColorHex, groupColorStyle } from '../../lib/board';
import type { GroupRow } from '../../ipc/types';
import { Button } from '../ui/Button';
import { GROUP_PALETTE, useGroupActions } from './useGroupActions';

/** 组菜单单开状态（模块级，跨宿主互斥）：唯一打开实例 key；null=全关 */
interface GroupMenuOpenState {
  openMenuId: string | null;
  /** 占位单开：传实例 key 打开（其余菜单自然关）；null 全关 */
  setOpenMenuId: (id: string | null) => void;
}

const useGroupMenuOpenStore = create<GroupMenuOpenState>((set) => ({
  openMenuId: null,
  setOpenMenuId: (id) => set({ openMenuId: id }),
}));

interface GroupMenuProps {
  group: GroupRow;
  /** 触发器可及名（区分宿主：如「分组菜单 组A」/「泳道菜单 组A」） */
  triggerLabel: string;
  /** 重命名委托：传入则菜单只触发回调（宿主自行行内编辑），缺省在菜单内输入 */
  onRenameRequest?: () => void;
}

export function GroupMenu({ group, triggerLabel, onRenameRequest }: GroupMenuProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  /** 实例唯一 key：同组双宿主（侧边栏行 + 泳道头）也互斥 */
  const menuId = useId();
  // 受控 open：内部 open state 已移除，唯一真相在模块级单开 store
  const open = useGroupMenuOpenStore((s) => s.openMenuId === menuId);
  const setOpenMenuId = useGroupMenuOpenStore((s) => s.setOpenMenuId);
  /** 菜单内模式：idle 常规三项 / rename 内联输入 / color 色板 */
  const [mode, setMode] = useState<'idle' | 'rename' | 'color'>('idle');
  const [renameValue, setRenameValue] = useState('');
  /** 自定义取色实时预览（进入换色模式时以 groupColorHex(group.color) 重置）；
      取色器 onChange 零 IPC 只更此 state */
  const [customColorPreview, setCustomColorPreview] = useState<string>(() =>
    groupColorHex(group.color),
  );
  const { runRename, runSetColor, requestArchive, archiveConfirm } = useGroupActions(
    group.workspaceId,
  );

  const closeMenu = useCallback((): void => {
    setOpenMenuId(null);
    setMode('idle');
  }, [setOpenMenuId]);

  // 卸载清位：本实例菜单开着时被卸载（如组被归档导致行消失）→ 清 store 占位
  //（useId 跨挂载可能复用同值，残留占位会让新实例误判已开）
  useEffect(() => {
    return () => {
      const s = useGroupMenuOpenStore.getState();
      if (s.openMenuId === menuId) s.setOpenMenuId(null);
    };
  }, [menuId]);

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

  /** 「应用」显式提交：以预览 hex 落定（唯一提交路径）+ 关菜单（应用即关，无重复 IPC 面） */
  const applyCustomColor = (): void => {
    void runSetColor(group.id, customColorPreview);
    closeMenu();
  };

  /** 取色器 onChange：只更本地预览（实时，零 IPC）；react-colorful 恒发合法 hex，toLowerCase 规整 */
  const handleCustomColorChange = (hex: string): void => {
    setCustomColorPreview(hex.toLowerCase());
  };

  return (
    <>
      {open && (
        <div
          aria-hidden
          data-testid="group-menu-overlay"
          className="fixed inset-0 z-40"
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
        onToggle={(e) => {
          // 外部因素改变 open 属性（非本组件点击路径）→ 同步回单开 store；
          // 守卫防受控渲染自身的回环
          const next = (e.target as HTMLDetailsElement).open;
          if (next !== open) setOpenMenuId(next ? menuId : null);
        }}
        className={`relative ml-auto ${open ? 'z-50' : 'z-20'}`}
      >
        <summary
          aria-label={triggerLabel}
          className="cursor-pointer list-none rounded px-0.5 leading-none text-tertiary hover:text-primary [&::-webkit-details-marker]:hidden"
          onClick={(e) => {
            // jsdom/浏览器统一走显式切换（受控 open）；打开即占位唯一 key，
            // 其余任意宿主的组菜单自然关闭（单开纪律）
            e.preventDefault();
            if (open) {
              setOpenMenuId(null);
            } else {
              setMode('idle');
              setOpenMenuId(menuId);
            }
          }}
        >
          <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
        </summary>
        {open && (
          <div
            className={`absolute right-0 z-10 mt-1 ${
              mode === 'color' ? 'w-56' : 'w-40'
            } rounded-md border border-subtle bg-canvas py-1 text-xs shadow-lg`}
          >
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
                  onClick={() => {
                    // 进入色板前以当前组色重置预览（取色器初始值）
                    setCustomColorPreview(groupColorHex(group.color));
                    setMode('color');
                  }}
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
              <div className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
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
                </div>
                {/* 应用内取色器（react-colorful）：onChange 只更本地预览 state（实时，
                    零 IPC）；提交唯一走下方「应用」。样式经 globals.css 的
                    .group-menu-picker 作用域覆写（约 180×140、圆角/边框对齐设计系统） */}
                <div className="group-menu-picker mt-1.5">
                  <HexColorPicker color={customColorPreview} onChange={handleCustomColorChange} />
                </div>
                {/* hex 只读预览行：色块 backgroundColor 为用户内容色（自定义 hex），
                    同预设色点豁免设计系统禁 inline 色 */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full border border-subtle"
                    style={{ backgroundColor: customColorPreview }}
                  />
                  <span className="font-mono text-xs text-secondary">{customColorPreview}</span>
                  <Button size="sm" className="ml-auto" onClick={applyCustomColor}>
                    应用
                  </Button>
                </div>
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
