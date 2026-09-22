// electron/src/main/resource/hub/modelscope.ts
//
// 魔搭社区 provider（spec §4.1）——Task 0 降级裁定后的骨架实现：
// OpenAPI 端点探测 404×3、检索未获公开文档化 MCP 列表接口（见
// .superpowers/sdd/task-0-api-verify.md「魔搭 ModelScope——降级裁定」），
// 故常驻 degraded、零网络。P3 复核 API 后按 smithery.ts 同构补实现
// （字段映射届时以复核结论为准）。
import type { HubListResult, HubProvider } from './types';

export const modelscopeProvider: HubProvider = {
  key: 'modelscope',
  label: '魔搭社区',
  region: 'cn',
  types: ['mcp'],
  async list(type): Promise<HubListResult> {
    if (type !== 'mcp') throw new Error(`魔搭暂只支持 MCP（收到 ${type}）`);
    // 骨架版恒 degraded：UI 置灰展示 provider 占位，不发任何网络请求
    return { entries: [], degraded: true };
  },
};

/** registryProviders IPC 消费——骨架版恒 true（降级裁定，P3 复核后恢复） */
export function isModelScopeDegraded(): boolean {
  return true;
}
