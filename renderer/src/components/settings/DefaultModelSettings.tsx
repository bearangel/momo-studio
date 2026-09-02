// renderer/src/components/settings/DefaultModelSettings.tsx
//
// 默认模型面板（P2 Task 7，照 settings.html「默认模型」原型）：
// 四张卡（lucide 图标：会话 / 多模态 / 向量 / 重排），后两张标注「2.1 知识库启用」
// 表示 P2 只存不消费；每卡两个联动下拉：provider（provider.store 列表）→ model
// （该 provider 的 enabled ProviderModel 列表）。选 provider 时拉
// ipc.provider.listModels；选中后保存走 ipc.settings.updateGlobal 写 DefaultModelRef。
// 清除按钮：把对应字段设为 undefined（updateGlobalSettings 的 spread 合并后 JSON.stringify
// 会丢弃该键，从而清空 kv_store 中的条目）。
import { useCallback, useEffect, useState } from 'react';
import { Library, MessageSquare, Eye, Dna, ArrowLeftRight, type LucideIcon } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useProviderStore } from '../../stores/provider.store';
import type { DefaultModelRef, GlobalSettings, ProviderModel } from '../../ipc/types';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';

interface CardSpec {
  icon: LucideIcon;
  title: string;
  desc: string;
  field: keyof Pick<
    GlobalSettings,
    'defaultChatModel' | 'defaultMultimodalModel' | 'defaultEmbeddingModel' | 'defaultRerankModel'
  >;
  futureBadge: boolean;
}

const CARDS: CardSpec[] = [
  { icon: MessageSquare, title: '会话模型', desc: 'agent 未配置时使用；任务标题生成等系统用途', field: 'defaultChatModel', futureBadge: false },
  { icon: Eye, title: '多模态模型', desc: '图片 / 文件理解（会话内附件）', field: 'defaultMultimodalModel', futureBadge: false },
  { icon: Dna, title: '向量模型', desc: '', field: 'defaultEmbeddingModel', futureBadge: true },
  { icon: ArrowLeftRight, title: '重排模型', desc: '', field: 'defaultRerankModel', futureBadge: true },
];

type PicksMap = Record<string, DefaultModelRef | undefined>;
type ModelsMap = Record<string, ProviderModel[]>;

export function DefaultModelSettings() {
  const { providers, loadProviders } = useProviderStore();
  const [picks, setPicks] = useState<PicksMap>({});
  const [modelsByProvider, setModelsByProvider] = useState<ModelsMap>({});
  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 一次性初始化：拉供应商 + 拉已保存字段 + 默认选首供应商首启用模型。
  // initDone flag 保证只跑一次（避免 providers 后续 store 更新重置 picks）。
  // try/catch 包裹三处 IPC 副作用：loadProviders / settings.getGlobal / provider.listModels，
  // 任一失败均暴露到 error 横幅，与 About 组件同模式；initDone 仍标记（避免一直重试，错误
  // 由用户在面板上看到后手动重渲染触发重试——后续如需重试按钮可在此接入）。
  const [initDone, setInitDone] = useState(false);
  useEffect(() => {
    if (initDone) return;
    void (async () => {
      try {
        await loadProviders();
        const providersList = useProviderStore.getState().providers;
        const g: GlobalSettings = await ipc.settings.getGlobal();
        const savedRefs: PicksMap = {
          defaultChatModel: g.defaultChatModel,
          defaultMultimodalModel: g.defaultMultimodalModel,
          defaultEmbeddingModel: g.defaultEmbeddingModel,
          defaultRerankModel: g.defaultRerankModel,
        };
        // 收集需要预拉的 providerId：已保存字段 + 首供应商（用于默认选择）
        const needList = new Set<string>();
        for (const ref of Object.values(savedRefs)) {
          if (ref) needList.add(ref.providerId);
        }
        const firstProvider = providersList[0];
        if (firstProvider) needList.add(firstProvider.id);
        const entries = await Promise.all(
          Array.from(needList).map(async (pid) => [pid, await ipc.provider.listModels(pid)] as const),
        );
        const models = Object.fromEntries(entries) as ModelsMap;
        setModelsByProvider(models);
        // 派生初始 picks：已保存字段直接用；未配置字段用首供应商首启用模型
        const next: PicksMap = {};
        for (const card of CARDS) {
          const saved = savedRefs[card.field];
          if (saved) {
            next[card.field] = saved;
            continue;
          }
          if (!firstProvider) continue;
          const firstPid = firstProvider.id;
          const enabled = (models[firstPid] ?? []).filter((m) => m.enabled);
          next[card.field] = { providerId: firstPid, modelId: enabled[0]?.modelId ?? '' };
        }
        setPicks(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInitDone(true);
      }
    })();
  }, [loadProviders, initDone]);

  const handleProviderChange = useCallback(async (field: string, providerId: string) => {
    // 先拉模型列表（若未缓存），再根据结果回填 modelId：默认选首启用模型。
    const fillModel = (models: ProviderModel[]): void => {
      const enabled = models.filter((m) => m.enabled);
      setPicks((prev) => ({
        ...prev,
        [field]: { providerId, modelId: enabled[0]?.modelId ?? '' },
      }));
    };
    const cached = modelsByProvider[providerId];
    if (cached) {
      fillModel(cached);
      return;
    }
    void ipc.provider.listModels(providerId).then((list) => {
      setModelsByProvider((cur) => ({ ...cur, [providerId]: list }));
      fillModel(list);
    });
  }, [modelsByProvider]);

  const handleModelChange = useCallback((field: string, modelId: string) => {
    setPicks((prev) => {
      const cur = prev[field];
      if (!cur) return prev;
      return { ...prev, [field]: { providerId: cur.providerId, modelId } };
    });
  }, []);

  const handleSave = useCallback(async (field: keyof GlobalSettings, ref: DefaultModelRef | undefined) => {
    setSavingField(field);
    setSavedField(null);
    setError(null);
    try {
      await ipc.settings.updateGlobal({ [field]: ref } as Partial<GlobalSettings>);
      setSavedField(field);
      setTimeout(() => setSavedField((s) => (s === field ? null : s)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingField(null);
    }
  }, []);

  const handleClear = useCallback((field: keyof GlobalSettings) => {
    setPicks((prev) => ({ ...prev, [field]: undefined }));
    void handleSave(field, undefined);
  }, [handleSave]);

  const noProviders = providers.length === 0;

  return (
    <div className="space-y-4 max-w-[560px]">
      <h2 className="text-base text-primary">默认模型</h2>
      <p className="text-sm text-secondary">Agent 未显式配置模型时的 fallback 与系统内部用途。四类各选「供应商 + 模型」。</p>

      {error && <p className="text-xs text-status-error" role="alert">{error}</p>}

      {noProviders && (
        <EmptyState
          icon={Library}
          title="暂无供应商，先在模型服务添加供应商。"
        />
      )}

      <div className="flex flex-col gap-3">
        {CARDS.map((card) => {
          const pick = picks[card.field];
          const enabledModels = pick
            ? (modelsByProvider[pick.providerId] ?? []).filter((m) => m.enabled)
            : [];
          const noModels = !!pick && enabledModels.length === 0;
          const Icon = card.icon;
          return (
            <div key={card.field} className="rounded-lg border border-subtle bg-surface-1 p-4"
              data-testid={`dm-card-${card.field}`}>
              <div className="flex items-center gap-2 mb-3">
                <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span className="text-sm font-medium text-primary">{card.title}</span>
                {card.futureBadge && (
                  <span className="text-[10.5px] px-2 py-0.5 rounded bg-status-warning-tint text-status-warning">2.1 知识库启用</span>
                )}
                {card.desc && <span className="text-[11px] text-tertiary ml-auto text-right">{card.desc}</span>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.4fr] gap-2">
                <label className="text-[11px] text-secondary">
                  供应商
                  <Select
                    aria-label="供应商"
                    value={pick?.providerId ?? ''}
                    onChange={(e) => void handleProviderChange(card.field, e.target.value)}
                    disabled={providers.length === 0}
                    className="mt-1"
                  >
                    {providers.length === 0 && <option value="" disabled>请先添加供应商</option>}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </label>
                <label className="text-[11px] text-secondary">
                  模型
                  <Select
                    aria-label="模型"
                    value={pick?.modelId ?? ''}
                    onChange={(e) => handleModelChange(card.field, e.target.value)}
                    disabled={!pick || noModels}
                    className="mt-1"
                  >
                    {!pick && <option value="" disabled>先选择供应商</option>}
                    {pick && noModels && <option value="" disabled>先在模型服务添加模型</option>}
                    {pick && !noModels && enabledModels.map((m) => (
                      <option key={m.modelId} value={m.modelId}>{m.modelId}</option>
                    ))}
                  </Select>
                </label>
              </div>

              {noModels && (
                <p className="text-[11px] text-tertiary mt-2">该供应商暂无已启用模型，请先在模型服务添加模型。</p>
              )}

              <div className="flex items-center gap-2 mt-3">
                <span className="flex-1" />
                <Button type="button" variant="ghost" size="sm" disabled={!pick} onClick={() => handleClear(card.field)}>
                  清除
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!pick || !pick.modelId || savingField === card.field}
                  onClick={() => void handleSave(card.field, pick)}
                >
                  {savingField === card.field ? '保存中…' : '保存'}
                </Button>
                {savedField === card.field && <span className="text-xs text-status-success">已保存</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
