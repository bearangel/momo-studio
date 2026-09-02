// renderer/src/components/upgrade/UpgradeNotice.tsx
//
// P5 Task 2：v1.x → 2.0 旧库升级首启提示。
// 非模态卡片（fixed 右下角，无遮罩）：
//   - 标题「已升级到 Momo Studio 2.0」
//   - 说明：全新架构，历史数据未迁移；已自动导出会话与 agent 定义
//   - 导出目录（等宽字体 + user-select-all 可直接选中复制）
//   - 「知道了」按钮调 onDismiss
// null → 返回 null（不渲染）。
import { X } from 'lucide-react';
import { Button } from '../ui/Button';

export interface UpgradeNoticeProps {
  /** 导出目录绝对路径；null = 无标记，不渲染 */
  exportDir: string | null;
  /** 用户点击「知道了」触发；父组件清 state + 调 IPC dismiss */
  onDismiss: () => void;
}

export function UpgradeNotice({ exportDir, onDismiss }: UpgradeNoticeProps) {
  if (exportDir === null) return null;

  return (
    <div
      data-testid="upgrade-notice"
      className="fixed right-4 bottom-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h2 className="text-base font-semibold text-primary">已升级到 Momo Studio 2.0</h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭"
          className="text-tertiary hover:text-primary leading-none -mt-1"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <p className="text-secondary leading-relaxed mb-3">
        全新架构下，历史数据未迁移。已自动导出会话与 agent 定义到下方目录，可随时查阅或备份。
      </p>
      <div className="flex items-center gap-2 mb-3">
        <code
          // font-mono + select-all：点击或拖动选中即可复制，无需额外按钮
          className="flex-1 block border border-subtle bg-canvas rounded px-2 py-1.5 font-mono text-xs text-secondary select-all break-all"
        >
          {exportDir}
        </code>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDismiss}>知道了</Button>
      </div>
    </div>
  );
}
