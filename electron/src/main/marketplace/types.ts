// electron/src/main/marketplace/types.ts
//
// Marketplace 域类型定义。Catalog 是远程/本地 catalog.json 的结构契约，
// MarketplaceItem 是单条可安装项（agent / mcp / skill）。字段与 renderer 端
// 通过 IPC 传输，因此保持纯数据（无方法）。

/** 可安装项类型：agent（子 agent 定义）/ mcp（MCP server 包）/ skill（技能包） */
export type ItemType = 'agent' | 'mcp' | 'skill';

/** 校验状态：unverified < community < verified < official，UI 据此显示徽标 */
export type VerificationStatus = 'unverified' | 'community' | 'verified' | 'official';

/** 单条 marketplace 项（catalog.json 内一条） */
export interface MarketplaceItem {
  id: string;
  type: ItemType;
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  readme: string;
  tags: string[];
  category: string;
  iconEmoji: string;
  verificationStatus: VerificationStatus;
  /** 下载地址（空串表示 builtin 内联项，安装时从 readme 字段就地生成文件） */
  downloadUrl: string;
  /** sha256 hex 校验和（空串表示不校验，仅 builtin 项允许） */
  checksum: string;
  sizeBytes: number;
  installCount: number;
}

/** catalog.json 顶层结构 */
export interface Catalog {
  version: string;
  updatedAt: string;
  items: MarketplaceItem[];
}

// ────────────────────────────────────────────────────────────────────────────
// 安全校验（S1）：以下白名单字符集是安装链的注入防线——slug/version 会被拼进
// 文件系统路径与子进程参数，任何 shell 元字符都必须在这里被拒绝。
// ────────────────────────────────────────────────────────────────────────────

/** slug 白名单：小写字母/数字开头，后续允许小写字母/数字/连字符/点/下划线 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-._]*$/;

/** version 白名单：数字/字母/点/加号/减号（semver 宽松超集） */
export const VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/;

/** sha256 hex 校验和（64 位十六进制） */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

/** npm 包名：@scope/name 或裸名两种形态（用于 MCP npx 注册防注入） */
export const NPM_PACKAGE_NAME_PATTERN =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-._~]+|[a-z0-9-._~]+)$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

export function isValidSha256Hex(checksum: string): boolean {
  return SHA256_HEX_PATTERN.test(checksum);
}

export function isValidNpmPackageName(name: string): boolean {
  return NPM_PACKAGE_NAME_PATTERN.test(name);
}
