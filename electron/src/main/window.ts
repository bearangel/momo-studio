// electron/src/main/window.ts
import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { logger } from './logger';
import { loadWindowState, saveWindowState, clampToDisplays } from './window-state';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // e.g. http://localhost:5173

export function createMainWindow(): BrowserWindow {
  // P2 Task 1：恢复上次窗口状态（bounds + maximized）。
  // 越界剔除——外接屏拔掉后残留坐标落在所有现存屏幕外时丢弃 x/y（保留尺寸）。
  const loaded = loadWindowState();
  const state = loaded
    ? clampToDisplays(
        loaded,
        screen.getAllDisplays().map((d) => d.workArea),
      )
    : null;

  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: state?.width ?? 1280,
    height: state?.height ?? 800,
    x: state?.x ?? undefined,
    y: state?.y ?? undefined,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    title: 'Momo Studio',
    // spec §6.1：mac 原生红绿灯（隐藏标题栏保留控件）；win/linux 全无边框自绘 titlebar
    ...(isMac ? { titleBarStyle: 'hidden' as const } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // 首启（无持久化状态）→ 最大化；有状态 → 恢复上次的 maximized
  if (!state) win.maximize();
  else if (state.maximized) win.maximize();

  // 状态持久化：close 时保存当前 bounds。getNormalBounds 在最大化期间返回
  // 「还原后的」窗口坐标，避免把全屏尺寸写进状态导致下次启动窗口撑满。
  win.on('close', () => {
    const bounds = win.getNormalBounds();
    saveWindowState({ ...bounds, maximized: win.isMaximized() });
  });

  // maximized 推送（自绘 titlebar 最大化按钮图标切换用，window-ipc/preload 消费）
  const sendMax = (): void => {
    win.webContents.send('window:maximized-changed', win.isMaximized());
  };
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);

  win.once('ready-to-show', () => {
    win.show();
    logger.info('Window ready');
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Packaged: electron-builder copies the renderer build into resources/renderer/.
    // Dev (built, not packaged): the renderer lives at <repo>/renderer/dist/.
    // __dirname here is electron/dist/main/, so three `..` reaches the repo root.
    const rendererPath = app.isPackaged
      ? path.join(process.resourcesPath, 'renderer', 'index.html')
      : path.join(__dirname, '..', '..', '..', 'renderer', 'dist', 'index.html');
    void win.loadFile(rendererPath);
  }

  return win;
}
