// GlobalSettings 扩展测试：auditQuotaMb 默认 100 + 四类默认模型（DefaultModelRef）往返。
// P2 只存不消费：向量/重排 2.1 知识库启用，会话 fallback P3 接线。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getGlobalSettings, updateGlobalSettings } from '../../src/main/settings/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-global-defaults-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('GlobalSettings 扩展', () => {
  it('默认 auditQuotaMb = 100，四类默认模型未配置（undefined）', () => {
    const s = getGlobalSettings();
    expect(s.auditQuotaMb).toBe(100);
    expect(s.defaultChatModel).toBeUndefined();
    expect(s.defaultMultimodalModel).toBeUndefined();
    expect(s.defaultEmbeddingModel).toBeUndefined();
    expect(s.defaultRerankModel).toBeUndefined();
  });

  it('更新 auditQuotaMb 且不丢 maxToolCalls', () => {
    updateGlobalSettings({ auditQuotaMb: 500 });
    const s = getGlobalSettings();
    expect(s.auditQuotaMb).toBe(500);
    expect(s.maxToolCalls).toBe(10);
  });

  it('四类默认模型读写往返', () => {
    updateGlobalSettings({
      defaultChatModel: { providerId: 'p1', modelId: 'glm-5.2' },
      defaultMultimodalModel: { providerId: 'p1', modelId: 'glm-4.5v' },
      defaultEmbeddingModel: { providerId: 'p2', modelId: 'embedding-3' },
      defaultRerankModel: { providerId: 'p2', modelId: 'reranker-v2' },
    });
    const s = getGlobalSettings();
    expect(s.defaultChatModel).toEqual({ providerId: 'p1', modelId: 'glm-5.2' });
    expect(s.defaultMultimodalModel).toEqual({ providerId: 'p1', modelId: 'glm-4.5v' });
    expect(s.defaultEmbeddingModel).toEqual({ providerId: 'p2', modelId: 'embedding-3' });
    expect(s.defaultRerankModel).toEqual({ providerId: 'p2', modelId: 'reranker-v2' });
  });

  it('部分更新默认模型不影响其他字段', () => {
    updateGlobalSettings({ auditQuotaMb: 200, defaultChatModel: { providerId: 'p1', modelId: 'm' } });
    updateGlobalSettings({ defaultEmbeddingModel: { providerId: 'p2', modelId: 'e' } });
    const s = getGlobalSettings();
    expect(s.auditQuotaMb).toBe(200);
    expect(s.defaultChatModel).toEqual({ providerId: 'p1', modelId: 'm' });
    expect(s.defaultEmbeddingModel).toEqual({ providerId: 'p2', modelId: 'e' });
  });

  it('老数据兼容：kv_store 只存 maxToolCalls 的 v1 JSON 读出时补 auditQuotaMb=100', () => {
    // 直接写老形状 JSON，模拟 v1 升级库（无 auditQuotaMb 字段）
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run('global_settings', JSON.stringify({ maxToolCalls: 30 }));
    const s = getGlobalSettings();
    expect(s.maxToolCalls).toBe(30);
    expect(s.auditQuotaMb).toBe(100);
  });
});
