// renderer/src/components/workspace/DevServerDropdown.tsx
//
// v2.7 McpBrowser dev server 探活下拉（spec §3.5）：打开时现查 listDevServers
// （5173/3000/8080/4200/8000 五端口探活在主进程），点击存活项 → onPick(url)
// （父组件接 userNavigate——隐式接管入口）。探活失败 / 空列表 →「未发现开发服务器」。
// 每次打开重新探活——存活状态有时效性，不缓存上次结果。
import { useState } from 'react';
import { Monitor } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { BrowserDevServer } from '../../ipc/types';
import { cn } from '../../lib/cn';

interface Props {
  onPick: (url: string) => void;
}

export function DevServerDropdown({ onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<BrowserDevServer[] | null>(null);
  const [probing, setProbing] = useState(false);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) {
      setProbing(true);
      setServers(null);
      ipc.browser
        .listDevServers()
        .then(setServers)
        .catch(() => {
          // 探活失败视同未发现（IPC 边界容错——下拉不因单次失败白屏）
          setServers([]);
        })
        .finally(() => {
          setProbing(false);
        });
    }
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="开发服务器"
        aria-expanded={open}
        title="开发服务器探活"
        onClick={toggle}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          open
            ? 'bg-surface-3 text-primary'
            : 'text-secondary hover:bg-surface-3 hover:text-primary',
        )}
      >
        <Monitor size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-subtle bg-surface-2 py-1 shadow-lg">
          {probing ? (
            <p className="px-3 py-1.5 text-xs text-tertiary">探测中…</p>
          ) : servers !== null && servers.length > 0 ? (
            servers.map((server) => (
              <button
                key={server.port}
                type="button"
                className="block w-full px-3 py-1.5 text-left font-mono text-xs text-secondary hover:bg-surface-3 hover:text-primary"
                onClick={() => {
                  setOpen(false);
                  onPick(server.url);
                }}
              >
                {server.url}
              </button>
            ))
          ) : (
            <p className="px-3 py-1.5 text-xs text-tertiary">未发现开发服务器</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
