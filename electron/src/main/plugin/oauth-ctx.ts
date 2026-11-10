// electron/src/main/plugin/oauth-ctx.ts
//
// 插件 ctx.oauth（spec §12.3，本轮只读）。
// 信任边界：getAccessToken 把 token 交给插件 service 进程，语义等价 ctx.secrets——
// 插件是用户本地安装的代码，已有同级别能力；文档必须明示。
// listConnections 只交付元数据（连接 id / 展示名 / 账号 / 状态 / 过期时间），
// 绝不携带任何 token 字段——插件 UI 场景（如账号选择器）无需也不应见到密文。
import { listConnectionViews } from '../oauth/service';
import { loadTokenSet } from '../oauth/keys';

/** 插件可见的连接摘要（ConnectionView 的安全子集：去掉 scopes / source） */
export interface PluginOAuthConnectionSummary {
  id: string;
  displayName: string;
  accountLabel: string;
  status: 'connected' | 'needs_reauth' | 'revoked';
  expiresAt: string | null;
}

export interface PluginOAuthApi {
  listConnections(): Promise<PluginOAuthConnectionSummary[]>;
  /** 注意：token 跨进程暴露给插件，信任级别等价 ctx.secrets（用户本地安装代码） */
  getAccessToken(connectionId: string): Promise<string | null>;
}

export function buildPluginOAuthApi(): PluginOAuthApi {
  return {
    listConnections: async () =>
      listConnectionViews().map((c) => ({
        id: c.id,
        displayName: c.displayName,
        accountLabel: c.accountLabel,
        status: c.status,
        expiresAt: c.expiresAt,
      })),
    getAccessToken: async (connectionId) => {
      const set = await loadTokenSet(connectionId);
      return set?.accessToken ?? null;
    },
  };
}
