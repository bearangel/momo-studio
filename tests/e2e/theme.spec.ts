// tests/e2e/theme.spec.ts
//
// v2.1 双主题启动基线（P4 Task 4）：锁「启动时主题判定 → canvas token 落到 <body>」全链路。
//
// 被测机制链：
//   - renderer/index.html 头部 parser 阻塞经典脚本 public/theme-boot.js——首绘前读
//     localStorage['momo.theme']，dark（或 system 且系统偏好深色）时给 <html> 加 .dark
//   - globals.css 基础规则 html/body/#root { background: rgb(var(--bg-canvas)) }
//   - theme.store 初始化 applyTheme 幂等双保险（单测已覆盖）
//
// 场景（P4 计划 (a)(b)(c) 的落地裁定）：
//   (a) 默认浅色启动：无存储值 + 系统 prefers-color-scheme: light（launch colorScheme 固定
//       light 保证确定性）→ <html> 无 .dark class，body 计算背景 = rgb(255,255,255)
//   (b) 深色启动：先启动一次写入 localStorage['momo.theme']='dark' 并优雅退出（Chromium
//       持久化到 userData 的 Local Storage/leveldb），二次启动 theme-boot.js 首绘前读取 →
//       <html class="dark"> + body 计算背景 = rgb(8,9,10)；colorScheme 仍固定 light，
//       同时锁「存储值优先于系统偏好」
//   (c) 运行时切换：PRAGMATIC 裁定不在 e2e 重复——page.evaluate 直调 theme store 脆弱
//       （依赖模块内部结构）、点击设置→外观路径过深且与主题机制无关注点；
//       运行时语义已由 renderer/src/stores/theme.store.test.ts 单测锁定
//
// 运行（同 smoke.spec.ts，需先 build 双 workspace；容器内 xvfb + electron-rebuild ABI）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/theme.spec.ts
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

// 两个场景各自独立子目录：(a) 依赖「无存储值」的干净状态，与 (b) 写入的持久化值互不污染，
// 测试间无顺序耦合
const tmpUserDataRoot = path.join(os.tmpdir(), `momo-theme-${Date.now()}-${process.pid}`);

// --bg-canvas token 期望值（globals.css :root / .dark；Chromium getComputedStyle 输出去空白后比对）
const LIGHT_CANVAS = 'rgb(255,255,255)';
const DARK_CANVAS = 'rgb(8,9,10)';

test.beforeAll(() => {
  fs.mkdirSync(tmpUserDataRoot, { recursive: true });
});

test.afterAll(() => {
  fs.rmSync(tmpUserDataRoot, { recursive: true, force: true });
});

/** body 计算背景色（去空白归一化）——html/body/#root 基础规则消费 --bg-canvas 变量 */
async function bodyBackgroundColor(win: Page): Promise<string> {
  return win.evaluate(() =>
    getComputedStyle(document.body).backgroundColor.replace(/\s+/g, ''),
  );
}

async function launchApp(userDataDir: string) {
  const app = await electron.launch({
    // --user-data-dir 隔离 Chromium profile（localStorage 所在的 Local Storage/leveldb）。
    // ⚠️ AP_USER_DATA_DIR 只路由应用级路径（state.db / logs / skills，见 electron/src/main/paths.ts），
    // 不影响 Chromium profile——不隔离的话 localStorage 读写会落真实 ~/.config/<appname>，
    // 跨测试/跨运行互相污染（实测踩坑：dark 写入泄漏后 (a) 永久失败）。
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, AP_USER_DATA_DIR: userDataDir },
    // 固定 light：(a) 排除系统偏好随机性；(b) 显式锁「存储 dark 压过系统 light」
    colorScheme: 'light',
    timeout: 30000,
  });
  app.process().once('exit', (code) => {
    if (code !== 0) {
      throw new Error(`Electron main process exited with code ${code}`);
    }
  });
  return app;
}

/** 等到首启空态（创建工作空间表单「名称」输入必现）——React 已挂载、CSS 已应用 */
async function waitForAppReady(win: Page): Promise<void> {
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByLabel('名称')).toBeVisible({ timeout: 15000 });
}

test('(a) 默认浅色启动：<html> 无 .dark class + body 背景 = 浅色 canvas token', async () => {
  const userData = path.join(tmpUserDataRoot, 'light');
  fs.mkdirSync(userData, { recursive: true });

  const app = await launchApp(userData);
  try {
    const win = await app.firstWindow();
    await waitForAppReady(win);

    // 默认 mode='system' + 系统 prefers light → theme-boot.js 与 theme.store 都不加 .dark
    const hasDark = await win.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(hasDark, '无存储值 + 系统 light 时 <html> 不应带 .dark class').toBe(false);

    expect(await bodyBackgroundColor(win)).toBe(LIGHT_CANVAS);
  } finally {
    await app.close();
  }
});

test('(b) 深色启动：localStorage 预设 dark → <html class="dark"> + body 背景 = 深色 canvas token', async () => {
  const userData = path.join(tmpUserDataRoot, 'dark');
  fs.mkdirSync(userData, { recursive: true });

  // 第一次启动：写入 momo.theme=dark（读回校验——theme-boot.js 消费的就是这个键值），
  // 优雅退出让 Chromium 把 localStorage 持久化到磁盘（Local Storage/leveldb）
  const first = await launchApp(userData);
  try {
    const win = await first.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const stored = await win.evaluate(() => {
      localStorage.setItem('momo.theme', 'dark');
      return localStorage.getItem('momo.theme');
    });
    expect(stored, 'localStorage 写入后应读回 dark（持久化前提）').toBe('dark');
    // 留出 LevelDB 异步提交窗口，降低优雅退出前未落盘的竞态
    await win.waitForTimeout(500);
  } finally {
    await first.close();
  }

  // 二次启动：theme-boot.js 首绘前读取持久化值。系统偏好仍为 light——
  // 若深色生效，证明走的是存储值而非系统偏好（优先级锁定）
  const second = await launchApp(userData);
  try {
    const win = await second.firstWindow();
    await waitForAppReady(win);

    const hasDark = await win.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(hasDark, '存储 dark 时 <html> 应带 .dark class（theme-boot.js 首绘前设定）').toBe(
      true,
    );

    expect(await bodyBackgroundColor(win)).toBe(DARK_CANVAS);
  } finally {
    await second.close();
  }
});
