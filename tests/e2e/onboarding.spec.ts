// tests/e2e/onboarding.spec.ts
//
// 新装引导向导 e2e（spec 2026-10-10）：首启向导出现 / 路线分叉进入供应商步 /
// 跳过落回原空态并持久（重启不再弹）。
//
// 裁定（docs/plans/2026-10-10-onboarding-wizard.md Task 10）：AI 路线完整成功
// 链路含真实 LLM 调用，属验收走查域（momo-acceptance，需真实供应商 key），
// CI e2e 覆盖：欢迎页 / 分叉 / 跳过持久 / 手动路线可达供应商步。
//
// 本文件取代 v1.x Matrix 时代同名 spec（其自述「尚未按 2.0 重写，技术债在案」
// ——本特性正式回收该使命）。
//
// 运行（需先 build 双 workspace；容器内需 xvfb；better-sqlite3 需 electron-rebuild）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/onboarding.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';

const electronRequire = createRequire(path.join(__dirname, '..', '..', 'electron', 'package.json'));
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const tmpUserData = path.join(os.tmpdir(), `momo-onboarding-${Date.now()}-${process.pid}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

async function launchApp(): Promise<{ app: ElectronApplication; win: Page }> {
  const electronPath = electronRequire('electron') as string;
  const app = await electron.launch({
    args: [ELECTRON_APP_DIR, '--no-sandbox'],
    env: { ...process.env, AP_USER_DATA_DIR: tmpUserData },
    colorScheme: 'dark',
    timeout: 30000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

test('首启向导：欢迎页可见，两条路线 + 跳过按钮', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win.getByRole('button', { name: /AI 引导/ })).toBeVisible({ timeout: 15000 });
    await expect(win.getByRole('button', { name: /手动引导/ })).toBeVisible();
    await expect(win.getByRole('button', { name: '跳过引导' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('路线分叉：AI / 手动均进入供应商步（配置模型服务）', async () => {
  const { app, win } = await launchApp();
  try {
    await win.getByRole('button', { name: /AI 引导/ }).click({ timeout: 15000 });
    await expect(win.getByText('配置模型服务')).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }
});

test('跳过引导：落回原空态表单，重启后不再出现向导（kv 持久）', async () => {
  const { app, win } = await launchApp();
  try {
    await win.getByRole('button', { name: '跳过引导' }).click({ timeout: 15000 });
    await expect(win.getByLabel('名称')).toBeVisible({ timeout: 10000 });
  } finally {
    await app.close();
  }

  const second = await launchApp();
  try {
    // skipped 持久 → 直接原空态（无向导按钮），「名称」输入即刻可见
    await expect(second.win.getByLabel('名称')).toBeVisible({ timeout: 15000 });
    await expect(second.win.getByRole('button', { name: /AI 引导/ })).toHaveCount(0);
  } finally {
    await second.app.close();
  }
});
