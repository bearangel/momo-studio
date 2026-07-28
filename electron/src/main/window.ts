// electron/src/main/window.ts
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { logger } from './logger';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // e.g. http://localhost:5173

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    title: 'AgentPlatform',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    logger.info('Window ready');
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html'));
  }

  return win;
}
