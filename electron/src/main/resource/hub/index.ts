// electron/src/main/resource/hub/index.ts
//
// hub provider 静态注册表（spec §4.1）。2026-11-02 网络获取下线后仅 momo-hub
// 一源（smithery provider 已随注册表通道退役，存量已装行走 hub-install 的
// 本地映射与卸载）。
import { hubProvider } from './momo-hub';
import type { HubProvider } from './types';

export const HUB_PROVIDERS: readonly HubProvider[] = [hubProvider];
