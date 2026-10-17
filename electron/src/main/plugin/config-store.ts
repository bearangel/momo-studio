// electron/src/main/plugin/config-store.ts
//
// 插件 config 双轨存储（P4，spec §2.2 config / §7.1 / 决策记录 111 行）。
//
// 分轨：
//   非敏感 → <dataDir>/config.json（原子写：tmp + rename）
//   敏感（schema 属性 sensitive:true）→ keytar `plugin.<id>.config.<KEY>`
//     （照 provider.<id>.api_key 命名惯例）；renderer 永不明文可见
//
// keytar 异步性吸收（D5 裁定）：敏感值在激活边界（安装/重载/启停/boot/写入时）
// 预热进主进程内存缓存——同步消费者（pluginCtx.getConfig / service ctx）读
// config.json + 缓存 overlay；`${config.KEY}` 注入等异步面走 resolvePluginConfig。
// 装了即信信任模型（spec §7.3）下主进程持密可接受。
//
// 写入语义（overlay，对应表单「空输入=不变」）：
//   值缺省 = 保持现值；null = 删除；实际值 = 写入。required 校验针对合并终态。
import fs from 'node:fs';
import path from 'node:path';
import { resolvePluginDataDir, resolvePluginsDir } from '../paths';
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';

/** 属性级 Schema（v1 子集，多收拒绝） */
export interface ConfigPropertyDecl {
  type: 'string' | 'number' | 'boolean';
  title?: string;
  sensitive?: boolean;
  /** 工作空间维度 v1.1（spec 2026-10-17 §4.1）：声明式作用域，缺省 global；
   *  sensitive 组合拒绝（敏感值跨工作区共享，v1 非目标） */
  scope?: 'workspace' | 'global';
  enum?: (string | number)[];
}

export interface NormalizedConfigSchema {
  properties: Record<string, ConfigPropertyDecl>;
  required: string[];
}

type ConfigValue = string | number | boolean | null;
type WriteValues = Record<string, ConfigValue>;

/** keytar 键名（provider.<id>.api_key 同款点分惯例） */
export function sensitiveRef(pluginId: string, key: string): string {
  return `plugin.${pluginId}.config.${key}`;
}

/** config 属性键：字母数字开头（spec 自家用例为 camelCase，如 indexCommand），
 *  拒空格/点/斜杠等路径与注入面字符 */
function isConfigKey(s: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s);
}

/**
 * Schema v1 子集校验（拒绝式）：type=object、properties 键 slug、每属性
 * type ∈ {string,number,boolean}、可选 title/sensitive/enum、required 键须存在。
 */
export function normalizeConfigSchema(raw: unknown): NormalizedConfigSchema {
  const schema = raw as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
  };
  if (typeof raw !== 'object' || raw === null || schema.type !== 'object') {
    throw new Error('config schema 须为 type: object');
  }
  if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) {
    throw new Error('config schema.properties 须为对象');
  }
  const properties: Record<string, ConfigPropertyDecl> = {};
  for (const [key, decl] of Object.entries(schema.properties as Record<string, unknown>)) {
    if (!isConfigKey(key)) throw new Error(`config 属性键非法（字母数字白名单外）: ${key}`);
    const d = decl as Record<string, unknown>;
    if (typeof d !== 'object' || d === null) throw new Error(`config 属性声明须为对象: ${key}`);
    const allowed = new Set(['type', 'title', 'sensitive', 'scope', 'enum']);
    for (const field of Object.keys(d)) {
      if (!allowed.has(field)) throw new Error(`config 属性含 v1 不支持字段: ${key}.${field}`);
    }
    if (d.type !== 'string' && d.type !== 'number' && d.type !== 'boolean') {
      throw new Error(`config 属性 type 须为 string/number/boolean: ${key}`);
    }
    if (d.scope !== undefined && d.scope !== 'workspace' && d.scope !== 'global') {
      throw new Error(`config.scope 须为 workspace/global: ${key}`);
    }
    if (d.scope === 'workspace' && d.sensitive === true) {
      throw new Error(`config 组合不支持：sensitive 属性 ${key} 不能声明 scope: workspace`);
    }
    const out: ConfigPropertyDecl = { type: d.type };
    if (d.title !== undefined && typeof d.title !== 'string') throw new Error(`config.title 须为字符串: ${key}`);
    if (d.title !== undefined) out.title = d.title;
    if (d.sensitive !== undefined && typeof d.sensitive !== 'boolean') throw new Error(`config.sensitive 须为布尔: ${key}`);
    if (d.sensitive !== undefined) out.sensitive = d.sensitive;
    if (d.scope !== undefined) out.scope = d.scope;
    if (d.enum !== undefined) {
      if (!Array.isArray(d.enum) || d.enum.length === 0 || !d.enum.every((v) => typeof v === 'string' || typeof v === 'number')) {
        throw new Error(`config.enum 须为非空 string/number 数组: ${key}`);
      }
      out.enum = d.enum as (string | number)[];
    }
    properties[key] = out;
  }
  let required: string[] = [];
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === 'string')) {
      throw new Error('config.required 须为字符串数组');
    }
    required = schema.required as string[];
    for (const k of required) {
      if (!(k in properties)) throw new Error(`config.required 键未在 properties 声明: ${k}`);
    }
  }
  return { properties, required };
}

/** workspace 层文件名段：workspaceId 白名单校验（UUID/字母数字连字符——防路径穿越） */
function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(workspaceId)) throw new Error(`workspaceId 非法: ${workspaceId}`);
}

function workspaceConfigPath(dataDir: string, workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(dataDir, `config.${workspaceId}.json`);
}

/**
 * 非敏感层同步读（收敛 P3 三份 readConfig 实现的唯一语义：坏文件/缺文件/非对象 → {}）。
 * 工作空间维度 v1.1：workspaceId 给定时读 workspace 层文件（config.<wsId>.json），
 * 缺省读 global 层（config.json）——旧调用点零改动。
 */
export function readPluginConfigJson(pluginId: string, workspaceId?: string): Record<string, unknown> {
  const base = resolvePluginDataDir(pluginId);
  const file = workspaceId ? workspaceConfigPath(base, workspaceId) : path.join(base, 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 敏感值主进程内存缓存（激活边界预热 / 写入时更新） */
const sensitiveCache = new Map<string, Record<string, string>>();

/** 预热敏感缓存（boot/安装/重载/启停时调用；已带值直接注入——测试/迁移用） */
export async function warmPluginConfigCache(
  pluginId: string,
  schema: NormalizedConfigSchema,
  preloaded?: Record<string, string>,
): Promise<void> {
  const sensitiveKeys = Object.entries(schema.properties)
    .filter(([, d]) => d.sensitive)
    .map(([k]) => k);
  if (sensitiveKeys.length === 0) return;
  const layer: Record<string, string> = {};
  for (const key of sensitiveKeys) {
    const v = preloaded ? preloaded[key] : await getSecret(sensitiveRef(pluginId, key));
    if (v !== null && v !== undefined) layer[key] = v;
  }
  sensitiveCache.set(pluginId, layer);
}

/** 值类型校验（写入面） */
function checkValue(key: string, decl: ConfigPropertyDecl, v: unknown): void {
  if (decl.type === 'string' && typeof v !== 'string') throw new Error(`config 值类型不符（须 string）: ${key}`);
  if (decl.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`config 值类型不符（须 number）: ${key}`);
  }
  if (decl.type === 'boolean' && typeof v !== 'boolean') throw new Error(`config 值类型不符（须 boolean）: ${key}`);
  if (decl.enum && !decl.enum.includes(v as string | number)) {
    throw new Error(`config 值不在 enum 白名单内: ${key}`);
  }
}

/**
 * 写入（overlay 语义 + 终态 required 校验，按作用域分层）：
 *   workspace-scope 键 → config.<wsId>.json（workspaceId 给定时）；global/敏感 → 原轨道；
 *   required 校验针对本次涉及作用域的合并终态（无 wsId 写入不触碰/不校验 workspace 层）；
 *   两层各自 tmp + rename 原子写。
 */
export async function writePluginConfig(
  pluginId: string,
  schema: NormalizedConfigSchema,
  values: WriteValues,
  workspaceId?: string,
): Promise<void> {
  for (const [key, v] of Object.entries(values)) {
    const decl = schema.properties[key];
    if (!decl) throw new Error(`config 未知键: ${key}`);
    if (v !== null) checkValue(key, decl, v);
  }

  const currentPlain = readPluginConfigJson(pluginId);
  const currentWs = workspaceId ? readPluginConfigJson(pluginId, workspaceId) : {};
  const finalPlain = { ...currentPlain };
  const finalWs = { ...currentWs };
  const finalSensitiveKeys = new Set(Object.keys(sensitiveCache.get(pluginId) ?? {}));
  for (const [key, v] of Object.entries(values)) {
    const decl = schema.properties[key];
    if (decl === undefined) throw new Error(`config 未知键: ${key}`);
    if (decl.scope === 'workspace' && workspaceId) {
      if (v === null) delete finalWs[key];
      else finalWs[key] = v;
      continue;
    }
    if (decl.sensitive) {
      if (v === null) finalSensitiveKeys.delete(key);
      else finalSensitiveKeys.add(key);
    } else if (v === null) {
      delete finalPlain[key];
    } else {
      finalPlain[key] = v;
    }
  }
  const missing = schema.required.filter((k) => {
    const decl = schema.properties[k];
    if (decl === undefined) return false;
    if (decl.scope === 'workspace') {
      if (!workspaceId) return false; // 本次不触碰 workspace 层——不纳入校验
      return !(k in finalWs);
    }
    return !(k in finalPlain) && !finalSensitiveKeys.has(k);
  });
  if (missing.length > 0) {
    throw new Error(`config 必填项未配置: ${missing.join(', ')}`);
  }

  const dataDir = resolvePluginDataDir(pluginId);
  fs.mkdirSync(dataDir, { recursive: true });
  writeAtomicJson(path.join(dataDir, 'config.json'), finalPlain);
  if (workspaceId) {
    writeAtomicJson(workspaceConfigPath(dataDir, workspaceId), finalWs);
  }

  for (const [key, v] of Object.entries(values)) {
    const decl = schema.properties[key];
    if (decl === undefined || !decl.sensitive) continue;
    const ref = sensitiveRef(pluginId, key);
    if (v === null) {
      await deleteSecret(ref).catch(() => undefined);
    } else {
      await setSecret(ref, String(v));
    }
  }
  await warmPluginConfigCache(pluginId, schema);
}

/** tmp + rename 原子写（分轨存储抽公共） */
function writeAtomicJson(target: string, data: Record<string, unknown>): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/** 表单渲染视图：global+workspace 层合并明文 + 敏感在场布尔 + 逐键作用域（renderer 徽标用） */
export function getPluginConfigView(
  pluginId: string,
  schema: NormalizedConfigSchema,
  workspaceId?: string,
): {
  values: Record<string, unknown>;
  sensitiveConfigured: Record<string, boolean>;
  scopes: Record<string, 'workspace' | 'global'>;
} {
  const values = {
    ...readPluginConfigJson(pluginId),
    ...(workspaceId ? readPluginConfigJson(pluginId, workspaceId) : {}),
  };
  const sensitiveConfigured: Record<string, boolean> = {};
  const scopes: Record<string, 'workspace' | 'global'> = {};
  for (const [key, decl] of Object.entries(schema.properties)) {
    if (decl.sensitive) sensitiveConfigured[key] = key in (sensitiveCache.get(pluginId) ?? {});
    scopes[key] = decl.scope ?? 'global';
  }
  return { values, sensitiveConfigured, scopes };
}

/** 全量合并（global 层 + workspace 层 + 敏感缓存）——异步面专用（${config.KEY} 注入 / service 启动快照） */
export async function resolvePluginConfig(
  pluginId: string,
  schema: NormalizedConfigSchema,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  await warmPluginConfigCache(pluginId, schema);
  return {
    ...readPluginConfigJson(pluginId),
    ...(workspaceId ? readPluginConfigJson(pluginId, workspaceId) : {}),
    ...(sensitiveCache.get(pluginId) ?? {}),
  };
}

/** 同步敏感 overlay（pluginCtx.getConfig / service ctx 组装用） */
export function sensitiveOverlaySync(pluginId: string): Record<string, unknown> {
  return { ...(sensitiveCache.get(pluginId) ?? {}) };
}

/** 卸载清理：清除该插件敏感缓存（keepData=false 时随 keytar 一起删） */
export function evictPluginConfigCache(pluginId: string): void {
  sensitiveCache.delete(pluginId);
}

/** 工作区删除清理：扫数据根删各插件的 config.<wsId>.json（孤儿不参与读取，此处物理清理；
 *  数据目录扫描而非注册表遍历——避免 config-store 引入 DB 依赖） */
export function deleteWorkspacePluginConfig(workspaceId: string): void {
  const dataRoot = path.join(resolvePluginsDir(), 'data');
  assertWorkspaceId(workspaceId);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return; // 数据根不存在 = 无可清理
  }
  for (const pluginId of entries) {
    try {
      fs.rmSync(workspaceConfigPath(path.join(dataRoot, pluginId), workspaceId), { force: true });
    } catch {
      // 单插件清理失败不阻塞其余
    }
  }
}

/** 测试隔离：清空敏感缓存 */
export function resetPluginConfigCacheForTest(): void {
  sensitiveCache.clear();
}
