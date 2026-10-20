// electron/src/main/plugin/types.ts
//
// 插件域类型（spec 2026-10-15 §2）。跨 IPC 的结构保持纯数据（无方法），
// renderer 端 types.d.ts 有同形独立定义（跨进程仅结构对齐，repo 惯例）。

/** manifest.components——全部可选，声明根路径则扫描其内部，未声明不可见 */
export interface PluginManifestComponents {
  tools?: string;
  service?: string;
  skills?: string;
  agents?: string;
  mcp?: string;
  hooks?: string;
  panel?: string;
}

/** 权限声明（v1 只记录 + 设置页展示，不强制执行，spec §7.3） */
export interface PluginPermissionDecls {
  fs?: string[];
  network?: string[];
  subprocess?: boolean;
}

/** vendor 引擎包声明（引擎整合 T4，spec §4.2）：tarball 随 zip 分发，
 *  安装链校验 sha256 → 条目守卫 → 解压到 engine/ → 平台探针 */
export interface PluginVendorArchiveDecl {
  file: string;
  sha256: string;
  maxEntries?: number;
  maxUnpackedMB?: number;
}

export interface PluginVendorDecl {
  archives: PluginVendorArchiveDecl[];
  /** 解压后必须存在的相对路径（平台装错探测，如 engine/bin/codegraph） */
  probe?: string;
}

/** config 字段：JSON-Schema-lite 透传（type/properties/required），宿主按其渲染设置表单 */
export interface PluginConfigSchema {
  [key: string]: unknown;
}

/** momo-plugin.json 完整形状 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  vendor?: PluginVendorDecl;
  description: string;
  author?: { name: string };
  minAppVersion?: string;
  components: PluginManifestComponents;
  config?: PluginConfigSchema;
  permissions?: PluginPermissionDecls;
}

/** 注册表行（plugins 表行 + 读路径派生态） */
export interface PluginRecord {
  id: string;
  version: string;
  manifestJson: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  sourcePath: string | null;
  installedAt: string;
}
