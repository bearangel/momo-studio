// renderer/src/components/agent/ProviderModelPicker.tsx
//
// 供应商→模型二级联动选择（受控组件，数据自理）。
// 三个 agent 表单（CreateAgentDialog / DefinitionEditor / MemberEditDialog 模型区）
// 的唯一模型数据入口——彻底取代 deprecated 的 provider.defaultModel 快填。
//
// 行为：
//   - 供应商下拉：数据来自 useProviderStore（挂载时 loadProviders），保留
//     「请选择...」空选项与「（默认）」标记
//   - 模型下拉：ipc.provider.listModels(providerId) 过滤 enabled，按 addedAt 升序
//     （后端已排好序，前端只过滤）；切换供应商时补发 onModelChange('') 联动重置
//   - 空态内嵌拉取：选中供应商但无已启用模型 → 「拉取模型列表」按钮
//     （fetchModels → addModel 逐个幂等入库 → listModels 刷新），模式与
//     settings/ProviderModelList.handleFetchAll 一致
//   - 模型列表按 providerId 缓存在 ref（弹窗内来回切供应商不重复拉取）
//   - D5（预览 S3 after）：providers 为空 → 双下拉禁用（供应商显示「暂无供应商」）
//     + warning 提示块 + 底部「去设置创建供应商」链接（openProviderSettings 切
//     视图即卸载宿主弹窗——EnablePresetDialog / AgentCreateWizard 均在视图分支内）
import { useEffect, useRef, useState } from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useProviderStore } from '../../stores/provider.store';
import { openProviderSettings } from '../../lib/open-provider-settings';
import { Select } from '../ui/Select';
import type { ProviderModel } from '../../ipc/types';

interface Props {
  providerId: string;
  modelId: string;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  disabled?: boolean;
  /** 选中模型变化时回传完整模型行（含 reasoning 能力；父组件驱动 ThinkingOverrideControl） */
  onModelInfo?: (m: ProviderModel | null) => void;
}

export function ProviderModelPicker({
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
  disabled,
  onModelInfo,
}: Props) {
  const { providers, loadProviders } = useProviderStore();
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // providerId → 模型列表缓存（避免弹窗内重复拉取）
  const cacheRef = useRef(new Map<string, ProviderModel[]>());
  // 当前 providerId 的 ref 镜像——handleFetch 异步完成后比对，供应商已切换则丢弃过期结果
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    // 切换供应商时无条件清掉上一供应商的残留 error（缓存命中/未选中路径也走这里）
    setError(null);
    if (!providerId) {
      setModels([]);
      return;
    }
    const cached = cacheRef.current.get(providerId);
    if (cached) {
      setModels(cached);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    ipc.provider
      .listModels(providerId)
      .then((list) => {
        cacheRef.current.set(providerId, list);
        if (!cancelled) setModels(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const enabledModels = models.filter((m) => m.enabled);

  // 选中模型信息回调：列表或选择变化时回传（含 reasoning 能力）
  useEffect(() => {
    onModelInfo?.(models.find((m) => m.modelId === modelId && m.enabled) ?? null);
  }, [models, modelId, onModelInfo]);

  // D5（预览 S3 after）：无供应商 → 空下拉不再裸奔，给出原因与出路。
  // 必须置于全部 hook 之后（提前 return 不影响 hook 顺序）。
  // D1（2026-10-23 验收）：openProviderSettings 切视图会卸载宿主弹窗（向导等
  // 已填表单随之丢失）——「去设置」首击只亮内联确认条，「仍要前往」才真正跳转。
  const [confirmLeave, setConfirmLeave] = useState(false);
  if (providers.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="provider-empty-guide">
        <Select label="模型供应商*" value="" onChange={() => undefined} disabled>
          <option value="">暂无供应商</option>
        </Select>
        <Select label="模型名" value="" onChange={() => undefined} disabled>
          <option value="">请先选择供应商</option>
        </Select>
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md bg-status-warning-tint px-3 py-2 text-xs text-status-warning"
        >
          <Info size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
          <span>暂无模型供应商。请先到 设置 → 模型服务 创建（如 GLM / DeepSeek / OpenAI）。</span>
        </div>
        <div className="text-center">
          {confirmLeave ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-2 text-xs">
              <span className="text-status-warning">跳转将关闭表单，已填内容不会保存</span>
              <button
                type="button"
                onClick={openProviderSettings}
                className="text-accent-600 dark:text-accent-300 underline underline-offset-2"
              >
                仍要前往
              </button>
              <button
                type="button"
                onClick={() => setConfirmLeave(false)}
                className="text-secondary underline underline-offset-2"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              className="text-xs text-accent-600 dark:text-accent-300 underline underline-offset-2"
            >
              去设置创建供应商 →
            </button>
          )}
        </div>
      </div>
    );
  }

  const handleProviderChange = (id: string): void => {
    onProviderChange(id);
    // 联动重置：换供应商即清空模型选择（spec §3.1——父组件只需正常响应两个回调）
    onModelChange('');
  };

  const handleFetch = async (): Promise<void> => {
    if (!providerId) return;
    const fetchProviderId = providerId;
    setFetching(true);
    setError(null);
    try {
      const ids = await ipc.provider.fetchModels(fetchProviderId);
      for (const id of ids) {
        await ipc.provider.addModel(fetchProviderId, id);
      }
      const list = await ipc.provider.listModels(fetchProviderId);
      cacheRef.current.set(fetchProviderId, list);
      // 供应商已切换：过期结果不落到新供应商的下拉（终审 Important 竞态守卫）
      if (providerIdRef.current === fetchProviderId) {
        setModels(list);
      }
    } catch (err) {
      if (providerIdRef.current === fetchProviderId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setFetching(false);
    }
  };

  const emptyOptionText = !providerId
    ? '请先选择供应商'
    : enabledModels.length > 0
      ? '请选择模型...'
      : loadingModels
        ? '加载中…'
        : '该供应商暂无模型';

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="模型供应商*"
        value={providerId}
        onChange={(e) => handleProviderChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">请选择...</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? '（默认）' : ''}
          </option>
        ))}
      </Select>
      <div className="flex flex-col gap-1">
        <Select
          label="模型名"
          value={modelId}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={disabled || !providerId}
        >
          <option value="">{emptyOptionText}</option>
          {enabledModels.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.modelId}
            </option>
          ))}
        </Select>
        {providerId && enabledModels.length === 0 && !loadingModels && (
          <button
            type="button"
            onClick={() => void handleFetch()}
            disabled={fetching}
            className="inline-flex w-fit items-center gap-1 rounded border border-subtle px-2 py-1 text-xs text-secondary hover:bg-surface-3 disabled:opacity-50"
          >
            {fetching ? (
              '拉取中…'
            ) : (
              <>
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden /> 拉取模型列表
              </>
            )}
          </button>
        )}
        {error && (
          <p className="text-xs text-status-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
