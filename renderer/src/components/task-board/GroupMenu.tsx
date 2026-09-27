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
// 自定义取色（修复「选完无处确认」）：macOS 原生色板无模式无确定钮，change
// 只在面板关闭时才触发——用户不知道怎么落定选择。现三路确认：
//   1) input 事件（拖动连发）→ 只更本地预览 state（hex 文本 + 色块 + input
//      本体受控联动），零 IPC——不发请求故无洪泛，「防洪泛弃预览」的理由消失；
//   2) 预览旁「应用」Button（sm/primary）→ 显式提交该 hex + 关菜单；
//   3) 原生 change（色板带选择关闭时触发一次）→ 兜底提交，与「应用」等价；
//      onBlur 兜底维持（部分平台 change 不触发）。
// 提交路径仍直接挂 DOM 监听绕开 React 合成事件（onChange ≙ 原生 input 且同值
// 去重，change 走合成路径会被先行 input 吞掉）。见 mode==='color' 的 effect、
// input onBlur 与预览行。
//
// 可达性细节：details 用受控 open（jsdom 不派发 summary 默认激活行为，显式
// onClick 切换保证测试确定性）；菜单内容仅在 open 时渲染（关闭态不落 DOM，
// 避免宿主测试的 role 查询误命中菜单项）。
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { MoreHorizontal } from 'lucide-react';
import { groupColorStyle, isGroupHexColor } from '../../lib/board';
import type { GroupRow } from '../../ipc/types';
import { Button } from '../ui/Button';
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
  /** 自定义取色实时预览（null=未动过原生色板，不渲染预览行）；input 事件零 IPC 只更此 state */
  const [customColorPreview, setCustomColorPreview] = useState<string | null>(null);
  /** 自定义取色 input 节点 + 一次性提交保险（应用/change/blur 三路径防重复 IPC） */
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

  // 自定义取色三路确认（见文件头）：input → 本地预览（零 IPC）；change → 兜底
  // 提交（与「应用」等价）。均直接挂 DOM 监听——React 的 onChange 映射原生
  // input 事件且对同值去重（change 若走合成路径会被先行 input 吞掉），提交
  // 路径必须绕开合成事件。
  useEffect(() => {
    if (mode !== 'color') return;
    const el = colorInputRef.current;
    if (el === null) return;
    const preview = (): void => {
      setCustomColorPreview(el.value.toLowerCase());
    };
    const commit = (): void => {
      if (colorCommittedRef.current) return;
      colorCommittedRef.current = true;
      void runSetColor(group.id, el.value.toLowerCase());
      closeMenu();
    };
    el.addEventListener('input', preview);
    el.addEventListener('change', commit);
    return () => {
      el.removeEventListener('input', preview);
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

  /** 「应用」显式提交：以预览 hex 落定（与 change 兜底路径等价）+ 关菜单 */
  const applyCustomColor = (): void => {
    if (customColorPreview === null || colorCommittedRef.current) return;
    colorCommittedRef.current = true;
    void runSetColor(group.id, customColorPreview);
    closeMenu();
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
                    // 进入色板前重置一次性提交保险 + 预览
                    colorCommittedRef.current = false;
                    setCustomColorPreview(null);
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
                  {/* 自定义色（UX 波 2 #5 + 选完无处确认修复）：input 事件 → effect
                      内原生监听只更预览 state（零 IPC）；提交走「应用」按钮，change
                      （色板确认关闭）/onBlur 为等价兜底。value 受控联动预览——
                      input 本体色块同步实时预览 */}
                  <input
                    ref={colorInputRef}
                    type="color"
                    aria-label="自定义组色"
                    title="自定义颜色"
                    value={
                      customColorPreview ??
                      (isGroupHexColor(group.color) ? group.color : DEFAULT_CUSTOM_COLOR)
                    }
                    // 占位 onChange：React 对受控 input 缺 onChange 会告警 read-only；
                    // 合成路径（映射原生 input 事件）在此完全忽略——预览与提交均走
                    // effect 内原生监听
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
                {/* 预览行（动过原生色板才出现）：hex 文本 + 色块 + 显式「应用」。
                    色块 backgroundColor 为用户内容色（自定义 hex），同预设色点豁免 */}
                {customColorPreview !== null && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-full border border-subtle"
                      style={{ backgroundColor: customColorPreview }}
                    />
                    <span className="font-mono text-xs text-secondary">{customColorPreview}</span>
                    <Button
                      size="sm"
                      className="ml-auto"
                      onClick={applyCustomColor}
                    >
                      应用
                    </Button>
                  </div>
                )}
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
