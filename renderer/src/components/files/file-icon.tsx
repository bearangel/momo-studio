// renderer/src/components/files/file-icon.tsx
//
// 文件树类型图标（方案 A，2026-10-23 预览批准稿）：Material Icon Theme 内联
// SVG（file-icons.generated.ts，codegen 产物）。解析优先级同 VS Code：
// 精确文件名 > 多点扩展名（d.ts）> 扩展名 > 兜底 document；目录按名映射
// folder-* 变体（展开态取 *-open），未命中取派生通用 folder。
// 本模块是设计系统「lucide 16px/stroke 1.75」规则的已批准例外（彩色填充图标，
// 见 docs/dev/design-system.md 图标节）。
import { FILE_ICONS } from './file-icons.generated';

/** 精确文件名（小写）→ 图标键 */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.npmrc': 'npm',
  '.nvmrc': 'nodejs',
  '.env': 'lock',
  '.env.local': 'lock',
  '.env.example': 'lock',
  '.editorconfig': 'editorconfig',
  license: 'certificate',
  'license.md': 'certificate',
  'license.txt': 'certificate',
  changelog: 'changelog',
  'changelog.md': 'changelog',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'vitest.config.ts': 'vitest',
  'vitest.config.js': 'vitest',
  'jest.config.js': 'jest',
  'jest.config.ts': 'jest',
  'next.config.js': 'next',
  'next.config.mjs': 'next',
  'next.config.ts': 'next',
  'nuxt.config.ts': 'nuxt',
  'astro.config.mjs': 'astro',
  'astro.config.js': 'astro',
};

/** 扩展名（小写）→ 图标键；与 CodeEditor detectLanguage 的语言面保持同族覆盖 */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml', plist: 'xml',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less', styl: 'stylus',
  html: 'html', htm: 'html', vue: 'html',
  py: 'python', pyw: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  java: 'java',
  rb: 'ruby', erb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  ps1: 'powershell',
  sql: 'database', db: 'database', sqlite: 'database', db3: 'database',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  webp: 'image', ico: 'image', avif: 'image', svg: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  doc: 'word', docx: 'word',
  ppt: 'powerpoint', pptx: 'powerpoint',
  pdf: 'pdf',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', rar: 'zip', '7z': 'zip', bz2: 'zip',
  pem: 'certificate', crt: 'certificate', key: 'key',
  lock: 'lock',
  pug: 'pug', haml: 'haml', lua: 'lua', pl: 'perl', hs: 'haskell',
  ex: 'elixir', exs: 'elixir',
  sol: 'solidity', res: 'rescript',
  astro: 'astro',
};

/** 目录名（小写）→ folder-* 变体键（不含 folder- 前缀的短名） */
const DIR_NAMES: Record<string, string> = {
  src: 'src', lib: 'utils', app: 'app', core: 'src',
  test: 'test', tests: 'test', __tests__: 'test', spec: 'test', e2e: 'test',
  docs: 'docs', doc: 'docs', documentation: 'docs',
  node_modules: 'node',
  dist: 'dist', build: 'dist', out: 'dist', release: 'dist',
  examples: 'examples', example: 'examples', demos: 'examples',
  utils: 'utils', util: 'utils', shared: 'utils', common: 'utils', tools: 'utils',
  scripts: 'scripts', script: 'scripts', bin: 'scripts',
};

const DEFAULT_FILE = 'document';

/** 文件名（basename）→ 图标键；精确名 > 多点扩展名 > 扩展名 > document 兜底 */
export function fileIconKey(name: string): string {
  const lower = name.toLowerCase();
  const exact = BY_FILENAME[lower];
  if (exact !== undefined) return exact;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) return DEFAULT_FILE;
  const ext = lower.slice(dot + 1);
  const byExt = BY_EXT[ext];
  if (byExt !== undefined) return byExt;
  // 多点扩展名：lib.d.ts → 依次尝试 d.ts / ts（VS Code 同款回退序）
  const multi = lower.slice(lower.indexOf('.') + 1);
  const byMulti = BY_FILENAME[multi] ?? BY_EXT[multi];
  if (byMulti !== undefined) return byMulti;
  return DEFAULT_FILE;
}

/** 目录名（basename）→ folder-* 变体键或 null（通用 folder） */
export function folderIconKey(name: string): string | null {
  return DIR_NAMES[name.toLowerCase()] ?? null;
}

interface IconProps {
  size?: number;
}

/** 文件类型图标（内联彩色 SVG；unknown 类型由调用方走 document 兜底） */
export function FileTypeIcon({ name, size = 16 }: IconProps & { name: string }) {
  const key = fileIconKey(name);
  const data = FILE_ICONS[key] ?? FILE_ICONS[DEFAULT_FILE]!;
  return (
    <svg
      viewBox={`${data.l} ${data.t} ${data.w} ${data.h}`}
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
}

/** 目录图标：知名目录取 folder-* 变体（展开取 *-open），否则通用派生 folder */
export function FolderTypeIcon({ name, expanded = false, size = 16 }: IconProps & { name: string; expanded?: boolean }) {
  const short = folderIconKey(name);
  const key = short === null ? (expanded ? '_folder-open' : '_folder') : `folder-${short}${expanded ? '-open' : ''}`;
  const data = FILE_ICONS[key] ?? FILE_ICONS[expanded ? '_folder-open' : '_folder']!;
  return (
    <svg
      viewBox={`${data.l} ${data.t} ${data.w} ${data.h}`}
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  );
}
