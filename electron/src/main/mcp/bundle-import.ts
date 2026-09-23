// electron/src/main/mcp/bundle-import.ts
//
// P2.1 Task 5：DXT / MCPB 本地包导入（两阶段：parse 预览 → import 落地）。
//
// manifest 字段树以官方 MCPB MANIFEST.md 核实文档为准
// （.superpowers/sdd/p21-task-0-verify.md §2，覆盖 plan 早期 mcp_servers[] 假设）：
//   - server 是单对象（DXT 与 MCPB 同构，仅判别字段不同），执行配置取 server.mcp_config
//   - manifest_version → MCPB；dxt_version → DXT；两者都无 → 拒绝
//   - server.type 白名单 node / python / binary；uv 拒绝（host 装依赖语义，P3 再议）
//
// 两阶段契约（Task 6 弹窗消费，字段不得改名）：
//   ① parseMcpBundle(data, filename) → BundlePreview——解包校验但不落正式目录；
//   ② importMcpBundle(data, filename, userConfig) → ResourceItem——重解包 + 变量替换
//      + S1 校验 + cwd 注册。tempId 选定「无状态」方案：renderer 持有原文件 buffer
//      二次传参重解包，主进程不维护 tempId→目录映射（parse 后无残留状态）。
//
// S1 注入防线（沿 marketplace / skill zip 既有规则量级）：
//   - zip 条目名绝对路径 / `..` 段拒绝；条目数 > 2000 / 解压总大小 > 200MB 拒绝
//   - command 白名单 /^(npx|node|npm|uvx|uv|python|python3)$/；含路径分隔符视为包内
//     相对路径（win32 补 .exe，拒 `..` 逃逸）；args 滤含 `"` 项
//   - slug 过 isValidSlug（失败回退文件基名），冲突后缀 -2 … -20

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { resolveUserDataDir } from '../paths';
import { deleteRegistered, getMcpConfig, registerMcpDefinition } from './host-manager';
import { isValidSlug } from '../marketplace/types';
import { buildResourceId, type ResourceItem } from '../resource/types';

/** user_config 单字段描述（两阶段表单契约；v1 只支持 type='string' 渲染） */
export interface BundleConfigField {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title?: string;
  description?: string;
  required?: boolean;
  sensitive?: boolean;
}

/** parse 阶段返回的解包预览（Task 6 ImportBundleDialog 第一阶段消费） */
export interface BundlePreview {
  name: string;
  displayName: string;
  version: string;
  description: string;
  serverType: 'node' | 'python' | 'binary';
  /** 启动结构预览（command + args 原始拼接，变量占位保留——替换发生在 import） */
  commandPreview: string;
  /** 只含必填文本字段（v1 表单只收 required string；全非必填 / 无 user_config → 空对象，跳表单直导） */
  userConfigSchema: Record<string, BundleConfigField>;
  /** 无状态占位（import 阶段重解包方案下仅作标识，无服务端映射） */
  tempId: string;
}

/** 解析完成后的 bundle 内部模型（loadBundle 产出，parse / import 共用） */
interface ParsedBundle {
  name: string;
  displayName: string;
  version: string;
  description: string;
  serverType: 'node' | 'python' | 'binary';
  command: string;
  args: string[];
  env: Record<string, string>;
  userConfigSchema: Record<string, BundleConfigField>;
  zip: AdmZip;
}

// ────────────────────────────────────────────────────────────────────────────
// 常量与安全阈值（照抄 skill zip-uploader 规则量级）
// ────────────────────────────────────────────────────────────────────────────

/** 启动命令白名单（mcp_config.command 是 runtime 启动器，非任意可执行文件） */
const COMMAND_WHITELIST = /^(npx|node|npm|uvx|uv|python|python3)$/;

/** 单包解压条目数上限 */
const MAX_ENTRIES = 2000;

/** 单包解压总大小上限（200MB） */
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;

/** slug 冲突后缀上限（-2 … -20，超限抛错） */
const MAX_SLUG_SUFFIX = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 判断某 entry 是否为 OS 元数据（解压时跳过）。照抄 skill/zip-uploader 同名规则：
 * macOS Finder 压缩注入 __MACOSX/ + ._* AppleDouble；Windows 资源管理器注入 Thumbs.db。
 */
function isIgnoredEntry(entryName: string): boolean {
  const norm = entryName.replace(/\\/g, '/');
  if (norm.startsWith('__MACOSX/')) return true;
  for (const seg of norm.split('/')) {
    if (seg === '.DS_Store' || seg === 'Thumbs.db') return true;
    if (seg.startsWith('._')) return true;
    if (seg.endsWith('.bak')) return true;
  }
  return false;
}

/**
 * user_config 校验与表单 schema 收敛：
 *   - 非 string 且 required → 抛错（v1 表单只支持文本型，可操作文案直接给用户）
 *   - 非 string 非必填 → 丢弃（v1 不采集，导入时替换为空串）
 *   - 非必填 string → 丢弃（v1 表单只收必填项；「全非必填 → 空对象」由此成立）
 *   - 必填 string → 进 schema（Task 6 渲染表单）
 */
function buildUserConfigSchema(userConfig: unknown): Record<string, BundleConfigField> {
  const schema: Record<string, BundleConfigField> = {};
  if (!isRecord(userConfig)) return {};
  for (const [key, raw] of Object.entries(userConfig)) {
    if (!isRecord(raw)) continue;
    const type = typeof raw.type === 'string' ? raw.type : 'string';
    if (type !== 'string') {
      if (raw.required === true) {
        throw new Error(`该包需要 ${type} 型配置，暂只支持文本型（字段：${key}）`);
      }
      continue;
    }
    if (raw.required !== true) continue;
    schema[key] = {
      type: 'string',
      title: typeof raw.title === 'string' ? raw.title : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      required: true,
      sensitive: raw.sensitive === true,
    };
  }
  return schema;
}

/**
 * 共享加载与校验（parse / import 两阶段同源，防两阶段判别漂移）：
 * zip 打开 → 安全扫描（条目数 / 总大小 / 条目名路径防御）→ manifest 解析 →
 * 判别字段 → server.mcp_config 结构校验 → user_config 校验。
 * 纯内存操作，不写任何目录（parse「不落正式目录」由此保证）。
 */
function loadBundle(data: Buffer, filename: string): ParsedBundle {
  let zip: AdmZip;
  try {
    zip = new AdmZip(data);
  } catch {
    throw new Error(`文件 ${filename} 不是有效的 zip / mcpb / dxt 包`);
  }

  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`解压条目数超限（${entries.length} > ${MAX_ENTRIES}），已拒绝`);
  }

  let totalSize = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    totalSize += entry.header.size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error(`解压总大小超限（> ${MAX_TOTAL_SIZE} 字节），已拒绝`);
    }
    if (isIgnoredEntry(entry.entryName)) continue;
    // 条目名路径防御（skill zip 规则在 bundle 侧从「跳过」升级为「拒绝」）
    const norm = entry.entryName.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(norm)) {
      throw new Error(`zip 条目名是绝对路径，已拒绝：${entry.entryName}`);
    }
    if (norm.split('/').includes('..')) {
      throw new Error(`zip 条目名含 .. 路径段，已拒绝：${entry.entryName}`);
    }
  }

  const manifestEntry = entries.find(
    (e) =>
      !e.isDirectory &&
      !isIgnoredEntry(e.entryName) &&
      e.entryName.replace(/\\/g, '/') === 'manifest.json',
  );
  if (!manifestEntry) {
    throw new Error('包内未找到根目录 manifest.json（DXT / MCPB 包要求 manifest.json 在 zip 根目录）');
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  } catch {
    throw new Error('manifest.json 不是有效 JSON');
  }
  if (!isRecord(rawManifest)) {
    throw new Error('manifest.json 顶层必须是 JSON 对象');
  }

  // 判别：manifest_version → MCPB；dxt_version → DXT；都无 → 拒绝
  if (!('manifest_version' in rawManifest) && !('dxt_version' in rawManifest)) {
    throw new Error('无法识别的包：manifest.json 缺少 manifest_version（MCPB）或 dxt_version（DXT）判别字段');
  }

  // server 结构（以 Task 0 核实字段树为准：单对象 + mcp_config，无 mcp_servers[]）
  const server = rawManifest.server;
  if (!isRecord(server)) {
    throw new Error('manifest.json 缺少 server 对象');
  }
  const serverType = server.type;
  if (typeof serverType !== 'string' || serverType === '') {
    throw new Error('manifest.json 缺少 server.type');
  }
  if (serverType === 'uv') {
    throw new Error('uv 型扩展暂不支持（需要宿主安装依赖，P3 再评估）');
  }
  if (serverType !== 'node' && serverType !== 'python' && serverType !== 'binary') {
    throw new Error(`不支持的 server.type：${serverType}（支持 node / python / binary）`);
  }
  const mcpConfig = server.mcp_config;
  if (!isRecord(mcpConfig)) {
    throw new Error('manifest.json 缺少 server.mcp_config 执行配置');
  }
  const command = mcpConfig.command;
  if (typeof command !== 'string' || command === '') {
    throw new Error('server.mcp_config.command 缺失或为空');
  }
  let args: string[] = [];
  if (mcpConfig.args !== undefined) {
    if (!Array.isArray(mcpConfig.args) || mcpConfig.args.some((a) => typeof a !== 'string')) {
      throw new Error('server.mcp_config.args 必须是字符串数组');
    }
    args = mcpConfig.args;
  }
  const env: Record<string, string> = {};
  if (mcpConfig.env !== undefined) {
    if (!isRecord(mcpConfig.env)) {
      throw new Error('server.mcp_config.env 必须是对象');
    }
    for (const [k, v] of Object.entries(mcpConfig.env)) {
      if (typeof v !== 'string') {
        throw new Error(`server.mcp_config.env.${k} 的值必须是字符串`);
      }
      env[k] = v;
    }
  }

  const name = typeof rawManifest.name === 'string' ? rawManifest.name : '';
  const displayName =
    typeof rawManifest.display_name === 'string' && rawManifest.display_name !== ''
      ? rawManifest.display_name
      : name;
  const version = typeof rawManifest.version === 'string' ? rawManifest.version : '1.0.0';
  const description = typeof rawManifest.description === 'string' ? rawManifest.description : '';

  return {
    name,
    displayName,
    version,
    description,
    serverType,
    command,
    args,
    env,
    userConfigSchema: buildUserConfigSchema(rawManifest.user_config),
    zip,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 变量替换（Task 0 核实文档 §2.3 substitution 表）
// ────────────────────────────────────────────────────────────────────────────

/** 占位符统一匹配：${KEY} 形态（KEY 不含 `}`，覆盖 `${/}` 特例） */
const VAR_RE = /\$\{([^}]+)\}/g;

/**
 * 替换单个字符串值里的全部占位符。未识别占位符原样保留并 warn（不阻断导入）。
 * bundleDir 用最终安装目录（import 在 rename 前替换，${__dirname} 语义与最终一致）。
 */
function substituteVars(
  value: string,
  bundleDir: string,
  userConfig: Record<string, string>,
): string {
  return value.replace(VAR_RE, (whole, key: string) => {
    switch (key) {
      case '__dirname':
        return bundleDir;
      case 'HOME':
        return os.homedir();
      case 'DESKTOP':
        return path.join(os.homedir(), 'Desktop');
      case 'DOCUMENTS':
        return path.join(os.homedir(), 'Documents');
      case 'DOWNLOADS':
        return path.join(os.homedir(), 'Downloads');
      case 'pathSeparator':
      case '/':
        return path.sep;
      default:
        if (key.startsWith('user_config.')) {
          // 可选字段未提交 → 空串（v1 表单不采集可选项）
          return userConfig[key.slice('user_config.'.length)] ?? '';
        }
        logger.warn('MCP bundle 变量未识别，原样保留', { variable: whole, bundleDir });
        return whole;
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// S1：启动命令校验与规范化
// ────────────────────────────────────────────────────────────────────────────

/**
 * 校验并规范化启动命令。两分支：
 *   - 裸命令（不含路径分隔符）→ 必须命中白名单，原样返回；
 *   - 含 `/` 或 `\` → 视为包内路径（binary 型常见）：相对路径 join 到 bundleDir、
 *     绝对路径（${__dirname} 替换产物）原样走包含校验；解析后必须落在 bundleDir
 *     内（拒 `..` 逃逸）；win32 补 .exe（已有 .exe/.EXE 等后缀不重复补）。
 * platform 参数仅供测试注入（缺省当前平台）。
 */
export function resolveBundleCommand(
  command: string,
  bundleDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!command.includes('/') && !command.includes('\\')) {
    if (!COMMAND_WHITELIST.test(command)) {
      throw new Error(
        `不支持的启动命令：${command}（仅支持 npx / node / npm / uvx / uv / python / python3，或包内相对路径）`,
      );
    }
    return command;
  }
  const isAbsolute = path.isAbsolute(command) || /^[a-zA-Z]:[\\/]/.test(command);
  const target = isAbsolute ? command : path.join(bundleDir, command);
  const resolved = path.resolve(target);
  const bundleRoot = path.resolve(bundleDir);
  if (!resolved.startsWith(bundleRoot + path.sep)) {
    throw new Error(`启动命令越出包目录（疑似 .. 逃逸），已拒绝：${command}`);
  }
  if (platform === 'win32' && !resolved.toLowerCase().endsWith('.exe')) {
    return `${resolved}.exe`;
  }
  return resolved;
}

// ────────────────────────────────────────────────────────────────────────────
// 解包落地
// ────────────────────────────────────────────────────────────────────────────

/** 自定义 bundle 安装根目录（<userData>/mcp-bundles/）。纯路径推导，不建目录——
 *  目录树由 import 的解包步骤按需创建，失败路径零足迹。 */
function getBundlesRoot(): string {
  return path.join(resolveUserDataDir(), 'mcp-bundles');
}

/** 解压 zip 到 destDir（loadBundle 已做过条目名安全扫描，此处保留包含校验双保险） */
function extractBundle(zip: AdmZip, destDir: string): void {
  const resolvedDest = path.resolve(destDir);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (isIgnoredEntry(entry.entryName)) continue;
    const norm = entry.entryName.replace(/\\/g, '/');
    const dest = path.join(destDir, norm);
    const resolvedFile = path.resolve(dest);
    if (!resolvedFile.startsWith(resolvedDest + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
}

/**
 * slug 推导与冲突消解：
 *   - manifest.name 过 isValidSlug → 通过即用；
 *   - 失败 / 缺省 → 文件基名（去扩展名、小写化、非法字符转 `-`、去头部非字母数字段）再校验；
 *   - 仍失败 → 抛错；
 *   - 冲突：先查 bundle:{slug} 记账行（本包重导 → 复用 slug 幂等覆盖），
 *     再查 mcp_definitions 同名（他人占用 → 依次尝试 -2 … -20，超限抛错）。
 */
function resolveSlug(parsed: ParsedBundle, filename: string): string {
  let base: string | null = null;
  if (isValidSlug(parsed.name)) {
    base = parsed.name;
  }
  if (base === null) {
    const fileBase = filename
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9-._]/g, '-')
      .replace(/^[^a-z0-9]+/, '');
    if (isValidSlug(fileBase)) {
      base = fileBase;
    }
  }
  if (base === null) {
    throw new Error(
      `无法从包名「${parsed.name || '(空)'}」或文件名「${filename}」生成合法 slug，请修改 manifest.name`,
    );
  }

  const db = getDb();
  for (let i = 1; i <= MAX_SLUG_SUFFIX; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    // 本包重导：记账行存在 → 复用 slug（目录覆盖 + 双表单行，幂等语义）
    const ownRow = db
      .prepare('SELECT 1 AS one FROM installed_packages WHERE item_id = ?')
      .get(`bundle:${candidate}`);
    if (ownRow) return candidate;
    const taken = db
      .prepare('SELECT 1 AS one FROM mcp_definitions WHERE name = ?')
      .get(candidate);
    if (!taken) return candidate;
  }
  throw new Error(`包名冲突超限：${base} 及其后缀 -2 … -${MAX_SLUG_SUFFIX} 均被占用`);
}

/** installed_packages 记账（item_id = `bundle:{slug}`；先清旧账再插，重复导入只留一行） */
function recordBundleInstall(slug: string, bundleDir: string, version: string): void {
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`bundle:${slug}`);
  db.prepare(
    `INSERT INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, 'mcp', ?, ?, ?, '')`,
  ).run(randomUUID(), `bundle:${slug}`, slug, version, bundleDir);
}

// ────────────────────────────────────────────────────────────────────────────
// 对外 API（IPC handler 接线见 resource/ipc.handlers.ts）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 两阶段第一阶段：解包预览。只做解析与安全校验，不写任何目录（正式目录
 * 由 import 阶段创建）。tempId 为无状态占位（import 重解包方案，无服务端映射）。
 */
export function parseMcpBundle(data: Buffer, filename: string): BundlePreview {
  const parsed = loadBundle(data, filename);
  return {
    name: parsed.name,
    displayName: parsed.displayName,
    version: parsed.version,
    description: parsed.description,
    serverType: parsed.serverType,
    commandPreview: [parsed.command, ...parsed.args].join(' '),
    userConfigSchema: parsed.userConfigSchema,
    tempId: randomUUID(),
  };
}

/**
 * 两阶段第二阶段：导入落地。重解包（renderer 二次传原文件 buffer，主进程零状态）
 * → temp 解包 → slug 消解 → 变量替换 + S1 校验（rename 前完成，失败不留孤儿目录）
 * → 原子落位（先 rm 后 rename）→ cwd 注册 + 记账 → 返回 custom ResourceItem。
 */
export function importMcpBundle(
  data: Buffer,
  filename: string,
  userConfig: Record<string, string>,
): ResourceItem {
  const parsed = loadBundle(data, filename);

  // import 防线：parse 阶段已判定的必填文本字段必须随表单提交
  for (const key of Object.keys(parsed.userConfigSchema)) {
    if (!(key in userConfig)) {
      throw new Error(`缺少必填配置：${parsed.userConfigSchema[key]?.title ?? key}`);
    }
  }

  const bundlesRoot = getBundlesRoot();
  const tempDir = path.join(bundlesRoot, `.tmp-${randomUUID()}`);
  let landed = false;
  try {
    extractBundle(parsed.zip, tempDir);
    const slug = resolveSlug(parsed, filename);
    const destDir = path.join(bundlesRoot, slug);

    // 变量替换与 S1 校验先于 rename（校验失败时正式目录零污染）
    const substitute = (value: string) => substituteVars(value, destDir, userConfig);
    const command = resolveBundleCommand(substitute(parsed.command), destDir);
    const args = parsed.args.map(substitute).filter((a) => !a.includes('"'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.env)) {
      env[k] = substitute(v);
    }

    // 原子化落位：先清旧目录（幂等重导覆盖）再 rename
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.renameSync(tempDir, destDir);
    landed = true;

    // zip 不保留 POSIX 执行位，binary 型 command 落盘后恢复 0o755
    // 仅 chmod 包内文件——serverType 非 binary、command 是白名单裸命令
    // （指向系统二进制）则跳过，避免误改系统二进制位（Windows chmod 近似 no-op 无害）
    if (
      parsed.serverType === 'binary' &&
      (command.includes('/') || command.includes('\\')) &&
      fs.existsSync(command)
    ) {
      fs.chmodSync(command, 0o755);
    }

    registerMcpDefinition({
      id: randomUUID(),
      name: slug,
      version: parsed.version,
      command,
      args,
      env,
      cwd: destDir,
      source: 'custom',
    });
    recordBundleInstall(slug, destDir, parsed.version);
    logger.info('MCP bundle 已导入', { slug, bundleDir: destDir, serverType: parsed.serverType });

    // 读回真实注册行（installedAt 为 DB 默认值——不手工伪造时间戳）
    const registered = getMcpConfig(slug);
    return {
      id: buildResourceId('custom', 'mcp', slug),
      type: 'mcp',
      source: 'custom',
      slug,
      name: parsed.displayName || slug,
      description: parsed.description,
      version: parsed.version,
      installed: true,
      installable: false,
      removable: true,
      custom: {
        installedAt: registered?.installedAt ?? new Date().toISOString(),
        mcpConfig: { command, args, env },
      },
    };
  } finally {
    // rename 成功后 tempDir 已不存在；失败路径在此兜底清理
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    // 失败时回收可能新建的空 bundlesRoot（非空 = 存在历史包，保留）
    if (!landed) {
      try {
        fs.rmdirSync(bundlesRoot);
      } catch {
        // 目录非空或已不存在——无需处理
      }
    }
  }
}

/** 是否为 DXT/MCPB 导入条目（resource:delete custom+mcp 分支的路由判据） */
export function isBundleInstalled(slug: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS one FROM installed_packages WHERE item_id = ?')
    .get(`bundle:${slug}`);
  return row !== undefined;
}

/**
 * bundle 卸载：删 mcp_definitions 行 → 按 `bundle:{slug}` 记账行 rm cache_path
 * 目录 → 删记账行。非 bundle 条目 / 已卸载 → 幂等静默（路由判据用 isBundleInstalled）。
 */
export function uninstallMcpBundle(slug: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT cache_path FROM installed_packages WHERE item_id = ?')
    .get(`bundle:${slug}`) as { cache_path: string } | undefined;
  if (!row) return;

  // bundle 行 source='custom'，无 marketplace 保护拦截；不存在时静默（幂等）
  deleteRegistered(slug);
  if (row.cache_path !== '') {
    try {
      fs.rmSync(row.cache_path, { recursive: true, force: true });
    } catch (err) {
      // 目录清理失败不阻断记账删除（下次重导会先 rm 覆盖）
      logger.warn('MCP bundle 目录清理失败', {
        slug,
        cachePath: row.cache_path,
        error: (err as Error).message,
      });
    }
  }
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`bundle:${slug}`);
  logger.info('MCP bundle 已卸载', { slug, cachePath: row.cache_path });
}
