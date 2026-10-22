// electron/src/main/im/session-group.ipc.handlers.ts
//
// 会话分组与置顶的 IPC 面（spec 2026-10-22 §7 + 预览 A rev2 组色）：七通道同址注册——
//   sessionGroup:list / create / rename / delete / setColor  分组 CRUD + 组色
//   session:setPinned / session:moveToGroup                   会话行写面（通道名属
//                                                             session 命名空间，但与
//                                                             分组校验耦合，同址注册避免拆两文件）
//
// 边界分工：repo 层（storage/sessions/repo.ts）只做纯写入，不做跨工作空间
// 校验；会话不存在与「组是否属于该会话所在工作空间」两条业务约束收在 handler
// ——renderer 拿到的是中文错误（Electron IPC 只保 message），错误语义不依赖
// 调用方自觉。置顶/分组语义单点在 repo（spec §4.1）。
import { ipcMain } from 'electron';
import {
  getSession,
  listSessionGroups,
  insertSessionGroup,
  renameSessionGroup,
  deleteSessionGroup,
  setSessionPinned,
  setSessionGroup,
  setSessionGroupColor,
} from '../storage/sessions/repo';

/**
 * 分组名守卫：去首尾空白后不得为空（spec §7「空名报错」）。
 * 建组/改名共用——两条通道的空名语义必须一致，避免「建组拒、改名放」。
 */
function assertNonEmptyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('分组名不能为空');
  return trimmed;
}

/** 注册会话分组 / 置顶七通道（含 setColor）。app ready 后由 ipc/index.ts 的 registerIpcHandlers 统一调用。 */
export function registerSessionGroupIpcHandlers(): void {
  // 分组列表：position ASC, created_at ASC（会话列表分组区渲染顺序的单一真相源）
  ipcMain.handle('sessionGroup:list', async (_evt, workspaceId: string) => {
    return listSessionGroups(workspaceId);
  });

  // 建组：position 步进 max+1024（repo 内契约，与 task_groups 同策略）
  ipcMain.handle('sessionGroup:create', async (_evt, workspaceId: string, name: string) => {
    return insertSessionGroup(workspaceId, assertNonEmptyName(name));
  });

  // 改名（组不存在时静默 no-op——repo 单 UPDATE，UI 以 list 刷新为准）
  ipcMain.handle('sessionGroup:rename', async (_evt, groupId: string, name: string) => {
    renameSessionGroup(groupId, assertNonEmptyName(name));
  });

  // 删组：单事务内组内会话回落未分组后删组行（置顶位独立保留，spec §4.1）
  ipcMain.handle('sessionGroup:delete', async (_evt, groupId: string) => {
    deleteSessionGroup(groupId);
  });

  // 组色直写（预览 A rev2）：#RRGGBB 严格校验，非法值中文报错
  ipcMain.handle('sessionGroup:setColor', async (_evt, groupId: string, color: string) => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error('颜色值格式不正确');
    setSessionGroupColor(groupId, color);
  });

  // 置顶切换：true=写时间戳（重置顶上浮置顶区）/ false=NULL。与分组互不影响。
  ipcMain.handle('session:setPinned', async (_evt, sessionId: string, pinned: boolean) => {
    setSessionPinned(sessionId, pinned);
  });

  // 归组/移出分组。groupId=null 是合法的「移出分组」路径，跳过校验；
  // 非 null 时必须校验组属该会话所在工作空间（spec §7）——否则跨工作空间
  // 拖拽会把会话挂到看不见的组上，列表分组区永远不显示该会话。
  ipcMain.handle(
    'session:moveToGroup',
    async (_evt, sessionId: string, groupId: string | null) => {
      if (groupId !== null) {
        const session = getSession(sessionId);
        if (!session) throw new Error(`会话不存在: ${sessionId}`);
        const group = listSessionGroups(session.workspaceId).find((g) => g.id === groupId);
        if (!group) throw new Error('分组不存在或不属于当前会话所在工作空间');
      }
      setSessionGroup(sessionId, groupId);
    },
  );
}
