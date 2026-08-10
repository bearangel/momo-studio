import { useState } from 'react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';

type Mode = 'standalone' | 'connect';

interface Props {
  onNext: (mode: Mode) => void;
  onBack: () => void;
}

export function ModeSelectStep({ onNext, onBack }: Props) {
  const [selected, setSelected] = useState<Mode>('standalone');

  return (
    <div className="flex flex-col gap-6 p-12">
      <h2 className="text-2xl font-bold">选择模式</h2>
      <div className="flex gap-4">
        <button
          type="button"
          aria-label="独立模式"
          className={cn(
            'flex-1 p-6 text-left rounded-lg border',
            selected === 'standalone'
              ? 'border-accent-blue bg-accent-blue/10'
              : 'border-border-subtle hover:border-border-strong',
          )}
          onClick={() => setSelected('standalone')}
        >
          <div className="text-lg font-semibold mb-2">独立模式（推荐）</div>
          <p className="text-sm text-neutral-400">
            内置本地服务端，无需外部依赖。首次使用推荐此模式。
          </p>
        </button>
        <button
          type="button"
          aria-label="连接已有服务端（即将推出）"
          className="flex-1 p-6 text-left rounded-lg border border-border-subtle opacity-50 cursor-not-allowed"
          disabled
        >
          <div className="text-lg font-semibold mb-2">
            连接已有服务端 <span className="text-xs text-neutral-500">（即将推出）</span>
          </div>
          <p className="text-sm text-neutral-400">
            连接你自己运行的服务端。将在后续版本提供。
          </p>
        </button>
      </div>
      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={onBack}>返回</Button>
        <Button onClick={() => onNext(selected)}>继续</Button>
      </div>
    </div>
  );
}
