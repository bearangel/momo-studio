// renderer/src/components/workspace/AddressBar.tsx
//
// v2.7 McpBrowser 地址栏（spec §3.5）：Enter 提交导航（隐式接管的用户入口，
// onNavigate 由父组件接 ipc.browser.userNavigate）。
//   - 非法输入（空 / new URL 不可解析 / 协议不在白名单）静默不触发——保留输入可修正
//   - 协议白名单与主进程 policy.assertUrl 对齐（http/https/file）；裸域名不代拼协议
//     （主进程 new URL 同样拒绝，两端语义一致）
//   - onNavigate 拒绝 → 行内展示主进程结构化中文错误（域名拦截 / 协议拒绝等）
//   - props.url 由 onBrowserState 推送驱动，变化时同步显示；Escape 回退到当前 url
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';

interface Props {
  /** 当前 tab url（状态推送驱动；空 tab 为空串） */
  url: string;
  /** 导航提交（返回 Promise 透传 IPC 拒绝——调用方用 ipc.browser.userNavigate） */
  onNavigate: (url: string) => Promise<void>;
}

/** 客户端 URL 校验：new URL 可解析 + 协议白名单（与 policy.assertUrl 三协议对齐） */
function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:'
    );
  } catch {
    return false;
  }
}

export function AddressBar({ url, onNavigate }: Props) {
  const [value, setValue] = useState(url);
  const [error, setError] = useState<string | null>(null);

  // 状态推送同步显示（agent 侧 navigate / tab 切换都会改当前 url）
  useEffect(() => {
    setValue(url);
  }, [url]);

  const submit = (): void => {
    const candidate = value.trim();
    if (!isValidUrl(candidate)) return; // 非法输入不触发（不清空不报错——保持输入可修正）
    setError(null);
    void onNavigate(candidate)
      .then(() => {
        // 成功后显示先对齐导航目标（推送到达前的过渡帧）
        setValue(candidate);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex h-7 items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-2 focus-within:border-focus">
        <Globe size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-tertiary" />
        <input
          type="text"
          aria-label="地址栏"
          spellCheck={false}
          autoComplete="off"
          placeholder="输入 URL 后回车"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-primary outline-none placeholder:text-tertiary"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submit();
            } else if (e.key === 'Escape') {
              setValue(url);
              setError(null);
            }
          }}
        />
      </div>
      {error ? <p className="px-1 text-xs text-status-error">{error}</p> : null}
    </div>
  );
}
