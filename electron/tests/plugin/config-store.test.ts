// electron/tests/plugin/config-store.test.ts
//
// T5 RED：插件 config 双轨存储（spec §2.2 config / §7.1 data 目录 / key 裁定 111 行）——
// Schema v1 子集校验、敏感→keytar / 非敏感→config.json 原子写、
// 写入值校验（类型/枚举/未知键/required 终态）、明文不外泄、缓存 overlay。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  readPluginConfigJson,
  normalizeConfigSchema,
  writePluginConfig,
  getPluginConfigView,
  resolvePluginConfig,
  warmPluginConfigCache,
  sensitiveRef,
} from '../../src/main/plugin/config-store';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { resolvePluginDataDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pcfg-'));
const vault = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const SCHEMA = {
  type: 'object',
  properties: {
    indexCommand: { type: 'string', title: '索引构建命令' },
    apiToken: { type: 'string', title: 'API Token', sensitive: true },
    watchDebounce: { type: 'number', title: '监听防抖（ms）' },
    enableWatch: { type: 'boolean', title: '启用文件监听' },
    engine: { type: 'string', title: '索引引擎', enum: ['sqlite', 'walk'] },
  },
  required: ['indexCommand'],
};

function dataJson(id: string): string {
  return path.join(resolvePluginDataDir(id), 'config.json');
}

describe('Schema v1 子集校验（拒绝式）', () => {
  it('合法 schema → 归一化通过', () => {
    expect(() => normalizeConfigSchema(SCHEMA)).not.toThrow();
  });

  it.each([
    ['type 非 object', { ...SCHEMA, type: 'array' }],
    ['properties 非对象', { type: 'object', properties: 'x' }],
    ['属性 type 越界（integer）', { type: 'object', properties: { a: { type: 'integer' } } }],
    ['键非 slug', { type: 'object', properties: { 'BAD KEY': { type: 'string' } } }],
    ['未知属性字段', { type: 'object', properties: { a: { type: 'string', pattern: '^x$' } } }],
    ['required 键不存在', { type: 'object', properties: { a: { type: 'string' } }, required: ['ghost'] }],
    ['enum 非数组', { type: 'object', properties: { a: { type: 'string', enum: 'x' } } }],
  ])('%s → throw', (_n, raw) => {
    expect(() => normalizeConfigSchema(raw)).toThrow();
  });
});

const SCHEMA_N = normalizeConfigSchema(SCHEMA);

describe('双轨写入', () => {
  it('非敏感 → config.json（盘上可读回）', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'codegraph index' });
    expect(readPluginConfigJson('cg')).toEqual({ indexCommand: 'codegraph index' });
    expect(JSON.parse(fs.readFileSync(dataJson('cg'), 'utf-8'))).toEqual({ indexCommand: 'codegraph index' });
  });

  it('敏感 → keytar（键名 plugin.<id>.config.<KEY>），不落 config.json', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-secret' });
    expect(vault.get(sensitiveRef('cg', 'apiToken'))).toBe('sk-secret');
    expect(fs.readFileSync(dataJson('cg'), 'utf-8')).not.toContain('sk-secret');
  });

  it('敏感 null → 删除钥匙串条目', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-1' });
    await writePluginConfig('cg', SCHEMA_N, { apiToken: null });
    expect(vault.has(sensitiveRef('cg', 'apiToken'))).toBe(false);
  });

  it('overlay 语义：缺省键保持现值（表单空输入=不变）', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'v1', watchDebounce: 300 });
    await writePluginConfig('cg', SCHEMA_N, { watchDebounce: 500 });
    expect(readPluginConfigJson('cg')).toEqual({ indexCommand: 'v1', watchDebounce: 500 });
  });

  it('非敏感 null → 从 config.json 删除键', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', watchDebounce: 300 });
    await writePluginConfig('cg', SCHEMA_N, { watchDebounce: null });
    expect(readPluginConfigJson('cg')).toEqual({ indexCommand: 'x' });
  });
});

describe('写入值校验', () => {
  it('类型不符 → throw', async () => {
    await expect(writePluginConfig('cg', SCHEMA_N, { indexCommand: 123 })).rejects.toThrow();
  });

  it('未知键 → throw', async () => {
    await expect(writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', hacker: 'y' })).rejects.toThrow();
  });

  it('enum 外取值 → throw', async () => {
    await expect(writePluginConfig('cg', SCHEMA_N, { engine: 'postgres' })).rejects.toThrow();
  });

  it('required 终态缺失 → throw（已有存量满足则放行）', async () => {
    await expect(writePluginConfig('cg', SCHEMA_N, { watchDebounce: 1 })).rejects.toThrow();
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x' });
    // 存量已在：后续部分写入不再要求重复携带 required 键
    await expect(writePluginConfig('cg', SCHEMA_N, { watchDebounce: 2 })).resolves.toBeUndefined();
    // 显式删除 required 键 → 拒绝
    await expect(writePluginConfig('cg', SCHEMA_N, { indexCommand: null })).rejects.toThrow();
  });
});

describe('读取面', () => {
  it('getPluginConfigView：敏感只出在场布尔，明文永不外泄', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-secret', engine: 'sqlite' });
    const view = getPluginConfigView('cg', SCHEMA_N);
    expect(view.values).toEqual({ indexCommand: 'x', engine: 'sqlite' });
    expect(view.sensitiveConfigured).toEqual({ apiToken: true });
    expect(JSON.stringify(view)).not.toContain('sk-secret');
  });

  it('resolvePluginConfig：全量合并（含敏感，供 ${config.KEY} 注入）', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-secret' });
    expect(await resolvePluginConfig('cg', SCHEMA_N)).toEqual({ indexCommand: 'x', apiToken: 'sk-secret' });
  });

  it('readPluginConfigJson：无文件 / 损坏 JSON / 非对象 → {}（收敛既有三份实现语义）', () => {
    expect(readPluginConfigJson('ghost')).toEqual({});
    fs.mkdirSync(resolvePluginDataDir('bad'), { recursive: true });
    fs.writeFileSync(dataJson('bad'), '{broken');
    expect(readPluginConfigJson('bad')).toEqual({});
    fs.writeFileSync(dataJson('bad'), '[1,2]');
    expect(readPluginConfigJson('bad')).toEqual({});
  });
});

describe('同步缓存 overlay（pluginCtx.getConfig 消费面）', () => {
  it('warm 后写入的敏感值可同步读取；后续 write 更新缓存', async () => {
    await warmPluginConfigCache('cg', SCHEMA_N, { apiToken: 'sk-1' });
    // 经 write 更新缓存
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-2' });
    const cfg = readPluginConfigJson('cg');
    expect(cfg).toEqual({ indexCommand: 'x' });
    // cache overlay 后敏感可见（通过 resolve 校验缓存一致性）
    expect(await resolvePluginConfig('cg', SCHEMA_N)).toEqual({ indexCommand: 'x', apiToken: 'sk-2' });
  });
});


describe('C1 修复锁：冷缓存启动路径（不经 writePluginConfig 预热）', () => {
  it('warmPluginConfigCache 后敏感 overlay 同步可见（boot 链语义）', async () => {
    // 直播盘上 config.json + keytar（模拟「上次会话保存过、本会话刚启动」）
    fs.mkdirSync(resolvePluginDataDir('cg'), { recursive: true });
    fs.writeFileSync(dataJson('cg'), JSON.stringify({ indexCommand: 'x' }));
    vault.set(sensitiveRef('cg', 'apiToken'), 'sk-cold');
    await warmPluginConfigCache('cg', normalizeConfigSchema(SCHEMA));
    const overlay = (await import('../../src/main/plugin/config-store')).sensitiveOverlaySync('cg');
    expect(overlay).toEqual({ apiToken: 'sk-cold' });
  });

  it('evictPluginConfigCache 清除后 overlay 为空（卸载清理语义）', async () => {
    await writePluginConfig('cg', SCHEMA_N, { indexCommand: 'x', apiToken: 'sk-1' });
    const cs = await import('../../src/main/plugin/config-store');
    expect(cs.sensitiveOverlaySync('cg')).toEqual({ apiToken: 'sk-1' });
    cs.evictPluginConfigCache('cg');
    expect(cs.sensitiveOverlaySync('cg')).toEqual({});
  });
});
