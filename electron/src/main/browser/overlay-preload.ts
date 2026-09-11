// electron/src/main/browser/overlay-preload.ts
//
// 浏览器 overlay 视图专用 preload（v2.7 DoD 17 页内点击接管）。
//
// overlay 是叠在浏览器视图之上的全透明 WebContentsView（agent 态挂载）：页面内
// 任意 mousedown 经本 preload 桥回主进程 → manager.userTakeover。沙箱环境下
// preload 仅可用 contextBridge / ipcRenderer 子集——本文件只用这两个。
//
// 经 tsc 主流水线编译到 dist/main/browser/overlay-preload.js（view-factory 以
// __dirname 同目录解析）。页面侧消费者：view-factory 注入的
// `window.addEventListener('mousedown', () => window.momoOverlay?.hit())`。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('momoOverlay', {
  /** 页内点击命中（fire-and-forget；主进程 webContents.ipc.on('momo-overlay-hit') 消费） */
  hit: () => ipcRenderer.send('momo-overlay-hit'),
});
