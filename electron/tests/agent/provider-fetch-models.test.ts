// fetchRemoteModels 行为测试（真实 DB + 内存 keychain + mock global.fetch）：
//   - 成功：GET {baseUrl}/models + Bearer keychain key，解析 data[].id
//   - 401 / 非 JSON / 坏形状（data 非数组 / 条目缺 id）→ 抛错
//   - SSRF 防护：镜像 testConnection 的校验——非本机 http 拒绝，本机回环 http 放行
//   - ghost provider → 供应商不存在
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createProvider, fetchRemoteModels } from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-fetch-models-${Date.now()}`);
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};
const fetchMock = vi.fn();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
  fetchMock.mockReset();
  global.fetch = fetchMock as never;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
  delete process.env.AP_USER_DATA_DIR;
});

describe('fetchRemoteModels 成功路径', () => {
  it('GET {baseUrl}/models 携带 Bearer key，解析 data[].id 返回字符串数组', async () => {
    const p = await createProvider({
      name: 'GLM', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test',
    });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }] }),
    });
    const models = await fetchRemoteModels(p.id);
    expect(models).toEqual(['glm-5.3', 'glm-5.2']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/models');
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('baseUrl 尾斜杠被裁掉后再拼 /models（镜像 testConnection 的 URL 构造）', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com/custom/', apiKey: 'k' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    await fetchRemoteModels(p.id);
    expect(fetchMock.mock.calls[0][0]).toBe('https://x.example.com/custom/models');
  });

  it('本机回环 http 放行（本地 Ollama 等无 https 场景）', async () => {
    const p = await createProvider({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'llama3' }] }),
    });
    const models = await fetchRemoteModels(p.id);
    expect(models).toEqual(['llama3']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/models');
  });
});

describe('fetchRemoteModels 失败路径', () => {
  it('HTTP 401 → 抛 HTTP 401', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com', apiKey: 'bad' });
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow(/HTTP 401/);
  });

  it('非 JSON 响应 → 抛解析错误', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com', apiKey: 'k' });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow(/JSON/);
  });

  it('data 非数组 → 抛格式错误', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com', apiKey: 'k' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: 'nope' }) });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow();
  });

  it('data 条目缺字符串 id → 抛格式错误', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com', apiKey: 'k' });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ object: 'model' }] }),
    });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow();
  });

  it('网络异常向上传播', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'https://x.example.com', apiKey: 'k' });
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(fetchRemoteModels(p.id)).rejects.toThrow(/ETIMEDOUT/);
  });
});

describe('fetchRemoteModels SSRF 防护（镜像 testConnection 校验）', () => {
  it('非本机 http 地址 → 抛「必须使用 https」且不发请求', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'http://192.168.1.5:8080/v1', apiKey: 'k' });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('baseUrl 非 http(s) scheme → 抛错', async () => {
    const p = await createProvider({ name: 'A', baseUrl: 'ftp://x.example.com', apiKey: 'k' });
    await expect(fetchRemoteModels(p.id)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchRemoteModels 前置校验', () => {
  it('供应商不存在 → 抛错', async () => {
    await expect(fetchRemoteModels('ghost-provider')).rejects.toThrow(/供应商不存在/);
  });
});
