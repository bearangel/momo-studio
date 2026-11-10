// renderer/src/components/oauth/McpNeedsAuthNotice.tsx
// 「需要授权」横幅（spec §13.4 / 预览 v2 区块 E）：注册或启动返回 needs_reauth 时展示。
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';

export function McpNeedsAuthNotice({ onAuthorize }: { onAuthorize: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-status-warning-tint px-3 py-2 text-sm text-status-warning">
      <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />
      <span className="grow">该服务器需要 OAuth 授权（HTTP 401）</span>
      <Button size="sm" variant="secondary" onClick={onAuthorize}>去授权</Button>
    </div>
  );
}
