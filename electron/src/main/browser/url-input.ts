// electron/src/main/browser/url-input.ts
//
// 导航输入归一（纯模块，零 Electron 依赖——只 node:path / node:url，可直接单测）。
//
// 背景（spec 2026-11-02 §5.3）：Windows 上模型传 `file:///研发周报PPT模板.html#p2`
// 这类「无盘符 file URL」时，node 的 fileURLToPath 抛 ERR_INVALID_FILE_URL_PATH
// （must be absolute），而模型又无法表达「工作空间相对路径」——六连败的根因。
// 本模块把工具的 URL 入参归一成绝对 URL：相对路径按 workspaceDir 解析，file://
// 能映射成绝对路径的原样保留，其余 scheme 原样透传。
//
// 职责边界（刻意不做，YAGNI）：
//   - 不做工作空间边界检查 / 文件存在性检查 —— 那是 policy（assertUrl/assertFilePath）的职责
//   - 不校验协议合法性 —— 交给 policy 抛 BrowserProtocolError，保持既有错误分类不变
//
// 判定顺序即契约（spec §5.3 六步）：盘符形态优先排除 → http(s) → file:（先试
// fileUrlToPath）→ 其他 scheme 透传 → 无 scheme/回退时先切 #/? 再判平台绝对性。
import path from 'node:path';
import { fileURLToPath as nodeFileURLToPath, pathToFileURL } from 'node:url';

export interface ResolveNavigateInputOpts {
  workspaceDir: string;
  /** 仅用于「平台绝对性」判定与 file: 解析；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** 注入以便 win32 单测（node:url 的 file↔path 语义按 process.platform 内部分叉，只能手写 mock） */
  fileUrlToPath?: (u: URL) => string;
}

/** 通用 scheme 前缀（RFC 3986）：字母开头 + 字母数字/+.- */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Windows 盘符绝对形态（C:\x、C:/x）——必须先于 scheme 解析判定，否则 `C:` 会被当 scheme */
const WIN32_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** Windows UNC 绝对形态（\\srv\share\x） */
const WIN32_UNC_RE = /^\\\\/;

/** 平台绝对性判定（win32：盘符或 UNC；其余平台：前导 /） */
function isPlatformAbsolute(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return WIN32_DRIVE_RE.test(p) || WIN32_UNC_RE.test(p);
  return p.startsWith('/');
}

/** 宽容解码：非法 percent-encoding（含字面 %）原样返回，绝不抛错 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 按首个 # 或 ? 切出路径部分与后缀（必须先切，否则 a.html#p2 会把 #p2 当文件名） */
function splitSuffix(raw: string): { pathPart: string; suffix: string } {
  const i = raw.search(/[#?]/);
  if (i < 0) return { pathPart: raw, suffix: '' };
  return { pathPart: raw.slice(0, i), suffix: raw.slice(i) };
}

/** 把后缀拆成 search / hash 挂回结果 URL（保证 a.html?x=1#p2 原样保留） */
function attachSuffix(url: URL, suffix: string): URL {
  if (suffix === '') return url;
  const hashAt = suffix.indexOf('#');
  const search = hashAt < 0 ? suffix : suffix.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : suffix.slice(hashAt);
  if (search !== '') url.search = search;
  if (hash !== '') url.hash = hash;
  return url;
}

/**
 * 第 6 步：路径部分 + 后缀 → 绝对 file URL。
 * 绝对路径按原语义（越界由 policy 拒），相对路径按 workspaceDir 解析。
 */
function toAbsoluteFileUrl(
  pathPart: string,
  suffix: string,
  workspaceDir: string,
  platform: NodeJS.Platform,
): string {
  const decoded = safeDecode(pathPart);
  const abs = isPlatformAbsolute(decoded, platform)
    ? path.resolve(decoded)
    : path.resolve(workspaceDir, decoded);
  return attachSuffix(pathToFileURL(abs), suffix).href;
}

/**
 * 把 agent 传入的导航目标归一成绝对 URL。
 *
 * @throws Error 入参为空/全空白（message 含「URL 为空」）
 */
export function resolveNavigateInput(
  raw: string,
  opts: ResolveNavigateInputOpts,
): { url: string } {
  const platform = opts.platform ?? process.platform;
  const fileUrlToPath = opts.fileUrlToPath ?? nodeFileURLToPath;
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('URL 为空：请传工作空间相对路径（如 report.html）或完整 URL');
  }

  // 第 2 步：盘符形态先于 scheme 解析（C:\x 不是 scheme c:）
  if (!WIN32_DRIVE_RE.test(trimmed)) {
    const scheme = SCHEME_RE.exec(trimmed)?.[0]?.toLowerCase();

    // 第 3 步：http(s) 原样（域名白/黑名单仍在 policy 判）
    if (scheme === 'http:' || scheme === 'https:') return { url: trimmed };

    // 第 4 步：file: 先试 fileUrlToPath——UNC 与盘符形态都靠这条正确解析
    if (scheme === 'file:') {
      let parsed: URL | undefined;
      try {
        parsed = new URL(trimmed);
      } catch {
        parsed = undefined; // 极端非法形态：降级为「file: 之后的部分」当路径
      }
      if (parsed !== undefined) {
        try {
          const abs = fileUrlToPath(parsed);
          const url = pathToFileURL(path.resolve(abs));
          return { url: attachSuffix(url, `${parsed.search}${parsed.hash}`).href };
        } catch {
          // win32 无盘符形态（file:///x.html）或非法 percent-encoding → 走第 6 步回退
        }
      }
      const rawPathname = parsed?.pathname ?? trimmed.slice('file:'.length);
      const suffix = parsed !== undefined ? `${parsed.search}${parsed.hash}` : '';
      // win32 上 file:/// 后的前导 / 只表示「无盘符」，不携带根语义（本平台无此形态的
      // 合法含义，spec §5.3 已知取舍：按相对路径处理）；posix 上 /x 是合法绝对路径，
      // 不能剥——越界由 policy 拒。
      const pathPart = platform === 'win32' ? rawPathname.replace(/^\/+/, '') : rawPathname;
      return { url: toAbsoluteFileUrl(pathPart, suffix, opts.workspaceDir, platform) };
    }

    // 第 5 步：其他已知/未知 scheme 原样透传（错误分类归 policy）
    if (scheme !== undefined) return { url: trimmed };
  }

  // 第 6 步：无 scheme（含盘符形态）或第 4 步回退
  const { pathPart, suffix } = splitSuffix(trimmed);
  return { url: toAbsoluteFileUrl(pathPart, suffix, opts.workspaceDir, platform) };
}
