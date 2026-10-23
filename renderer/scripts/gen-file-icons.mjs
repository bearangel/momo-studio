// renderer/scripts/gen-file-icons.mjs
//
// 文件树图标方案 A codegen（2026-10-23 批准稿）：从
// @iconify-json/material-icon-theme（devDep）按白名单提取内联 SVG 数据，
// 生成 src/components/files/file-icons.generated.ts（确定性产物，随仓库提交；
// 白名单/派生规则变更后重跑：pnpm gen:file-icons）。
// 运行时零依赖零网络——renderer 只消费生成文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const data = require('@iconify-json/material-icon-theme/icons.json');
const icons = data.icons;

/** 白名单：文件类型 + 目录变体（含 *-open）+ 兜底 */
const WHITELIST = [
  // 语言/标记
  'typescript', 'javascript', 'json', 'markdown', 'changelog', 'yaml', 'toml', 'xml',
  'css', 'sass', 'less', 'html', 'vue', 'react', 'react-ts', 'angular', 'svelte',
  'python', 'go', 'rust', 'c', 'cpp', 'java', 'ruby', 'php', 'swift', 'kotlin',
  'console', 'powershell', 'elixir', 'lua', 'perl', 'haskell', 'stylus', 'pug',
  'haml', 'solidity', 'rescript', 'remix', 'qwik', 'astro', 'next', 'nuxt',
  // 数据/媒体/文档
  'database', 'image', 'video', 'audio', 'font', 'word', 'powerpoint', 'pdf',
  'zip', 'document', 'certificate',
  // 工具链/品牌
  'lock', 'key', 'git', 'gitlab', 'docker', 'nodejs', 'npm', 'yarn', 'pnpm',
  'webpack', 'vite', 'vitest', 'jest', 'eslint', 'prettier', 'makefile', 'cmake',
  'gradle', 'maven', 'terraform', 'kubernetes', 'helm', 'nginx', 'command',
  'editorconfig',
  // 目录变体（折叠 + 展开）
  'folder-src', 'folder-src-open', 'folder-test', 'folder-test-open',
  'folder-docs', 'folder-docs-open', 'folder-node', 'folder-node-open',
  'folder-dist', 'folder-dist-open', 'folder-examples', 'folder-examples-open',
  'folder-app', 'folder-app-open', 'folder-utils', 'folder-utils-open',
  'folder-scripts', 'folder-scripts-open',
];

const missing = WHITELIST.filter((n) => !icons[n]);
if (missing.length > 0) {
  console.error(`白名单图标缺失（上游集合变更？）: ${missing.join(', ')}`);
  process.exit(1);
}

/** 通用 folder 派生：folder-src 剪影取首 path（去 motive overlay），重着 Material 蓝灰 */
function deriveGenericFolder(sourceName, recolor) {
  const src = icons[sourceName];
  const m = src.body.match(/<path[^>]*\/>/);
  if (!m) throw new Error(`派生失败：${sourceName} 无 path`);
  return {
    l: src.left ?? 0,
    t: src.top ?? 0,
    w: src.width ?? 16,
    h: src.height ?? 16,
    body: m[0].replace(/fill="#[0-9a-fA-F]{6}"/, `fill="${recolor}"`),
  };
}

const entries = {};
for (const name of WHITELIST) {
  const ic = icons[name];
  // left/top 必须保留：Material Symbols 系图标（如 json，960 网格 top=-960）
  // 字形不在原点象限，丢偏移 = viewBox 对准空白区 → 渲染全空白（2026-10-23 实证）
  entries[name] = {
    l: ic.left ?? 0,
    t: ic.top ?? 0,
    w: ic.width ?? 16,
    h: ic.height ?? 16,
    body: ic.body,
  };
}
entries['_folder'] = deriveGenericFolder('folder-src', '#90A4AE');
entries['_folder-open'] = deriveGenericFolder('folder-src-open', '#90A4AE');

const body = `// ⚠️ 生成文件——勿手改。重跑：cd renderer && npx pnpm@9.0.0 gen:file-icons
// renderer/src/components/files/file-icons.generated.ts
//
// 文件树类型图标内联数据（方案 A，2026-10-23 预览批准稿）：
// 提取自 @iconify-json/material-icon-theme（MIT）——上游 Material Icon Theme
// （MIT，图形源自 Material Design Icons / Material Symbols，Apache-2.0）。
// '_folder'/'_folder-open' 为通用目录图标：folder-src 剪影去 motive overlay
// 派生、重着 #90A4AE（上游集合无通用 folder，派生规则见 scripts/gen-file-icons.mjs）。
// 中间调品牌色亮暗底通用，无 per-theme 变体。
export interface FileIconData {
  l: number;
  t: number;
  w: number;
  h: number;
  body: string;
}

export const FILE_ICONS: Record<string, FileIconData> = ${JSON.stringify(entries, null, 2)};
`;

const outPath = resolve(here, '../src/components/files/file-icons.generated.ts');
writeFileSync(outPath, body);
console.log(`written ${outPath}（${WHITELIST.length + 2} icons, ${body.length} bytes）`);
