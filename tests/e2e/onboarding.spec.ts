// tests/e2e/onboarding.spec.ts
//
// End-to-end onboarding integration test.
//
// Launches the Electron app against the built electron/renderer bundles and
// walks the full 4-step onboarding wizard (welcome -> mode -> account ->
// complete), then asserts:
//   1. The main shell appears (the LeftRail "View: IM" nav button is visible).
//   2. `state.db` was created in the isolated user-data directory.
//   3. (When better-sqlite3 is loadable from the test process) `kv_store`
//      contains the `current_user_id` row written by the register flow.
//
// The Matrix token itself lives in the OS keychain (keytar/libsecret), which
// cannot be inspected portably from a test; the visible main shell plus the
// `current_user_id` DB row together prove the register -> persist -> restore
// round-trip succeeded end to end.
//
// Prerequisites (must run before this test):
//   pnpm --filter ./electron build
//   pnpm --filter ./renderer build
//
// Environment requirements:
//   - A display (run under `xvfb-run` on headless Linux).
//   - libsecret/DBus available for keytar (Linux).
//   - 2.0.0 起无外部 homeserver 依赖（Matrix/Conduit 已移除，P1）——
//     注册步骤走本地 SQLite；此 e2e 尚未按 2.0 会话内核重写（README 技术债在案）。
//
// Run manually (NOT in CI by default):
//   xvfb-run -a pnpm e2e tests/e2e/onboarding.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Resolve modules through the @momo-studio/electron workspace package. `electron` and
// `better-sqlite3` are dependencies of @momo-studio/electron, not the workspace root, so
// a plain `require('electron')` from this root-level test would fail under
// pnpm's isolated node_modules layout. createRequire scoped to the workspace
// package.json makes the resolution deterministic.
const electronRequire = createRequire(
  path.join(__dirname, '..', '..', 'electron', 'package.json'),
);
const REPO_ROOT = path.join(__dirname, '..', '..');
const ELECTRON_APP_DIR = path.join(REPO_ROOT, 'electron');

// Isolated user-data dir per run so the test never touches the operator's real
// ~/.momo-studio and never picks up a stale registered user.
const tmpUserData = path.join(os.tmpdir(), `ap-e2e-${Date.now()}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

test('full onboarding flow', async () => {
  // `require('electron')` from a Node (non-Electron) context returns the path
  // to the Electron binary as a string.
  const electronPath = electronRequire('electron') as string;

  const app = await electron.launch({
    args: [ELECTRON_APP_DIR],
    env: {
      ...process.env,
      // Force the app to use our throwaway dir for state.db etc.
      AP_USER_DATA_DIR: tmpUserData,
    },
    colorScheme: 'dark',
  });

  // Fail the test loudly if the main process crashes instead of hanging.
  app.process().once('exit', (code) => {
    if (code !== 0) {
      throw new Error(`Electron main process exited with code ${code}`);
    }
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // --- Step 1: Welcome -----------------------------------------------------
  await win.getByRole('button', { name: /get started/i }).click();

  // --- Step 2: Mode --------------------------------------------------------
  // Standalone is the only selectable mode (connect is disabled) and is
  // pre-selected; click the card to be explicit, then continue.
  await win.getByText(/standalone/i).click();
  await win.getByRole('button', { name: /continue/i }).click();

  // --- Step 3: Account -----------------------------------------------------
  await win.getByLabel(/username/i).fill('alice');
  // Anchored /^password/ so it does not also match "Confirm password".
  await win.getByLabel(/^password/i).fill('passpass');
  await win.getByLabel(/confirm password/i).fill('passpass');
  await win.getByRole('button', { name: /create account/i }).click();

  // --- Step 4: Complete ----------------------------------------------------
  // The complete step auto-advances after ~1.5s; the App component then flips
  // to the authenticated branch and renders MainShell -> LeftRail. The LeftRail
  // nav buttons expose an aria-label of "View: IM", which getByLabel matches.
  await expect(win.getByLabel('View: IM')).toBeVisible({ timeout: 15000 });

  // --- Verify persistence --------------------------------------------------
  // state.db must exist in the isolated user-data dir.
  const dbPath = path.join(tmpUserData, 'state.db');
  expect(fs.existsSync(dbPath), 'state.db should exist after onboarding').toBe(true);

  // If the better-sqlite3 native binding is loadable from the test process,
  // additionally assert the kv_store row that the register flow writes. The
  // binding lives in @momo-studio/electron; on some CI images it may not be importable
  // from outside the Electron process, so this check is best-effort and the
  // visible main shell above remains the hard gate.
  let BetterSqlite3: typeof import('better-sqlite3') | undefined;
  try {
    BetterSqlite3 = electronRequire('better-sqlite3');
  } catch {
    // Native binding not available to the test process.
  }

  if (BetterSqlite3) {
    const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT value FROM kv_store WHERE key = ?')
        .get('current_user_session') as { value: string } | undefined;
      expect(row, 'kv_store should contain current_user_session').toBeDefined();
      // The stored value is JSON.stringify({ userId, deviceId }) and must round-trip
      // back to the renderer's AuthResult shape.
      const session = JSON.parse(row!.value) as { userId: unknown; deviceId: unknown };
      expect(typeof session.userId, 'session.userId should be a string').toBe('string');
      expect(typeof session.deviceId, 'session.deviceId should be a string').toBe('string');
    } finally {
      db.close();
    }
  }

  await app.close();
});
