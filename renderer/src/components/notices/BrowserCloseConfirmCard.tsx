// renderer/src/components/notices/BrowserCloseConfirmCard.tsx
//
// 关闭浏览器确认卡（spec §6.4 / §9.3）：CenterPromptLayer 居中级阻断确认——
// agent 拥有 tab 时防误杀。锚点位移惯用法与既有居中卡一致（自带
// -translate-x/y-1/2；层锚点是 0×0 无 transform 定位点，见 CenterPromptLayer.tsx 头注）。
// 显隐由 browser-close-confirm store 驱动（BrowserSidebar 关闭钮发起 request）。
import { CircleAlert } from 'lucide-react';
import { useBrowserCloseConfirmStore } from '../../stores/browser-close-confirm.store';
import { Button } from '../ui/Button';

export function BrowserCloseConfirmCard() {
  const open = useBrowserCloseConfirmStore((s) => s.open);
  const confirm = useBrowserCloseConfirmStore((s) => s.confirm);
  const cancel = useBrowserCloseConfirmStore((s) => s.cancel);
  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-label="关闭浏览器确认"
      data-testid="browser-close-confirm"
      className="pointer-events-auto absolute flex w-80 flex-col gap-3 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-strong bg-surface-2 p-4 shadow-lg"
    >
      <div className="flex items-center gap-2 text-primary">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden />
        <span className="text-sm font-medium">关闭浏览器？</span>
      </div>
      <p className="text-xs text-secondary">
        有 agent 正在使用浏览器的标签页。关闭后其后续浏览器操作将失败（可重新导航打开新页面）。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>取消</Button>
        <Button variant="danger" onClick={confirm}>强制关闭</Button>
      </div>
    </div>
  );
}
