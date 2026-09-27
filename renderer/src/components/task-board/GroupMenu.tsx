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
// 单开纪律（修复「A 组菜单开着再点 B，A 残留叠加、点击穿透错乱」）：
// 上述两类宿主同屏共存，各实例自持 open state 必然多菜单叠加。改为模块级
// zustand 迷你 store 持唯一打开实例 key——打开 B 即占位，A（任意宿主）自然
// 关闭。实例 key 用 useId 而非组 id：同组在侧边栏行与泳道头双宿主同时可见，
// 用组 id 会在两处同开。这是对「open 状态上提宿主」侵入最小的等价实现——
// 无需经 SortableGroupRow / Lane / BoardCanvas 逐层穿受控 props，两类宿主
// 天然互斥。z 序：遮罩 z-40、打开的 details（含菜单）z-50，单开后全页同时
// 至多一遮罩一菜单。
//
// 自定义取色（修复「点任意处秒关」）：只监听原生 change 事件（色板确认关闭
// 时触发一次）→ 提交保存 + 关菜单；React 的 onChange 映射原生 input 事件
// （macOS 原生色板拖动连发）完全弃用（不做实时预览，防 IPC 洪泛）；兜底
// onBlur 提交（部分平台 change 不触发）。见 mode==='color' 的 effect 与
// input onBlur。
//
// 可达性细节：details 用受控 open（jsdom 不派发 summary 默认激活行为，显式
// onClick 切换保证测试确定性）；菜单内容仅在 open 时渲染（关闭态不落 DOM，
// 避免宿主测试的 role 查询误命中菜单项）。
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { MoreHorizontal } from 'lucide-react';
import { groupColorStyle, isGroupHexColor } from '../../lib/board';
import type { GroupRow } from '../../ipc/types';
import { GROUP_PALETTE, useGroupActions } from './useGroupActions';

/** input type=color 初始值兜底（当前组色非 hex 时）：与 accent-500 同值的靛蓝 */
const DEFAULT_CUSTOM_COLOR = '#5e6ad2';

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
  /** 自定义取色 input 节点 + 一次性提交保险（change/blur 双路径防重复 IPC） */
  const colorInputRef = useRef<HTMLInputElement>(null);
  const colorCommittedRef = useRef(false);
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

  // 自定义取色只认原生 change：直接挂 DOM 监听——React 的 onChange 映射原生
  // input 事件（macOS 原生色板拖动连发 → 首个事件即提交+关菜单），必须弃用
  // 合成路径；同时绕开 React 合成事件的同值去重（input 先行后 change 被吞）。
  // input 事件完全忽略（不做实时预览，防 IPC 洪泛）：打开色板、拖动选色期间
  // 菜单不关，确认（change 触发一次）才保存 hex 并关菜单。
  useEffect(() => {
    if (mode !== 'color') return;
    const el = colorInputRef.current;
    if (el === null) return;
    const commit = (): void => {
      if (colorCommittedRef.current) return;
      colorCommittedRef.current = true;
      void runSetColor(group.id, el.value.toLowerCase());
      closeMenu();
    };
    el.addEventListener('change', commit);
    return () => {
      el.removeEventListener('change', commit);
    };
  }, [mode, group.id, runSetColor, closeMenu]);

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
                  onClick={() => {
                    // 进入色板前重置一次性提交保险
                    colorCommittedRef.current = false;
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
                {/* 自定义色（UX 波 2 #5）：原生 change（色板确认关闭时触发一次）
                    → effect 内监听提交小写 hex + 关菜单；input 事件（拖动连发）
                    完全忽略；不挂 React onChange（其映射原生 input 事件） */}
                <input
                  ref={colorInputRef}
                  type="color"
                  aria-label="自定义组色"
                  title="自定义颜色"
                  value={isGroupHexColor(group.color) ? group.color : DEFAULT_CUSTOM_COLOR}
                  // 占位 onChange：React 对受控 input 缺 onChange 会告警 read-only；
                  // 合成路径（映射原生 input 事件）在此完全忽略——只认原生 change
                  onChange={() => {}}
                  onBlur={(e) => {
                    // 兜底：部分平台原生 change 不触发 → 失焦提交当前值；
                    // 值未动过（没开过色板）则跳过——防失焦误吞同面板调色板点击
                    if (colorCommittedRef.current) return;
                    const initial = isGroupHexColor(group.color)
                      ? group.color
                      : DEFAULT_CUSTOM_COLOR;
                    if (e.target.value === initial) return;
                    colorCommittedRef.current = true;
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
