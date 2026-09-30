// renderer/src/components/task-board/TaskDetailDrawer.tsx
//
// 任务详情抽屉（看板重构 Task 12，spec §5.1）：
//   - 右侧滑入壳：portal 到 body + fixed right w-[380px] bg-canvas border-l shadow，
//     transform 进场动画（GPU 合成；面板自身 transform 不影响遮罩——遮罩是兄弟层）
//   - 遮罩 bg-backdrop 点击关 + ESC 关（capture 阶段拦截，与 ui/Dialog 同款——
//     不与宿主视图其余 ESC 监听双触发）
//   - ESC 让位：抽屉内嵌弹窗（EditTaskDialog 等 Dialog 原子件，同为 capture +
//     stopImmediatePropagation 但注册晚于抽屉）打开时，抽屉先见到事件的监听器
//     主动放行——否则编辑中 ESC 会连抽屉一起关掉，未保存内容全没
//   - 内容：TaskDetailPanel 函数体包壳复用（props 不变，{taskId, onClose} 透传）；
//     主区互斥渲染退役（Task 12 起看板常驻，抽屉叠加）
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { TaskDetailPanel } from './TaskDetailPanel';

interface TaskDetailDrawerProps {
  taskId: string;
  onClose: () => void;
}

export function TaskDetailDrawer({ taskId, onClose }: TaskDetailDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  // 进场动画：mount 后下一帧从 translate-x-full 滑到 0
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 抽屉自身也是 role=dialog——只让位给「非自身」的弹窗（EditTaskDialog 等）
      const nestedDialogOpen = Array.from(document.querySelectorAll('[role="dialog"]')).some(
        (el) => el !== drawerRef.current,
      );
      if (nestedDialogOpen) return;
      // capture 阶段最先执行，阻断同窗口其余 Esc 监听（ui/Dialog 同款语义）
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  return createPortal(
    <>
      {/* 遮罩与抽屉均从 TitleBar(h-10) 下沿开始:顶部 40px 是
          -webkit-app-region: drag 拖拽区,覆盖其上的元素若不设 no-drag,
          点击会被拖拽区吞掉(抽屉头部的编辑/关闭按钮不可点的根因) */}
      <div
        data-testid="drawer-backdrop"
        aria-hidden
        className="fixed bottom-0 left-0 right-0 top-10 z-50 bg-backdrop"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        className={cn(
          'fixed bottom-0 right-0 top-10 z-50 flex w-[380px] flex-col border-l border-subtle bg-canvas shadow-2xl transition-transform duration-200 ease-out',
          entered ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <TaskDetailPanel taskId={taskId} onClose={onClose} />
      </aside>
    </>,
    document.body,
  );
}
