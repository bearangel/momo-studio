// electron/src/main/skill/ipc.handlers.ts
//
// Skill 相关 IPC handler 注册入口。把 zip-uploader 的能力包装成 `skill:*` 通道，
// 暴露给渲染进程（UI 管理 skill 用）。
//
// 暴露通道：
//   - skill:listInstalled  列出所有已安装 skill（builtin + marketplace + custom 三类）
//   - skill:uploadZip      上传自定义 skill zip（解压到 <userData>/skills/<slug>/）
//   - skill:deleteCustom   删除自定义上传的 skill（builtin/marketplace 抛错）

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { uploadSkillZip, listInstalled, deleteCustomSkill } from './zip-uploader';

/** 注册全部 skill: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerSkillHandlers(): void {
  // 列出所有已安装 skill（含 source 区分），UI 据此区分展示与卸载/删除逻辑。
  ipcMain.handle('skill:listInstalled', async () => {
    return listInstalled();
  });

  // 上传自定义 skill zip。buffer 由 renderer 从 File.arrayBuffer() 转来。
  ipcMain.handle(
    'skill:uploadZip',
    async (_evt, buffer: Buffer, filename: string) => {
      return uploadSkillZip(buffer, filename);
    },
  );

  // 删除自定义上传的 skill。builtin/marketplace 抛错（提示走卸载按钮）。
  ipcMain.handle('skill:deleteCustom', async (_evt, slug: string) => {
    deleteCustomSkill(slug);
    return;
  });

  logger.info('Skill IPC handlers 已注册');
}
