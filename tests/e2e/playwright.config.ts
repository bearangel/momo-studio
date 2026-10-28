// tests/e2e/playwright.config.ts
//
// Playwright config for the Electron end-to-end suite.
//
// These tests launch the real Electron app (`_electron.launch`), which means:
//   - they need a display (wrap with `xvfb-run` on headless Linux)
//   - they need the Conduit homeserver binary + libsecret (for keytar) present
//   - the Electron app takes a single-instance lock, so only one test can run
//     at a time -> workers: 1
//
// 本地：
//   pnpm build && pnpm e2e
//   E2E_PIN_GEOMETRY=1024x677 pnpm e2e ...  # 钉 CI runner 几何复现（pin-geometry.ts）
// CI：`.github/workflows/e2e.yml` 在 push/PR → main 上跑全量（M2.4 T7）——
//   步骤含 electron-rebuild（ABI 149，e2e 启动真 Electron 必需）。
// kanban-drag / browser 曾在 CI 隔离（M2.4 T7 首跑），M3.0 T6 已按实测根因
// 适配并解禁：GitHub macos-latest 显示器 1024×768、最大化 workarea ≈1024×677
// ——看板失败=指针可达性（目标列中心在 1024 视口外），browser 失败=增高腿被
// AppKit visible-frame 钳制（677 上限）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // Electron startup + Conduit warm-up + onboarding can take a while on a cold
  // machine; give the whole test generous room.
  timeout: 120000,
  expect: {
    timeout: 15000,
  },
  // Electron's single-instance lock makes parallel workers race against each
  // other. Serialize the e2e suite.
  workers: 1,
  fullyParallel: false,
  // CI 上拖拽/浏览器交互类用例受显示与输入模拟差异影响 → 重试两次吸收偶发；
  // 本地保持 0，失败即真红（不让重试掩盖本地回归）。
  retries: process.env.CI ? 2 : 0,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
