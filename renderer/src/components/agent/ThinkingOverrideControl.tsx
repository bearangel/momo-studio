// renderer/src/components/agent/ThinkingOverrideControl.tsx
//
// agent 级思维模式覆盖（spec §7.3）：跟随模型设置（null）/ 关闭 / 开启(+档位)。
// 受控组件：能力由父组件从 ProviderModelPicker 的 onModelInfo 取得；
// 能力 kind=none 时整体隐藏（该模型不支持思维模式）。
import type { ReasoningCapability, ThinkingConfig } from '../../ipc/types';

interface Props {
  capability: ReasoningCapability | null;
  value: ThinkingConfig | null;
  onChange: (v: ThinkingConfig | null) => void;
}

export function ThinkingOverrideControl({ capability, value, onChange }: Props): JSX.Element | null {
  if (!capability || capability.kind === 'none') return null;
  const mode = value?.mode ?? 'inherit';
  const effort = value?.effort ?? (capability.kind === 'effort' ? capability.default : null);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-secondary">
        思维模式
        <select
          aria-label="思维模式"
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'inherit') onChange(null);
            else if (v === 'off') onChange({ mode: 'off', effort: null });
            else onChange({ mode: 'on', effort });
          }}
          className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary"
        >
          <option value="inherit">跟随模型设置</option>
          <option value="off">关闭</option>
          <option value="on">开启</option>
        </select>
      </label>
      {capability.kind === 'effort' && mode === 'on' && (
        <label className="text-sm text-secondary">
          思维档位
          <select
            aria-label="思维档位"
            value={effort ?? capability.default}
            onChange={(e) => onChange({ mode: 'on', effort: e.target.value })}
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary"
          >
            {capability.values.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
