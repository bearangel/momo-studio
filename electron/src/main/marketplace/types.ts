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
