// renderer/src/lib/platform.ts
//
// 平台检测 + Electron 拖拽区样式（P2 Task 2）。
// process.platform 由 preload 以同步常量暴露（api.system.getPlatform），
// 渲染进程首帧即可判定平台，避免异步 invoke 导致窗口控件闪变。
import type { CSSProperties } from 'react';
import { ipc } from '../ipc/client';

/** 是否 macOS——决定 titlebar 是否自绘窗口控件（mac 用原生红绿灯） */
export function isMac(): boolean {
  return ipc.system.getPlatform() === 'darwin';
}

// -webkit-app-region 是 Electron 扩展属性，不在标准 CSSProperties 类型内。
// 这里是全仓库 app-region 样式的唯一出口，用一次受控断言集中隔离
// （TS strict 禁 any 约定内的唯一豁免点，勿在别处复制此断言）。
export const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
export const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;
