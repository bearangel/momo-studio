// renderer/src/components/ui/CopyButton.tsx
//
// 复制小按钮（消息级复制用）：复制源文 + 2s「已复制」反馈；
// onMouseDown preventDefault 防止点击清掉用户文本选区（opencode 同款细节）。
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props {
  text: string;
  className?: string;
  label?: string;
}

export function CopyButton({ text, className, label = '复制' }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    // 同步翻状态——用户点击立即看到「已复制」反馈
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 受限上下文回退：临时 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      document.execCommand('copy');
      ta.remove();
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        void handleCopy();
      }}
      className={cn(
        'inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded border border-subtle px-1.5 font-sans text-[11px] text-tertiary transition-opacity',
        className,
      )}
    >
      {copied ? (
        <Check size={11} strokeWidth={1.75} aria-hidden />
      ) : (
        <Copy size={11} strokeWidth={1.75} aria-hidden />
      )}
      {copied ? '已复制' : label}
    </button>
  );
}
