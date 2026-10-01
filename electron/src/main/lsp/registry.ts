// 多语言 LSP 注册表（spec §5）——声明式数据，无逻辑分支。
// markers 为 glob（仅支持单段 `*`）：`tsconfig.json` 精确文件；`*/tsconfig.json`
// 一层子目录内；`*.csproj` 根层通配。求值规则（跳过目录清单）见 detect.ts。
import fs from 'node:fs';
import path from 'node:path';

export interface LanguageServerSpec {
  languageId: string;
  label: string;
  binaries: string[];
  args: string[];
  markers: string[];
  extensions: string[];
  tier: 'verified' | 'experimental';
  installHint: string;
  initOverrides?: Record<string, unknown>;
}

export const REGISTRY: readonly LanguageServerSpec[] = [
  {
    languageId: 'typescript', label: 'TypeScript / JavaScript',
    binaries: ['typescript-language-server'], args: ['--stdio'],
    markers: ['tsconfig.json', 'jsconfig.json', '*/tsconfig.json', '*/jsconfig.json'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    tier: 'verified',
    installHint: 'npm install -g typescript-language-server typescript',
  },
  {
    languageId: 'python', label: 'Python',
    binaries: ['pyright-langserver'], args: ['--stdio'],
    markers: ['pyproject.toml', 'requirements*.txt', 'setup.py', 'setup.cfg'],
    extensions: ['.py', '.pyi'],
    tier: 'verified',
    installHint: 'pip install pyright（或 npm install -g pyright）',
  },
  {
    languageId: 'go', label: 'Go',
    binaries: ['gopls'], args: [],
    markers: ['go.mod', '*/go.mod'],
    extensions: ['.go'],
    tier: 'verified',
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    languageId: 'rust', label: 'Rust',
    binaries: ['rust-analyzer'], args: [],
    markers: ['Cargo.toml', '*/Cargo.toml'],
    extensions: ['.rs'],
    tier: 'verified',
    installHint: 'rustup component add rust-analyzer',
  },
  {
    languageId: 'cpp', label: 'C / C++',
    binaries: ['clangd'], args: [],
    markers: ['compile_commands.json', 'CMakeLists.txt', 'Makefile', 'configure.ac'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'],
    tier: 'verified',
    installHint: 'brew install llvm（macOS，然后加入 PATH）或系统包管理器安装 clangd',
    initOverrides: { fallbackFlags: ['-std=c++17'] },
  },
  {
    languageId: 'swift', label: 'Swift / Objective-C',
    binaries: ['sourcekit-lsp'], args: [],
    markers: ['Package.swift'],
    extensions: ['.swift'],
    tier: 'verified',
    installHint: 'xcode-select --install（Xcode Command Line Tools 自带）',
  },
  {
    languageId: 'ruby', label: 'Ruby',
    binaries: ['ruby-lsp'], args: [],
    markers: ['Gemfile', '*.gemspec'],
    extensions: ['.rb'],
    tier: 'verified',
    installHint: 'gem install ruby-lsp',
  },
  {
    languageId: 'lua', label: 'Lua',
    binaries: ['lua-language-server'], args: [],
    markers: ['.luarc.json'],
    extensions: ['.lua'],
    tier: 'verified',
    installHint: 'brew install lua-language-server 或 GitHub release 下载',
  },
  {
    languageId: 'shell', label: 'Shell',
    binaries: ['bash-language-server'], args: ['start'],
    markers: ['*.sh'],
    extensions: ['.sh', '.bash'],
    tier: 'verified',
    installHint: 'npm install -g bash-language-server',
  },
  {
    languageId: 'csharp', label: 'C#',
    binaries: ['csharp-ls'], args: [],
    markers: ['*.csproj', '*.sln'],
    extensions: ['.cs'],
    tier: 'verified',
    installHint: 'dotnet tool install --global csharp-ls',
  },
  {
    languageId: 'dart', label: 'Dart / Flutter',
    binaries: ['dart'], args: ['language-server', '--protocol=lsp'],
    markers: ['pubspec.yaml'],
    extensions: ['.dart'],
    tier: 'verified',
    installHint: '安装 Dart SDK（server 随 SDK 自带）',
  },
  {
    languageId: 'zig', label: 'Zig',
    binaries: ['zls'], args: [],
    markers: ['build.zig'],
    extensions: ['.zig'],
    tier: 'verified',
    installHint: 'brew install zls 或 GitHub release 下载',
  },
  {
    languageId: 'java', label: 'Java',
    binaries: ['jdtls'], args: [],
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    extensions: ['.java'],
    tier: 'experimental',
    installHint: 'brew install jdtls（实验性：部分项目布局可能需要额外配置）',
  },
  {
    languageId: 'kotlin', label: 'Kotlin',
    binaries: ['kotlin-language-server'], args: ['--stdio'],
    markers: ['*.kt', 'build.gradle.kts'],
    extensions: ['.kt', '.kts'],
    tier: 'experimental',
    installHint: 'brew install kotlin-language-server（实验性）',
  },
  {
    languageId: 'php', label: 'PHP',
    binaries: ['intelephense'], args: ['--stdio'],
    markers: ['composer.json', 'index.php', 'artisan'],
    extensions: ['.php'],
    tier: 'experimental',
    installHint: 'npm install -g intelephense（实验性）',
  },
  {
    languageId: 'elixir', label: 'Elixir',
    binaries: ['lexical', 'lexical-server'], args: [],
    markers: ['mix.exs'],
    extensions: ['.ex', '.exs'],
    tier: 'experimental',
    installHint: '按 lexical 官方文档安装（实验性）',
  },
];

/** 扩展名 → languageId（注册表顺序优先：.h 归 cpp） */
export function extensionToLanguageId(ext: string): string | null {
  const e = ext.toLowerCase();
  for (const s of REGISTRY) {
    if (s.extensions.includes(e)) return s.languageId;
  }
  return null;
}

/** X_OK 可执行检查（不抛错版） */
function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH 探测：逐目录拼接 + 文件检查 + X_OK 可执行检查；命中返回绝对路径。
 *  isFile 守卫不可省：POSIX 目录可遍历即过 X_OK，PATH 内同名子目录会被误报命中。 */
export function findBinaryInPath(binaries: string[], envPath?: string): string | null {
  const dirs = (envPath ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const bin of binaries) {
    if (bin.includes(path.sep)) {
      try {
        if (fs.statSync(bin).isFile() && isExecutable(bin)) return bin;
      } catch { /* 不存在或不可访问——继续候选 */ }
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      try {
        if (fs.statSync(full).isFile() && isExecutable(full)) return full;
      } catch { /* 下一目录 */ }
    }
  }
  return null;
}
