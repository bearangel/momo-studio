// 多语言 LSP 注册表（spec §5）——声明式数据，无逻辑分支。
// markers 为 glob（仅支持单段 `*`）：`tsconfig.json` 精确文件；`*/tsconfig.json`
// 一层子目录内；`*.csproj` 根层通配。求值规则（跳过目录清单）见 detect.ts。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSharedBinDir } from './shared-bin';

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
  /** 面板一键安装元数据（D3 修正案）：仅挂确证 npm 分发的语言（4 门）；
   *  缺省 undefined = 手动引导（installHint）。LanguageStatus.installable 派生自此。 */
  install?: { kind: 'npm'; packages: string[] };
  /** 二进制附验钩子（可选，2026-10-08）：PATH 命中后二次校验可用性——rustup
   *  shim 类「空壳可执行」存在性探测必误报。同步 + 模块级缓存（detect 是同步
   *  函数）；返回 false = 按未安装处理（面板不给启动按钮，installHint 引导）。 */
  binaryValidator?: (binPath: string) => boolean;
}

export const REGISTRY: readonly LanguageServerSpec[] = [
  {
    languageId: 'typescript', label: 'TypeScript / JavaScript',
    binaries: ['typescript-language-server'], args: ['--stdio'],
    // package.json 作为 JS 工程标志：纯 JS 项目（Vue/React/Node 脚本）常无
    // tsconfig/jsconfig，而 typescript-language-server 同样服务 .js 文件
    // （GUI 验收实证：纯 JS monorepo 全部语言 inactive 导致无安装入口）
    markers: [
      'tsconfig.json', 'jsconfig.json', '*/tsconfig.json', '*/jsconfig.json',
      'package.json', '*/package.json',
    ],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    tier: 'verified',
    // §A pin：TS 必须锁 ^5——npmmirror 等镜像默认装 TS 7（tsgo 时代）无经典
    // tsserver.js，typescript-language-server 找不到 server 直接哑火
    installHint: 'npm install -g typescript-language-server typescript@^5',
    install: { kind: 'npm', packages: ['typescript-language-server', 'typescript@^5'] },
  },
  {
    languageId: 'python', label: 'Python',
    binaries: ['pyright-langserver'], args: ['--stdio'],
    markers: ['pyproject.toml', 'requirements*.txt', 'setup.py', 'setup.cfg'],
    extensions: ['.py', '.pyi'],
    tier: 'verified',
    installHint: 'pip install pyright（或 npm install -g pyright）',
    install: { kind: 'npm', packages: ['pyright'] },
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
    // rustup shim 特判（2026-10-08 GUI 验收）：~/.cargo/bin/rust-analyzer 在组件
    // 未装时是「打印一行错误即退」的空壳——PATH 存在性探测必误报（面板给启动
    // 按钮 → spawn 秒退「已关闭」）。附验 rustup 组件表；brew/系统真二进制
    // （非 .cargo/bin 路径）不归 rustup 管，直接放行。
    binaryValidator: validateRustAnalyzer,
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
    install: { kind: 'npm', packages: ['bash-language-server'] },
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
    install: { kind: 'npm', packages: ['intelephense'] },
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

// ── GUI 启动 PATH 兜底（macOS Finder/Dock 启动修复）────────────────────────
// launchd 拉起的 GUI 应用 PATH 仅 /usr/bin:/bin:/usr/sbin:/sbin——homebrew 装
// 的 gopls / rust-analyzer / zls 等全部误报 missing-binary（detect 快照不注册
// + doInitialize spawn 失败双重命中）。兜底两层：常见 bin 前缀追加 + login
// shell 解析。注意不能用 `/usr/bin/env which`：它继承同一 process.env.PATH，
// 解析不到 profile 注入的目录（spec §9 勘误）。

/** rustup 组件表缓存（进程级——resolveNpmPrefix 同型先例）。redetect 时经
 *  invalidateBinaryValidatorCache() 失效，保证「重新检测」真重探。 */
let rustupComponentsCache: string[] | null = null;

/** 失效二进制校验缓存（redetect 调用；测试复位复用同入口） */
export function invalidateBinaryValidatorCache(): void {
  rustupComponentsCache = null;
}

/** rustup shim 附验：路径不在 .cargo/bin 下 → 真二进制放行；在 → 查组件表
 *  （sync spawn + 进程级缓存——detect 是同步函数，rustup 调用 ~50ms 仅首次）。
 *  rustup 不可用/超时 → 放行（保守：宁误报可用也不把已装用户判成未装）。 */
function validateRustAnalyzer(binPath: string): boolean {
  if (!binPath.includes(`${path.sep}.cargo${path.sep}bin`)) return true;
  if (rustupComponentsCache === null) {
    try {
      const r = spawnSync('rustup', ['component', 'list', '--installed'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      // 查询不可得（ENOENT / 超时 / 非 0 退出）≠ 组件未装——保守放行且不缓存
      // （下次调用重试；redetect 的 invalidate 亦触发重探）
      if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== 'string') return true;
      rustupComponentsCache = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return true;
    }
  }
  return rustupComponentsCache.includes('rust-analyzer');
}

/** 常见包管理器 bin 前缀（存在才追加、幂等）：Apple Silicon / Intel homebrew */
const COMMON_BIN_PREFIXES = ['/opt/homebrew/bin', '/usr/local/bin'];

/** login shell 内 `command -v <bin>`（bin 来自受控 REGISTRY 标识符，无注入面）。
 *  login shell 会 source profile 拿到 homebrew shellenv；导出供单测直连。 */
export function loginShellWhich(bin: string): string | null {
  if (process.platform === 'win32') return null;
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  try {
    const r = spawnSync(shell, ['-lc', `command -v ${bin}`], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    if (r.error || r.status !== 0) return null;
    // profile 启动脚本可能向 stdout 打噪声：取最后一个非空行，且必须是绝对
    // 路径 + 落盘为可执行文件（alias/函数名无 / 前缀，噪声行非路径，均被滤除）
    const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    const candidate = lines[lines.length - 1];
    if (!candidate || !candidate.startsWith('/')) return null;
    try {
      if (!fs.statSync(candidate).isFile() || !isExecutable(candidate)) return null;
    } catch {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/** PATH 探测：逐目录拼接 + 文件检查 + X_OK 可执行检查；命中返回绝对路径。
 *  isFile 守卫不可省：POSIX 目录可遍历即过 X_OK，PATH 内同名子目录会被误报命中。
 *  GUI 兜底门控：显式注入 envPath = 伪 PATH 隔离模式（单测语义），整套 GUI
 *  兜底（前缀追加 + login shell）禁用——否则用例结果随宿主安装内容漂移；
 *  生产调用方一律不传 envPath（用真实 process.env.PATH），兜底全量生效。
 *  显式 shellFallback 不受门控影响（兜底行为自身的注入测试）。 */
export function findBinaryInPath(
  binaries: string[],
  envPath?: string,
  shellFallback?: (bin: string) => string | null,
): string | null {
  const guiFallback = envPath === undefined;
  const dirs = (envPath ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (guiFallback) {
    // 第一层：常见包管理器前缀追加（存在才加、幂等）——多数场景在此直接命中
    for (const p of COMMON_BIN_PREFIXES) {
      if (!dirs.includes(p) && fs.existsSync(p)) dirs.push(p);
    }
  }
  // 第三层（D3 修正案）：app 管理共享目录 <userData>/lsp-bin 的 .bin。与
  // homebrew 前缀不同，这不是宿主环境启发而是 setSharedBinDir 注入的确定性
  // app 状态——伪 PATH 隔离模式下同样生效（正是单测注入点）；仅要求目录
  // 实际存在（未装过即跳过）。优先级：PATH / 前缀 > 共享目录 > login shell
  const shared = getSharedBinDir();
  if (shared !== null) {
    const nmBin = path.join(shared, 'node_modules', '.bin');
    if (!dirs.includes(nmBin) && fs.existsSync(nmBin)) dirs.push(nmBin);
  }
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
  // 第二层：全 miss 后降级 login shell 兜底（`zsh/bash -lc 'command -v'`）
  const fallback = shellFallback !== undefined ? shellFallback : guiFallback ? loginShellWhich : null;
  if (fallback !== null) {
    for (const bin of binaries) {
      if (bin.includes(path.sep)) continue; // 含分隔符候选已按绝对路径直查过
      const hit = fallback(bin);
      if (hit) return hit;
    }
  }
  return null;
}
