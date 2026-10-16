// renderer/src/components/settings/PluginSettings.tsx
//
// 设置页「插件」分区（P4，spec §2.2 config / §6.1 设置页挂载点）——
// 按 manifest config JSON Schema 自动渲染表单：
//   string → Input（sensitive → 密码态 + 已配置/未配置 + 清除）
//   number → 数字 Input；boolean → Checkbox；enum → Select
// 敏感值明文永不回传（主进程只出在场布尔）；空输入 = 不变（overlay 语义），
// 清除按钮 → 显式 null。保存即生效（主进程重装配 MCP + 重启 service）。
// 无 config 声明的插件显示空态卡。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Puzzle } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import type { PluginConfigPropertyDecl, PluginConfigView, ResourceItem } from '../../ipc/types';

export function PluginSettings() {
  const [plugins, setPlugins] = useState<ResourceItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.resource
      .list({ type: 'plugin' })
      .then((items) => {
        if (alive) setPlugins(items.filter((i) => i.type === 'plugin' && i.plugin?.state === 'active' && i.plugin.id));
      })
      .catch((err) => {
        if (alive) setLoadError(ipcErrorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section aria-label="插件配置">
      <h2 className="text-base text-primary">插件</h2>
      <p className="mb-4 mt-1 text-xs leading-relaxed text-tertiary">
        各插件的配置项由其声明自动生成；保存后立即生效（MCP 重装配 / service 重启），无需重启应用。
      </p>
      {loadError && <p className="text-sm text-status-error">{loadError}</p>}
      {plugins.length === 0 && !loadError && (
        <p className="text-sm text-tertiary">尚未安装插件。前往资源库 → 插件页安装。</p>
      )}
      {plugins.map((p) => (
        <PluginConfigSection key={p.plugin!.id} pluginId={p.plugin!.id} pluginName={p.name} />
      ))}
    </section>
  );
}

interface PluginConfigSectionProps {
  pluginId: string;
  pluginName: string;
}

function PluginConfigSection({ pluginId, pluginName }: PluginConfigSectionProps) {
  const [view, setView] = useState<PluginConfigView | 'loading' | 'none'>('loading');
  const viewResolved: PluginConfigView =
    view === 'loading' || view === 'none'
      ? { schema: { properties: {}, required: [] }, values: {}, sensitiveConfigured: {} }
      : view;
  const [form, setForm] = useState<Record<string, string | number | boolean>>({});
  const [sensitiveInput, setSensitiveInput] = useState<Record<string, string>>({});
  const [clearedKeys, setClearedKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.plugin
      .getConfig(pluginId)
      .then((v) => {
        if (!alive) return;
        setView(v ?? 'none');
        if (v) setForm(v.values as Record<string, string | number | boolean>);
      })
      .catch(() => {
        if (alive) setView('none'); // 读取失败按无配置处理（分区级 loadError 已红字）
      });
    return () => {
      alive = false;
    };
  }, [pluginId]);

  const entries = useMemo(() => Object.entries(viewResolved.schema.properties), [viewResolved]);

  const requiredSet = useMemo(() => new Set(viewResolved.schema.required), [viewResolved]);

  const save = useCallback(async () => {
    setError(null);
    setSaved(false);
    const payload: Record<string, string | number | boolean | null> = {};
    for (const [key, decl] of entries) {
      if (decl.sensitive) {
        const typed = sensitiveInput[key];
        if (clearedKeys.has(key)) payload[key] = null;
        else if (typed !== undefined && typed !== '') payload[key] = typed;
      } else if (key in form && form[key] !== undefined) {
        payload[key] = form[key];
      }
    }
    try {
      const next = await ipc.plugin.setConfig(pluginId, payload);
      setView(next);
      setForm(next.values as Record<string, string | number | boolean>);
      setSensitiveInput({});
      setClearedKeys(new Set());
      setSaved(true);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  }, [entries, form, sensitiveInput, clearedKeys, pluginId]);

  if (view === 'loading') {
    return (
      <div className="mb-4 rounded-lg border border-subtle">
        <div className="border-b border-subtle bg-surface-1 px-4 py-3 text-[13px] font-medium text-primary">
          {pluginName}
        </div>
        <div className="px-4 py-6 text-center text-xs text-tertiary">配置读取中…</div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-subtle">
      <div className="flex items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-2.5">
        <Puzzle size={15} strokeWidth={1.75} className="text-accent-500" aria-hidden />
        <span className="text-[13px] font-medium text-primary">{pluginName}</span>
        <span className="font-mono text-[11px] text-tertiary">{pluginId}</span>
      </div>
      {entries.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-3.5 text-xs text-tertiary">
          <Puzzle size={14} strokeWidth={1.75} aria-hidden />
          此插件未声明配置项
        </div>
      ) : (
        <form
          className="flex flex-col gap-4 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {entries.map(([key, decl]) => (
            <ConfigField
              key={key}
              fieldKey={key}
              decl={decl}
              required={requiredSet.has(key)}
              value={form[key]}
              onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
              sensitiveTyped={sensitiveInput[key] ?? ''}
              onSensitiveChange={(v) => setSensitiveInput((s) => ({ ...s, [key]: v }))}
              configured={viewResolved.sensitiveConfigured[key] === true}
              willClear={clearedKeys.has(key)}
              onToggleClear={() =>
                setClearedKeys((s) => {
                  const next = new Set(s);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
          ))}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" size="sm">
              保存
            </Button>
            {saved && <span className="text-xs text-status-success">已保存，配置已生效</span>}
            {error && <span className="text-xs text-status-error">{error}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

interface ConfigFieldProps {
  fieldKey: string;
  decl: PluginConfigPropertyDecl;
  required: boolean;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
  sensitiveTyped: string;
  onSensitiveChange: (v: string) => void;
  configured: boolean;
  willClear: boolean;
  onToggleClear: () => void;
}

function ConfigField(props: ConfigFieldProps) {
  const { fieldKey, decl, required } = props;
  const label = decl.title ?? fieldKey;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`cfg-${fieldKey}`} className="text-[13px] text-secondary">
        {label}
        {required && <span className="ml-0.5 text-status-error">*</span>}
      </label>
      {decl.sensitive ? (
        <div className="flex items-center gap-2">
          <Input
            id={`cfg-${fieldKey}`}
            type="password"
            autoComplete="off"
            value={props.willClear ? '' : props.sensitiveTyped}
            disabled={props.willClear}
            placeholder={
              props.willClear
                ? '将清除（已配置的值）'
                : props.configured
                  ? '已配置 · 输入以更换'
                  : '未配置'
            }
            onChange={(e) => props.onSensitiveChange(e.currentTarget.value)}
            className="font-mono"
          />
          {props.configured && (
            <Button type="button" variant="secondary" size="sm" onClick={props.onToggleClear}>
              {props.willClear ? '撤销清除' : '清除'}
            </Button>
          )}
        </div>
      ) : decl.type === 'boolean' ? (
        <Checkbox
          id={`cfg-${fieldKey}`}
          checked={props.value === true}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      ) : decl.enum ? (
        <Select
          id={`cfg-${fieldKey}`}
          value={String(props.value ?? decl.enum[0])}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            props.onChange(decl.type === 'number' ? Number(raw) : raw);
          }}
        >
          {decl.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={`cfg-${fieldKey}`}
          type={decl.type === 'number' ? 'number' : 'text'}
          value={props.value === undefined ? '' : String(props.value)}
          onChange={(e) =>
            props.onChange(decl.type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value)
          }
          className={decl.type === 'string' ? 'font-mono' : undefined}
        />
      )}
      {decl.sensitive && props.configured && !props.willClear && (
        <span className="flex items-center gap-1 text-[11px] text-status-success">
          <KeyRound size={11} strokeWidth={1.75} aria-hidden />
          已存入系统钥匙串
        </span>
      )}
    </div>
  );
}
