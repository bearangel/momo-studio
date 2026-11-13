// probeModels（spec 2026-11-13 §3.2）：未落库先拉 /models、平台头分派、10s 真中断、200 截断。
// mock 打在 global.fetch（真实 Response 形状）；probeModels 是纯函数（不触 DB / keychain），
// 但模块 import 链需要 DB 环境——按 provider-fetch-models.test 同款临时库惯例初始化。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { probeModels } from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-probe-models-${Date.now()}`);

let fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
function ok(models: string[]): Response {
  return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fetched = [];
  vi.stubGlobal(
    'fetch',
    async (url: string, init?: RequestInit) => {
      fetched.push({ url: String(url), init });
      return ok(['m-b', 'm-a']);
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('probeModels', () => {
  const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' } as const;

  it('openai 平台：Bearer 头 + {base}/models + 升序返回', async () => {
    const r = await probeModels({ ...base, platform: 'openai' });
    expect(r).toEqual({ models: ['m-a', 'm-b'], truncated: false });
    expect(fetched[0]!.url).toBe('https://api.example.com/v1/models');
    const h = fetched[0]!.init!.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer sk-x');
  });

  it('anthropic 平台：x-api-key + anthropic-version 头（修正现行 Bearer 通吃）', async () => {
    await probeModels({ ...base, platform: 'anthropic' });
    const h = fetched[0]!.init!.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-x');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['Authorization']).toBeUndefined();
  });

  it('401 → 中文错误明示 key 无效', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(probeModels({ ...base, platform: 'openai' })).rejects.toThrow(
      /API Key 无效或无权限/,
    );
  });

  it('超 200 条 → 截断 + truncated:true', async () => {
    vi.stubGlobal(
      'fetch',
      async () => ok(Array.from({ length: 300 }, (_, i) => `m-${i}`)),
    );
    const r = await probeModels({ ...base, platform: 'openai' });
    expect(r.models).toHaveLength(200);
    expect(r.truncated).toBe(true);
  });

  it('10s 超时真中断（AbortController）', async () => {
    vi.stubGlobal(
      'fetch',
      (_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init!.signal!.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.useFakeTimers();
    const p = probeModels({ ...base, platform: 'openai' });
    const assertion = expect(p).rejects.toThrow(/获取模型列表超时/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it('非 JSON / 形状不符 → 中文错误', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 200 }));
    await expect(probeModels({ ...base, platform: 'openai' })).rejects.toThrow(
      /响应不是有效 JSON/,
    );
  });

  it('入参空值拒绝（baseUrl / apiKey）', async () => {
    await expect(
      probeModels({ baseUrl: '  ', apiKey: 'sk-x', platform: 'openai' }),
    ).rejects.toThrow(/不能为空/);
  });
});
