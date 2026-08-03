// renderer/src/lib/provider-helpers.ts
// 从 useProviderStore 查 provider 名字
import { useProviderStore } from '../stores/provider.store';

export function getProviderName(providerId: string | null): string {
  if (!providerId) return '未配置';
  const providers = useProviderStore.getState().providers;
  const p = providers.find((x) => x.id === providerId);
  return p?.name ?? '未知供应商';
}
