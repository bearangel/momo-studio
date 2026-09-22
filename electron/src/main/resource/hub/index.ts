// electron/src/main/resource/hub/index.ts
//
// hub provider 静态注册表（spec §4.1）。内置市场不入此表——registryProviders
// IPC 单独合并 builtin 项（本地 catalog，零网络、永可用）。
import { smitheryProvider } from './smithery';
import { modelscopeProvider } from './modelscope';
import type { HubProvider } from './types';

export const HUB_PROVIDERS: readonly HubProvider[] = [smitheryProvider, modelscopeProvider];
