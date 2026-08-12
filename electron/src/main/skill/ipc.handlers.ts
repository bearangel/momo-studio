// electron/src/main/skill/ipc.handlers.ts
//
// Skill 相关 IPC handler 注册入口。把 zip-uploader 的能力包装成 `skill:*` 通道，
// 暴露给渲染进程（UI 管理 skill 用）。
//
// 暴露通道：
//   - skill:uploadZip      上传自定义 skill zip（解压到 <userData>/skills/<slug>/）
//
// v1.7：skill:listInstalled / skill:deleteCustom 已废弃删除，统一走 resource:list /
// resource:delete。底层函数 listInstalled / deleteCustomSkill 保留（resource/ 内部复用）。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { uploadSkillZip } from './zip-uploader';

/** 注册全部 skill: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerSkillHandlers(): void {
  // 上传自定义 skill zip。
  // v1.6.3: renderer 经 preload 用 Uint8Array 传输（preload 不用 Buffer.from——
  // contextBridge 里 Node Buffer 跨 IPC structured clone 会损坏）；main 收到后转回 Buffer。
  ipcMain.handle(
    'skill:uploadZip',
    async (_evt, data: Uint8Array | Buffer, filename: string) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return uploadSkillZip(buffer, filename);
    },
  );

  logger.info('Skill IPC handlers 已注册');
}
