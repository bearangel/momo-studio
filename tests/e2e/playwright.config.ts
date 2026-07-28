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
// The suite is intentionally NOT part of `pnpm test` / CI; run it manually
// before tagging a release:
//   pnpm --filter ./electron build && pnpm --filter ./renderer build
//   xvfb-run -a pnpm e2e
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
  retries: 0,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
