// renderer/src/components/files/file-icon.tsx
//
// 文件树类型图标映射（2026-10-11 P1 预览方案 B，用户批准稿）：
// 扩展名 → lucide 形状 + 语义色类。着色大部分复用既有 token
// （status-success/violet/warning/error、tertiary），新增 icon-code/js/md/folder
// 四个缺口 token（globals.css + tailwind.config + design-system.md 三层落地）。
// 约束：className 一律字面量——Tailwind JIT 只对静态书写生成 CSS，动态拼接不生成。
import {
  File,
  FileCode,
  FileImage,
  FileArchive,
  Braces,
  FileText,
  type LucideIcon,
} from 'lucide-react';

export interface FileIconSpec {
  icon: LucideIcon;
  /** 静态语义色类（text-*），调用方经 cn() 与尺寸类组合 */
  className: string;
}

/** 目录图标着色（Folder / FolderOpen 共用，琥珀） */
export const FOLDER_ICON_CLASS = 'text-icon-folder';

const SPEC_CODE: FileIconSpec = { icon: FileCode, className: 'text-icon-code' };
const SPEC_JS: FileIconSpec = { icon: FileCode, className: 'text-icon-js' };
const SPEC_JSON: FileIconSpec = { icon: Braces, className: 'text-icon-js' };
const SPEC_PY: FileIconSpec = { icon: FileCode, className: 'text-status-success' };
const SPEC_IMAGE: FileIconSpec = { icon: FileImage, className: 'text-status-violet' };
const SPEC_MD: FileIconSpec = { icon: FileText, className: 'text-icon-md' };
const SPEC_ARCHIVE: FileIconSpec = { icon: FileArchive, className: 'text-status-warning' };
const SPEC_HTML: FileIconSpec = { icon: File, className: 'text-status-warning' };
const SPEC_PDF: FileIconSpec = { icon: FileText, className: 'text-status-error' };
const SPEC_DEFAULT: FileIconSpec = { icon: File, className: 'text-tertiary' };

const BY_EXT: Record<string, FileIconSpec> = {
  ts: SPEC_CODE,
  tsx: SPEC_CODE,
  css: SPEC_CODE,
  js: SPEC_JS,
  jsx: SPEC_JS,
  mjs: SPEC_JS,
  cjs: SPEC_JS,
  json: SPEC_JSON,
  py: SPEC_PY,
  png: SPEC_IMAGE,
  jpg: SPEC_IMAGE,
  jpeg: SPEC_IMAGE,
  svg: SPEC_IMAGE,
  webp: SPEC_IMAGE,
  gif: SPEC_IMAGE,
  md: SPEC_MD,
  txt: SPEC_MD,
  zip: SPEC_ARCHIVE,
  tar: SPEC_ARCHIVE,
  gz: SPEC_ARCHIVE,
  rar: SPEC_ARCHIVE,
  '7z': SPEC_ARCHIVE,
  html: SPEC_HTML,
  htm: SPEC_HTML,
  pdf: SPEC_PDF,
};

/** 文件名（basename）→ 图标形状 + 着色；扩展名大小写不敏感，未知回中性 File */
export function fileIconFor(name: string): FileIconSpec {
  const dot = name.lastIndexOf('.');
  // 无扩展名（Makefile）或以点开头的裸名（.gitignore 扩展名视为 gitignore）
  if (dot <= 0 || dot === name.length - 1) return SPEC_DEFAULT;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? SPEC_DEFAULT;
}
