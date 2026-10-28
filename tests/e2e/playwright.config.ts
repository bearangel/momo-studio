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
// CI：`.github/workflows/e2e.yml` 在 push/PR → main 上跑全量（M2.4 T7）——
//   步骤含 electron-rebuild（ABI 149，e2e 启动真 Electron 必需）。
// 拖拽/浏览器交互类用例（kanban-drag / browser）在 CI runner 上受显示与
// 输入模拟差异影响，靠 retries 吸收偶发；持续红则按 spec 预案隔离。
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
