// electron/src/main/oauth/presets.ts
//
// 常用服务预设（纯常量，不含密钥）。只提供端点与默认 scope；
// client_id 需用户自填（各服务要求不同，且平台无法替用户注册）。
import type { ManualAuthInput } from './service';

export interface ProviderPreset {
  key: string;
  label: string;
  input: Omit<ManualAuthInput, 'displayName'> & { displayName: string };
}

const PRESETS: ProviderPreset[] = [
  {
    key: 'github',
    label: 'GitHub',
    input: {
      displayName: 'GitHub',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      clientId: '',
      clientAuthMethod: 'client_secret_post',
      scopes: 'read:user',
      userinfoEndpoint: 'https://api.github.com/user',
      extraAuthorizeParams: {},
      extraTokenParams: {},
    },
  },
  {
    key: 'google',
    label: 'Google',
    input: {
      displayName: 'Google',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: '',
      clientAuthMethod: 'client_secret_post',
      scopes: 'openid email profile',
      userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
      extraTokenParams: {},
    },
  },
  {
    key: 'notion',
    label: 'Notion',
    input: {
      displayName: 'Notion',
      authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      clientId: '',
      clientAuthMethod: 'client_secret_basic',
      scopes: '',
      userinfoEndpoint: null,
      extraAuthorizeParams: { owner: 'user' },
      extraTokenParams: {},
    },
  },
];

/** 返回完整预设（含端点与默认 scope）——renderer 用它预先填满「自定义端点」表单 */
export function listPresets(): ProviderPreset[] {
  return PRESETS;
}

export function loadPreset(
  key: string
): (Omit<ManualAuthInput, 'displayName'> & { displayName: string }) | null {
  return PRESETS.find((p) => p.key === key)?.input ?? null;
}
