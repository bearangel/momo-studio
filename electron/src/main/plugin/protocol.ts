// electron/src/main/plugin/protocol.ts
//
// momo-plugin:// 自定义协议（插件系统 P4，spec §6.1）。
//
// `momo-plugin://<pluginId>/<相对路径>` → 该插件安装根目录内的静态文件——
// renderer PanelHost 的 iframe src。origin = `momo-plugin://<pluginId>`（插件间
// 天然 origin 隔离，postMessage targetOrigin 严格校验依赖此）；scheme 需在
// app ready 前经 protocol.registerSchemesAsPrivileged 注册为 standard（index.ts
// boot 接线层负责——本模块只注册 handler，handle 须在 app ready 后调用）。
//
// 安全边界（复刻 browser/protocol.ts 同源规则，spec §6.1「只放行插件安装目录内」）：
//   - 解码后的路径段含 `..` / 反斜杠 / 空段 → 403（不读盘）
//   - 数据目录（plugins/data/<id>）不在任何 servable 根内——敏感 config 天然不可达
//   - 文件不存在 / 非常规文件 → 404；非 GET → 405
// protocol 经结构性注入（ProtocolLike）——单测零 Electron import。
import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import { getPlugin } from './registry';
import { resolvePluginRoot } from './assembly';

/** 协议 scheme 常量（boot registerSchemesAsPrivileged 与 renderer 引用方契约） */
export const PLUGIN_PANEL_SCHEME = 'momo-plugin';

/** electron protocol 的结构性子集（注入——生产传 electron protocol，测试传桩） */
export interface ProtocolLike {
  handle(
    scheme: string,
    handler: (request: { url: string; method?: string }) => Response | Promise<Response>,
  ): void;
}

/** 解码 URL path 且拒绝穿越段；安全时返回相对路径段数组，越界返回 null */
function safeSegments(rawPathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null; // 非法 percent-encoding
  }
  if (decoded.includes('\\')) return null; // Windows 分隔符注入
  if (decoded.includes('\0')) return null;
  // Electron 对 custom standard scheme 的 URL 会保留 `..` 段——逐段白名单判定：
  // 允许普通段与 `.`（归一化冗余），拒绝 `..` 与空段（路径拼接歧义）
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  if (segments.length === 0) return null;
  return segments;
}

/** 最小 mime 映射（v1 面板静态资源全集）；未命中 → octet-stream */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * 注册 momo-plugin:// handler。根目录解析走 registry 当前态：
 * zip → installed/<id>/<version>；dev → sourcePath；missing → 404。
 * 不校验 enablement——面板可见性由 renderer listPanels 过滤（§8.6），
 * 协议层只保证「已装插件目录内」这一物理边界（装了即信信任模型，spec §7.3）。
 */
export function registerPluginPanelProtocol(protocol: ProtocolLike): void {
  protocol.handle(PLUGIN_PANEL_SCHEME, (request) => {
    if (request.method !== undefined && request.method !== 'GET') {
      return new Response('momo-plugin 仅支持 GET', { status: 405 });
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('非法 momo-plugin URL', { status: 403 });
    }
    const pluginId = parsed.host;
    if (!pluginId) {
      return new Response('momo-plugin URL 缺少 pluginId', { status: 403 });
    }
    const segments = safeSegments(parsed.pathname);
    if (!segments) {
      return new Response('momo-plugin 拒绝路径穿越', { status: 403 });
    }
    const rec = getPlugin(pluginId);
    const root = rec ? resolvePluginRoot(rec) : null;
    if (!rec || !root) {
      return new Response('插件不存在', { status: 404 });
    }
    // 基目录锚定后 resolve——即使未来清洗规则有漏，双重边界仍拦绝对逃逸
    const abs = path.resolve(root, ...segments);
    if (!isInsideDir(root, abs, { win32: PATH_SEMANTICS_WIN32 })) {
      return new Response('momo-plugin 拒绝路径穿越', { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return new Response('文件不存在', { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response('非文件目标', { status: 404 });
    }
    const body = fs.readFileSync(abs);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
      },
    });
  });
}
