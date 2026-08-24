// electron/src/main/agent/provider-ipc.ts
//
// provider:* IPC handler 注册。testConnection 发最小 OpenAI 兼容 chat completion
// 验证 baseUrl+apiKey+model 连通（沿用 v1.0 baseUrl 不拼 /v1 的策略）。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  listProviders, getProvider, createProvider, updateProvider,
  deleteProvider, setDefaultProvider, getProviderApiKey,
  fetchRemoteModels, listProviderModels, upsertProviderModel,
  setProviderModelEnabled, removeProviderModel,
} from './provider-crud';

interface TestConnectionInput { baseUrl: string; apiKey: string; model: string; }
interface TestConnectionResult { ok: boolean; error?: string; }

/** 本机回环域名（允许 http，如本地 Ollama）；非本机必须 https 防 MITM/凭据外泄 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** 发最小 chat completion 请求验证连通性（不落库） */
export async function testProviderConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  // P3 Task 2：model 缺省（空/纯空白）→ 立即返回结构化错误，避免向远端发 model='' 的探测请求
  // 拿到 400/422 也只能让对端报错文案穿透；此处直接在源头拦掉，与 Renderer 端 ProviderDialog
  // 删「'gpt-3.5-turbo' 硬编码兜底」配套——配置卡 model='' 也能拿到友好提示。
  if (!input.model?.trim()) {
    return { ok: false, error: '请先填写模型名或在模型服务页拉取模型列表' };
  }
  // scheme 校验：仅 http(s)；http 仅允许本机（本地 Ollama 等），非本机必须 https
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    return { ok: false, error: 'baseUrl 格式无效' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: '仅支持 http/https 协议' };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return { ok: false, error: '非本机地址必须使用 https（防止凭据被截获）' };
  }
  try {
    const base = input.baseUrl.replace(/\/$/, '');
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    // 不回传远端响应体（消除 SSRF 读出通道），仅回状态码
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
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

  ipcMain.handle('provider:delete', async (_e, id: string) => {
    await deleteProvider(id);
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

  // ─── 模型列表管理（Task 6）────────────────────────────────────────────────
  // fetchModels 失败（网络/401/形状不符/ghost）直接抛错 → IPC error 传给 renderer

  ipcMain.handle('provider:fetchModels', (_e, id: string) => fetchRemoteModels(id));

  ipcMain.handle('provider:listModels', (_e, id: string) => listProviderModels(id));

  ipcMain.handle('provider:addModel', (_e, id: string, modelId: string) => {
    upsertProviderModel(id, modelId);
  });

  ipcMain.handle('provider:setModelEnabled', (_e, id: string, modelId: string, enabled: boolean) => {
    setProviderModelEnabled(id, modelId, enabled);
  });

  ipcMain.handle('provider:removeModel', (_e, id: string, modelId: string) => {
    removeProviderModel(id, modelId);
  });

  logger.info('Provider IPC handlers 已注册');
}
