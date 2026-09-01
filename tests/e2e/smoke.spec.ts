// tests/e2e/smoke.spec.ts
//
// v25 最小冒烟：启动真实 Electron（构建产物）→ 断言首启空态渲染 + state.db 落盘。
//
// 背景（Task 15 清账）：旧 onboarding/e2e-full spec 走 v1.x 的 onboarding 向导 +
// Matrix IM 流程，界面已随 v2.0/v25 退役（标记 skip，待重写为 2.x 场景）。本冒烟
// 锁定当前最小可用闭环：应用能启动、首启空态（TitleBar + 内嵌创建工作空间表单）
// 可见、SQLite 状态库在隔离 userData 目录创建。
//
// 运行（需先 build 双 workspace；容器内需 xvfb；better-sqlite3 需 electron-rebuild）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/smoke.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const electronRequire = createRequire(
  path.join(__dirname, '..', '..', 'electron', 'package.json'),
);
const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const tmpUserData = path.join(os.tmpdir(), `momo-smoke-${Date.now()}-${process.pid}`);

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

test('v25 冒烟：应用启动 → 首启空态（创建工作空间表单）→ state.db 落盘', async () => {
  const electronPath = electronRequire('electron') as string;

  const app = await electron.launch({
    args: [ELECTRON_APP_DIR, '--no-sandbox'],
    env: { ...process.env, AP_USER_DATA_DIR: tmpUserData },
    colorScheme: 'dark',
    timeout: 30000,
  });

  app.process().once('exit', (code) => {
    if (code !== 0) {
      throw new Error(`Electron main process exited with code ${code}`);
    }
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 首启空态：TitleBar + 内嵌 CreateWorkspaceDialog（「名称」输入必现）
    await expect(win.getByLabel('名称')).toBeVisible({ timeout: 15000 });

    // SQLite 状态库已在隔离 userData 目录创建（主进程 boot 链完成迁移）
    const dbPath = path.join(tmpUserData, 'state.db');
    expect(fs.existsSync(dbPath), 'state.db 应落在隔离 userData 目录').toBe(true);
  } finally {
    await app.close();
  }
});
