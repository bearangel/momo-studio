import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ELECTRON_APP_DIR = path.resolve(__dirname, '..', '..', 'electron');
const TMP_DIR = path.join(os.tmpdir(), `momo-e2e-${Date.now()}`);

test.beforeAll(() => { fs.mkdirSync(TMP_DIR, { recursive: true }); });
test.afterAll(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// v2.0/v25 待重写（Task 15 记录）：onboarding 向导与 Matrix IM 流程已退役，
// 本 spec 走的是 v1.x 界面；最小冒烟见 smoke.spec.ts。
test.skip('E2E: onboarding + workspace + agent + IM', async () => {
  const app = await electron.launch({
    args: [ELECTRON_APP_DIR, '--no-sandbox'],
    env: { ...process.env, AP_USER_DATA_DIR: TMP_DIR },
    timeout: 30000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.getByRole('button', { name: /get started/i }).click({ timeout: 10000 });
    await win.getByText(/standalone/i).click({ timeout: 10000 });
    await win.getByRole('button', { name: /continue/i }).click({ timeout: 10000 });

    await win.locator('input').nth(0).fill('alice', { timeout: 10000 });
    await win.locator('input[type="password"]').nth(0).fill('testpass123', { timeout: 10000 });
    const pwInputs = win.locator('input[type="password"]');
    if (await pwInputs.count() > 1) await pwInputs.nth(1).fill('testpass123');
    await win.getByRole('button', { name: /create/i }).click({ timeout: 10000 });

    await win.locator('[aria-label*="View"]').first().waitFor({ timeout: 30000 });
    console.log('Onboarding OK');

    await win.locator('button[title]').first().click({ timeout: 5000 });
    await win.getByText(/新建 workspace/i).click({ timeout: 5000 });

    const inputs = win.locator('input');
    await inputs.nth(0).fill('test-project');
    await inputs.nth(1).fill(path.join(TMP_DIR, 'test-project'));
    await win.getByRole('button', { name: /创建|create/i }).click({ timeout: 10000 });
    await win.waitForTimeout(3000);
    console.log('Workspace OK');

    await win.locator('[aria-label="View: Agents"]').click({ timeout: 5000 });
    await win.waitForTimeout(1000);

    const addBtn = win.getByRole('button', { name: /添加|add/i });
    if (await addBtn.count() > 0) await addBtn.first().click({ timeout: 5000 });
    await win.waitForTimeout(1000);

    const selectEl = win.locator('select').first();
    const hasOpts = (await selectEl.count()) > 0 && (await selectEl.locator('option').count()) > 0;

    if (!hasOpts) {
      await win.getByText(/创建自定义 agent/i).first().click({ timeout: 5000 });
      await win.waitForTimeout(500);
      const fi = win.locator('input');
      await fi.nth(0).fill('测试助手');
      await fi.nth(1).fill('test-assistant');
      await win.locator('textarea').first().fill('你是一个测试助手。');
      await fi.nth(-1).fill('glm-4-flash');
      const baseUrlInput = win.locator('input').filter({ hasText: '' }).filter({ has: win.locator('[placeholder*="bigmodel"]') });
      const baseUrlByPlaceholder = win.locator('input[placeholder*="bigmodel"], input[placeholder*="Base"]');
      if (await baseUrlByPlaceholder.count() > 0) await baseUrlByPlaceholder.fill('https://open.bigmodel.cn/api/paas/v4');
      await win.getByRole('button', { name: /^创建$/i }).click({ timeout: 5000 });
      await win.waitForTimeout(2000);
    }

    const apiKeyInput = win.locator('input[type="password"]');
    if (await apiKeyInput.count() > 0) {
      await apiKeyInput.fill(process.env.E2E_LLM_API_KEY ?? 'test-key');
      await win.getByRole('button', { name: /添加并启动/i }).click({ timeout: 15000 });
    }
    await win.waitForTimeout(3000);
    console.log('Agent OK');

    await win.locator('[aria-label="View: IM"]').click({ timeout: 5000 });
    await win.waitForTimeout(3000);

    const rooms = win.locator('button:has(span:has-text("团队群"))');
    console.log(`Rooms: ${await rooms.count()}`);

    if ((await rooms.count()) > 0) {
      await rooms.first().click({ timeout: 5000 });
      await win.waitForTimeout(1000);
      const ta = win.locator('textarea').last();
      await ta.fill('你好');
      await ta.press('Enter');
      await win.waitForTimeout(3000);
      console.log('Message sent');
    }

    console.log('E2E PASSED');
  } finally {
    await app.close();
  }
});
