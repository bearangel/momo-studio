// renderer/src/components/workspace/TakeoverIndicator.tsx
//
// v2.7 McpBrowser 接管徽标（spec §3.5）：user 态显示 warning 徽标 +「释放」按钮
// （→ ipc.browser.releaseTakeover）；agent 态不渲染（agent 自由操作，无需释放）。
import { MousePointer } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface Props {
  takeover: 'agent' | 'user';
  onRelease: () => void;
}

export function TakeoverIndicator({ takeover, onRelease }: Props) {
  if (takeover !== 'user') return null;
  return (
    <div className="flex items-center gap-1">
      <Badge tone="warning">
        <MousePointer size={16} strokeWidth={1.75} aria-hidden />
        用户接管中
      </Badge>
      <Button variant="ghost" size="sm" onClick={onRelease}>
        释放
      </Button>
    </div>
  );
}
