// tests/e2e/pin-geometry.ts
//
// 钉几何 harness（M3.0 T6，dev-only）：本机复现 CI runner 显示几何，零 CI 往返。
//
// 背景（PR #1 run 40676120418 artifacts 实锤）：GitHub macos-latest runner 显示器
// 1024×768，最大化 workarea ≈ 1024×677。两条交互 spec 曾按开发者大屏假设编写——
// kanban-drag 的已关闭列中心在 1024 视口外（指针可达性死区），browser 的增高腿
// 被 AppKit visible-frame 钳到 677 上限。本 helper 在 firstWindow 后把主窗口
// content bounds 钉死为指定尺寸，本机即可复现 CI 的视口约束。
//
// 用法（环境变量缺省时 no-op，不影响 CI 与本机大屏语义）：
//   E2E_PIN_GEOMETRY=1024x677 npx pnpm@9.0.0 e2e tests/e2e/kanban-drag.spec.ts
import type { ElectronApplication } from '@playwright/test';

/** 解析 E2E_PIN_GEOMETRY（<宽>x<高>，如 1024x677）；非法值直接抛错（开发工具要响亮失败） */
function parsePinGeometry(): { width: number; height: number } | null {
  const raw = process.env.E2E_PIN_GEOMETRY;
  if (!raw) return null;
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (!m) throw new Error(`E2E_PIN_GEOMETRY 格式非法: ${raw}（期望 <宽>x<高>，如 1024x677）`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 按 E2E_PIN_GEOMETRY 钉死主窗口 content bounds。须在 firstWindow 之后、
 * 与窗口几何相关的交互之前调用（onboarding 阶段即可）。
 */
export async function pinWindowGeometry(app: ElectronApplication): Promise<void> {
  const geometry = parsePinGeometry();
  if (!geometry) return;
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) throw new Error('主窗口不存在');
    // 首启 maximize 态下 setContentBounds 语义不定（macOS 表现为调整 zoomed 区域），
    // 先 unmaximize 再钉——与 browser.spec resize 腿同款已验证序
    if (win.isMaximized()) win.unmaximize();
    const current = win.getContentBounds();
    win.setContentBounds({ x: current.x, y: current.y, width, height });
  }, geometry);
}
