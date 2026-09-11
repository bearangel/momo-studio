// tests/e2e/browser.spec.ts
//
// v2.7 McpBrowser e2e：真实构建应用全链路（启动 → workspace → 侧栏 → 地址栏导航 →
// user 态点击 → popup 收编 → 下载拦截 → overlay 接管 → resize bounds 同步）。
//
// 运行（同 smoke/theme spec，需先 build 双 workspace；容器内 xvfb + electron-rebuild ABI）：
//   npx pnpm@9.0.0 build && cd electron && npx electron-rebuild -f -w better-sqlite3
//   xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/browser.spec.ts
//
// 输入合成方式（容器降级，诚实标注）：
//   Playwright 的 Page 输入走 CDP 到主窗口 renderer，不会命中叠加的原生
//   WebContentsView（浏览器视图 / overlay 是独立 native widget）。因此页内点击经
//   主进程 webContents.sendInputEvent 驱动——这是 Electron 输入管线中 OS hit-testing
//   之后的同一入口（与真实鼠标事件此后同路径：Chromium 合成 click → 页面 listener）。
//   未覆盖面 = OS 层「哪个子视图在栈顶」的命中判定；该层由状态断言替代覆盖：
//   agent 态 overlay 视图存在于 contentView 子视图栈且 bounds 与浏览器视图一致、
//   user 态摘除。真实鼠标 → overlay 栈顶命中的物理链路留 macOS 主机验收。
//
// notice 断言面：download-blocked 通知当前无 UI 消费方（信任卡只吃 trust-request），
// 经 renderer 侧 window.api.browser.onBrowserNotice 订阅捕获——完整走 main 推送 →
// IPC → preload → renderer 回调的真实链路，比 UI 文案断言更接近契约。
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ELECTRON_APP_DIR = path.join(__dirname, '..', '..', 'electron');

const tmpUserData = path.join(os.tmpdir(), `momo-browser-e2e-${Date.now()}-${process.pid}`);
const tmpWsDir = path.join(os.tmpdir(), `momo-browser-e2e-ws-${Date.now()}-${process.pid}`);

/** fixture 页标题（tabs 栏断言键） */
const FIXTURE_TITLE = 'E2E Browser Fixture';
const BLANK_TITLE = 'E2E Blank Target';

const FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${FIXTURE_TITLE}</title></head>
<body style="margin:0">
  <button id="counter" style="position:absolute;left:20px;top:20px;width:200px;height:60px">计数</button>
  <a id="blank-link" href="/blank.html" target="_blank" style="position:absolute;left:20px;top:100px;width:200px;height:40px">新窗口链接</a>
  <a id="download-link" href="/file.bin" download style="position:absolute;left:20px;top:160px;width:200px;height:40px">下载链接</a>
  <script>
    window.__count = 0;
    document.getElementById('counter').addEventListener('click', function () {
      window.__count += 1;
      document.getElementById('counter').textContent = '计数 ' + window.__count;
    });
  </script>
</body>
</html>`;

const BLANK_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${BLANK_TITLE}</title></head>
<body><p>blank target page</p></body>
</html>`;

/** 三个交互目标的固定命中坐标（fixture 元素绝对定位，见上 HTML） */
const COUNTER_POINT = { x: 120, y: 50 };
const BLANK_LINK_POINT = { x: 120, y: 120 };
const DOWNLOAD_LINK_POINT = { x: 120, y: 180 };

let server: http.Server | null = null;
let baseUrl = '';

test.beforeAll(() => {
  fs.mkdirSync(tmpUserData, { recursive: true });
  fs.mkdirSync(tmpWsDir, { recursive: true });
});

test.afterAll(() => {
  if (server) {
    server.close();
    server = null;
  }
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  fs.rmSync(tmpWsDir, { recursive: true, force: true });
});

/** 起本地静态 server（同进程 http.createServer，端口 0 由内核分配） */
function startFixtureServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/' || url.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      } else if (url === '/blank.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BLANK_HTML);
      } else if (url === '/file.bin') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="file.bin"',
        });
        res.end(Buffer.from('momo-e2e-download'));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// ---------------------------------------------------------------------------
// 主进程侧探针（app.evaluate——真实 BrowserManager 不可从主进程全局触达，断言走
//Electron 对象面：contentView 子视图栈 + webContents 全集）
// ---------------------------------------------------------------------------

/** contentView 子视图清单（url + bounds）——overlay 存在性 / bounds 同步断言面 */
function viewChildren(app: ElectronApplication): Promise<
  Array<{ url: string; x: number; y: number; width: number; height: number }>
> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) throw new Error('主窗口不存在');
    const children = win.contentView.children as unknown as Array<{
      webContents?: { getURL(): string };
      getBounds(): { x: number; y: number; width: number; height: number };
    }>;
    return children.map((c) => ({
      url: c.webContents?.getURL() ?? '',
      ...c.getBounds(),
    }));
  });
}

/** fixture 页精确 URL（startsWith 匹配会误中 /blank.html 收编 tab——工具函数一律精确匹配） */
function fixtureUrl(): string {
  return `${baseUrl}/`;
}

/** 在 fixture 页 webContents 内执行脚本（按精确 URL 从 getAllWebContents 定位） */
function evalInFixturePage<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(({ webContents }, { url, script }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    if (!wc) throw new Error(`未找到 fixture 页 webContents（${url}）`);
    return wc.executeJavaScript(script) as Promise<T>;
  }, { url: fixtureUrl(), script: code });
}

/** 主进程 sendInputEvent 点击 fixture 页指定坐标（容器输入合成方式，见文件头） */
function clickFixtureAt(
  app: ElectronApplication,
  point: { x: number; y: number },
): Promise<void> {
  return app.evaluate(({ webContents }, { url, x, y }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    if (!wc) throw new Error(`未找到 fixture 页 webContents（${url}）`);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }, { url: fixtureUrl(), x: point.x, y: point.y });
}

test('v2.7 浏览器全链路：导航→user 态点击→popup 收编→下载拦截→overlay 接管→resize', async () => {
  test.setTimeout(180000);
  baseUrl = await startFixtureServer();

  const app = await electron.launch({
    // --user-data-dir 隔离 Chromium profile（浏览器 partition 存储/leveldb 所在），
    // 对齐 theme.spec 先例——AP_USER_DATA_DIR 只路由应用级路径（state.db / logs）。
    args: [ELECTRON_APP_DIR, '--no-sandbox', `--user-data-dir=${tmpUserData}`],
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

    // ---- 1. 首启空态 → 创建 workspace → 激活（im 视图带浏览器侧栏） ----
    await win.getByLabel('名称').fill('E2E 浏览器');
    await win.getByPlaceholder('点击右侧按钮选择目录').fill(tmpWsDir);
    await win.getByRole('button', { name: '创建', exact: true }).click();

    const sidebar = win.getByTestId('browser-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 20000 });
    // 侧栏空态：无 tab 时占位区显示引导文案
    await expect(win.getByText('浏览器待命')).toBeVisible();

    // ---- 2. 地址栏导航（第二接管入口：userNavigate 隐式接管） ----
    const addressBar = win.getByLabel('地址栏');
    await addressBar.fill(baseUrl);
    await addressBar.press('Enter');

    // tab 断言收窄到侧栏作用域——TitleBar 的 workspace tab 同为 role=tab（G 陷阱）
    await expect(sidebar.getByRole('tab', { name: FIXTURE_TITLE })).toBeVisible({
      timeout: 20000,
    });
    // userNavigate 隐式接管：user 态徽标可见
    await expect(win.getByText('用户接管中')).toBeVisible();

    // ---- 3. user 态点击计数按钮（overlay 摘除后输入直达页面） ----
    await expect
      .poll(async () => evalInFixturePage<number>(app, 'window.__count'))
      .toBe(0);
    await clickFixtureAt(app, COUNTER_POINT);
    await expect
      .poll(async () => evalInFixturePage<number>(app, 'window.__count'), { timeout: 10000 })
      .toBe(1);

    // ---- 4. target=_blank → 收编新 tab 且无新 OS 窗口（C6） ----
    // OS 窗口计数走主进程 BrowserWindow.getAllWindows——Playwright app.windows() 基于
    // CDP targets，会把 WebContentsView 的 webContents 一并计入（非 OS 窗口语义）
    const osWindowsBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    );
    await clickFixtureAt(app, BLANK_LINK_POINT);
    await expect(sidebar.getByRole('tab', { name: BLANK_TITLE })).toBeVisible({
      timeout: 20000,
    });
    await expect(sidebar.getByRole('tab')).toHaveCount(2);
    const osWindowsAfter = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    );
    expect(osWindowsAfter, 'popup 不产生新 OS 窗口').toBe(osWindowsBefore);

    // 切回 fixture tab（user 态 tabs 放行——G4 调用方甄别）
    await sidebar.getByRole('tab', { name: FIXTURE_TITLE }).click();
    await expect
      .poll(async () => evalInFixturePage<string>(app, 'document.visibilityState'))
      .toBe('visible');

    // ---- 5. 下载链接 → notice 拦截（will-download preventDefault → 推送） ----
    // download-blocked 无 UI 消费方——经 renderer 侧订阅捕获。两段式防竞态：
    // ipcRenderer.on 不回溯，若点击先于订阅注册到达，通知即丢失（实测偶发）——
    // 先 await 订阅安装确认，再点击，最后取页内暂存的 Promise 结果
    await win.evaluate(() => {
      const w = window as unknown as {
        __e2eNotice?: Promise<{ kind: string; text: string }>;
        api: {
          browser: {
            onBrowserNotice: (cb: (n: { kind: string; text: string }) => void) => () => void;
          };
        };
      };
      w.__e2eNotice = new Promise((resolve) => {
        const unsub = w.api.browser.onBrowserNotice((n) => {
          unsub();
          resolve(n);
        });
      });
    });
    await clickFixtureAt(app, DOWNLOAD_LINK_POINT);
    const notice = await win.evaluate(
      () =>
        (window as unknown as { __e2eNotice: Promise<{ kind: string; text: string }> })
          .__e2eNotice,
    );
    expect(notice.kind).toBe('download-blocked');
    expect(notice.text).toContain('下载已拦截');

    // ---- 6. overlay 页内点击接管（DoD 17——状态断言层，见文件头降级说明） ----
    // 释放 → agent 态 → overlay 视图挂栈顶（about:blank 子视图）且 bounds 与浏览器视图一致
    await win.getByRole('button', { name: '释放' }).click();
    await expect(win.getByText('用户接管中')).toBeHidden();

    await expect
      .poll(async () => (await viewChildren(app)).filter((c) => c.url === 'about:blank').length)
      .toBe(1);
    const agentChildren = await viewChildren(app);
    const tabChild = agentChildren.find((c) => c.url === fixtureUrl());
    const overlayChild = agentChildren.find((c) => c.url === 'about:blank');
    expect(tabChild, '浏览器视图在栈中').toBeDefined();
    expect(overlayChild, 'agent 态 overlay 视图在栈中').toBeDefined();
    expect(overlayChild?.width).toBe(tabChild?.width);
    expect(overlayChild?.height).toBe(tabChild?.height);

    // overlay 命中：sendInputEvent 到 overlay 视图 → preload 桥 → userTakeover → overlay 摘除
    await app.evaluate(async ({ BrowserWindow }, { prefix }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('主窗口不存在');
      const children = win.contentView.children as unknown as Array<{
        webContents?: {
          getURL(): string;
          executeJavaScript(code: string): Promise<unknown>;
          sendInputEvent(event: { type: string; x: number; y: number; button: string; clickCount: number }): void;
        };
        getBounds(): { width: number; height: number };
      }>;
      const overlay = children.find((c) => c.webContents?.getURL() === 'about:blank');
      if (!overlay?.webContents) throw new Error('overlay 视图不存在');
      // 等 preload 注入完成（momoOverlay 暴露后命中链路才成立）
      const deadline = Date.now() + 8000;
      for (;;) {
        const kind = await overlay.webContents.executeJavaScript('typeof window.momoOverlay');
        if (kind === 'object') break;
        if (Date.now() > deadline) throw new Error('overlay preload 注入超时');
        await new Promise((r) => setTimeout(r, 100));
      }
      const b = overlay.getBounds();
      overlay.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.floor(b.width / 2),
        y: Math.floor(b.height / 2),
        button: 'left',
        clickCount: 1,
      });
      overlay.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.floor(b.width / 2),
        y: Math.floor(b.height / 2),
        button: 'left',
        clickCount: 1,
      });
      void prefix;
    }, { prefix: baseUrl });

    // 命中 → user 态徽标回归 + overlay 摘除（user 态整视图移出挂载树）
    await expect(win.getByText('用户接管中')).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => (await viewChildren(app)).filter((c) => c.url === 'about:blank').length)
      .toBe(0);

    // ---- 7. 主窗口 resize → 浏览器视图 bounds 同步（占位区上报 → setBounds） ----
    // 侧栏是固定 380px 右列：窗口变宽只影响 chat 列，浏览器视图宽度恒定、随窗口
    // 变化的是高度。故断言面 = 高度同步：先定已知小尺寸（1100×700），再增高 240。
    const initial = await app.evaluate(async ({ BrowserWindow }, { url }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('主窗口不存在');
      if (win.isMaximized()) win.unmaximize();
      const current = win.getContentBounds();
      win.setContentBounds({ x: current.x, y: current.y, width: 1100, height: 700 });
      const deadline = Date.now() + 5000;
      const children = win.contentView.children as unknown as Array<{
        webContents?: { getURL(): string };
        getBounds(): { x: number; y: number; width: number; height: number };
      }>;
      // 占位区重报有延迟——收敛窗 (400,620) 只匹配目标 1100×700 布局（视图高 ≈570）；
      // unmaximize 过渡态 1280×800（视图高 670）与最大化态（~870）均落在窗外防误捕
      for (;;) {
        const tab = children.find((c) => c.webContents?.getURL() === url);
        if (tab && tab.getBounds().height > 400 && tab.getBounds().height < 620) {
          return { tabBounds: tab.getBounds() };
        }
        if (Date.now() > deadline) throw new Error('浏览器视图 bounds 未随窗口收敛');
        await new Promise((r) => setTimeout(r, 150));
      }
    }, { url: fixtureUrl() });

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('主窗口不存在');
      const b = win.getContentBounds();
      win.setContentBounds({ x: b.x, y: b.y, width: b.width, height: b.height + 240 });
    });

    // 占位区 ResizeObserver → 上报 → main setBounds（轮询视图高度位移）
    await expect
      .poll(
        async () => {
          const now = (await viewChildren(app)).find((c) => c.url === fixtureUrl());
          return now ? now.height - initial.tabBounds.height : -1;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThanOrEqual(140);
    const resized = (await viewChildren(app)).find((c) => c.url === fixtureUrl());
    expect(Math.abs(resized!.x - initial.tabBounds.x), '增高时 x 不位移').toBeLessThanOrEqual(2);
    expect(Math.abs(resized!.width - initial.tabBounds.width), '增高时宽度不变').toBeLessThanOrEqual(4);
  } finally {
    await app.close();
  }
});
