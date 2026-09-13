// electron/src/main/browser/protocol.ts
//
// browser-shot:// 自定义协议（v2.7 McpBrowser Task 10，spec §3.7 / §12.3）。
//
// `browser-shot://<wsId>/<file>` → `<screenshotDir>/<wsId>/<file>` 文件字节——
// renderer <img src="browser-shot://..."> 渲染 agent 截图产物。scheme 需在
// app ready 前经 protocol.registerSchemesAsPrivileged 注册为 standard（boot
// 接线层 index.ts 负责——本模块只注册 handler，handle 须在 app ready 后调用）。
//
// 安全边界（与 policy.assertFilePath 同源规则）：
//   - 解码后的路径段含 `..` / 反斜杠 / 绝对路径 → 403 风格拒绝（不读盘）
//   - 文件不存在 / 不是常规文件 → 404
// protocol 经结构性注入（ProtocolLike）——单测零 Electron import。

import fs from 'node:fs';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';

/** 协议 scheme 常量（boot registerSchemesAsPrivileged 与 renderer 引用方契约） */
export const BROWSER_SHOT_SCHEME = 'browser-shot';

/** electron protocol 的结构性子集（注入——生产传 electron protocol，测试传桩） */
export interface ProtocolLike {
  handle(
    scheme: string,
    handler: (request: { url: string }) => Response | Promise<Response>,
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

/**
 * 注册 browser-shot:// handler。
 * screenshotDir = `<userData>/browser-screenshots`（boot 注入 app.getPath('userData') 拼接产物）。
 */
export function registerBrowserShotProtocol(protocol: ProtocolLike, screenshotDir: string): void {
  protocol.handle(BROWSER_SHOT_SCHEME, (request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('非法 browser-shot URL', { status: 403 });
    }
    const wsId = parsed.host;
    if (!wsId) {
      return new Response('browser-shot URL 缺少 workspaceId', { status: 403 });
    }
    const segments = safeSegments(parsed.pathname);
    if (!segments) {
      return new Response('browser-shot 拒绝路径穿越', { status: 403 });
    }
    // 基目录锚定后 resolve——即使未来清洗规则有漏，双重边界仍拦绝对逃逸
    //（isInsideDir 统一 win32 大小写/前缀边界语义）
    const wsRoot = path.resolve(screenshotDir, wsId);
    const abs = path.resolve(wsRoot, ...segments);
    if (!isInsideDir(wsRoot, abs, { win32: PATH_SEMANTICS_WIN32 })) {
      return new Response('browser-shot 拒绝路径穿越', { status: 403 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return new Response('截图不存在', { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response('非文件目标', { status: 404 });
    }
    const body = fs.readFileSync(abs);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.byteLength) },
    });
  });
}
