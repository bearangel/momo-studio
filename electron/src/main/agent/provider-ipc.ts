// electron/src/main/agent/provider-ipc.ts
//
// provider:* IPC handler 注册。testConnection 发最小 OpenAI 兼容 chat completion
// 验证 baseUrl+apiKey+model 连通（沿用 v1.0 baseUrl 不拼 /v1 的策略）。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  listProviders, getProvider, createProvider, updateProvider,
  deleteProvider, setDefaultProvider, getProviderApiKey,
} from './provider-crud';

interface TestConnectionInput { baseUrl: string; apiKey: string; model: string; }
interface TestConnectionResult { ok: boolean; error?: string; }

/** 发最小 chat completion 请求验证连通性（不落库） */
export async function testProviderConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  try {
    const url = input.baseUrl.endsWith('/v1')
      ? `${input.baseUrl}/chat/completions`
      : `${input.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 注册 provider:* handlers。重复注册被 Electron 拒绝，仅调用一次。 */
export function registerProviderHandlers(): void {
  ipcMain.handle('provider:list', () => listProviders());

  ipcMain.handle('provider:get', (_e, id: string) => getProvider(id));

  ipcMain.handle('provider:create', (_e, input: Parameters<typeof createProvider>[0]) =>
    createProvider(input),
  );

  ipcMain.handle('provider:update', (_e, input: Parameters<typeof updateProvider>[0]) =>
    updateProvider(input),
  );

  ipcMain.handle('provider:delete', (_e, id: string) => {
    void deleteProvider(id);
    return { ok: true };
  });

  ipcMain.handle('provider:setDefault', (_e, id: string) => {
    setDefaultProvider(id);
    return { ok: true };
  });

  // 测试连通：用指定 baseUrl+apiKey+model 发最小请求（不读 DB，供"添加供应商"对话框实时验证）
  ipcMain.handle('provider:testConnection', (_e, input: TestConnectionInput) =>
    testProviderConnection(input),
  );

  // 供 agent 创建表单填充用：按 id 取 apiKey（不随 list 返回）
  ipcMain.handle('provider:getApiKey', async (_e, id: string) => getProviderApiKey(id));

  logger.info('Provider IPC handlers 已注册');
}
