// electron/src/main/ipc/index.ts
import { BrowserWindow } from 'electron';
import { logger } from '../logger';
import { registerSystemHandlers } from './system.handlers';
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';
import { registerFileHandlers } from '../files/ipc.handlers';
// FileIo 主进程单例 boot（spec 2026-11-11 §5.8）：默认内容通道同步 + will-quit 回收
import { initFileIo } from '../files/file-io';
// fileIo:* IPC（spec 2026-11-11 §5.6 设置面板数据面）：getState / probe 两通道
import { registerFileIoHandlers } from '../files/file-io/ipc.handlers';
import { registerAssetHandlers } from '../files/asset-ipc';
import { registerAssetReadHandlers } from '../files/asset-read-ipc';
import { registerAgentHandlers } from '../agent/ipc.handlers';
import { registerStreamIpc } from '../agent/stream-relay';
// 三级中断四通道（spec 2026-10-13 §7.2）：RouterService 级联 + registry 在途查询
import { registerInterruptIpc } from '../agent/interrupt-ipc';
import { getRouterService } from '../agent/router-bootstrap';
// P2-D Task D1：listInFlight 数据面（registry 在途链 → 视图 + 子 agent 名解析）
import { listInFlightViews } from '../agent/inflight-view';
import { registerSessionIpcHandlers } from '../im/session.ipc.handlers';
// 会话分组/置顶七通道（spec 2026-10-22 §7）：sessionGroup CRUD +
// session:setPinned / session:moveToGroup（后者与分组校验同址）
import { registerSessionGroupIpcHandlers } from '../im/session-group.ipc.handlers';
import { registerMcpHandlers } from '../mcp/ipc.handlers';
import { registerAllocationHandlers } from '../workspace/ipc.handlers';
import { registerGitPolicyHandlers } from '../workspace/git-policy';
import { registerAuditHandlers } from '../audit/ipc.handlers';
import { registerProviderHandlers } from '../agent/provider-ipc';
// OAuth 模块（spec 2026-11-10）：连接管理九通道 + 授权/列表两推送
import { registerOAuthHandlers } from '../oauth/ipc.handlers';
import { registerSettingsIpc } from '../settings/ipc.handlers';
import { registerSandboxIpc } from '../sandbox/ipc.handlers';
import { registerMemoryIpc } from '../memory/ipc.handlers';
import { registerJournalIpc } from '../journal/ipc.handlers';
import { registerResourceHandlers } from '../resource/ipc.handlers';
// 会话内能力管理——扩权确认通道（spec §7）：agent-op-confirm:reply 裁决回传
import { registerAgentOpConfirmHandlers } from '../agent/agent-op-confirm';
import { registerPluginHandlers } from '../plugin/ipc.handlers';
import { registerTaskHandlers } from '../task/ipc.handlers';
// 任务生命周期 v2（Task 16）：human 命名空间 + 推送 sink + sweeper 定时器装配
import { registerHumanIpc } from '../task/human.ipc.handlers';
import { registerTaskGroupHandlers } from '../task/groups.ipc.handlers';
import { registerDialogHandlers } from './dialog.handlers';
import { registerWindowIpc } from '../window-ipc';
// M0 节点互联（spec 2026-10-23）：hub 连接管理四通道 + 两推送
import { registerHubIpc } from '../hub/ipc.handlers';
// P2 S6 跨节点路由端口装配：hub 请求面注入 task 域（镜像代答 / 远端验收通知）
// ——hub/index 与 task/ipc.handlers 双向零 import（setMirrorAnswerForwarder 等
// setter 注入，setSessionRouter / setRemoteInterveneSink 同款纪律）
import { hubRequest } from '../hub/index';
import { TASK_RPC } from '../hub/protocol';
import type { InterventionAnswer } from '../hub/protocol';
import { setMirrorAnswerForwarder } from '../task/human.ipc.handlers';
import { setRemoteTerminalForwarder } from '../task/ipc.handlers';
// 新装引导（spec 2026-10-10）：status / 方案生成 / 方案应用 / 完成标记
import { registerOnboardingHandlers } from '../onboarding/ipc.handlers';
import type { WorkspaceIpcOpts } from '../workspace/ipc.handlers';

/**
 * 注册全部 IPC handlers（app ready 后调用一次）。
 * opts 目前仅透传 workspace:* 的跨子系统回调（v2.7 T10 workspace:switch → 浏览器子系统）。
 */
export function registerIpcHandlers(opts: WorkspaceIpcOpts = {}): void {
  logger.info('Registering IPC handlers');
  registerSystemHandlers();
  registerWorkspaceHandlers(opts);
  registerFileHandlers();
  initFileIo();
  registerFileIoHandlers();
  // 2026-09-26 多模态：asset:saveImage（粘贴/拖入降采样图片内容寻址落盘，spec §5）
  registerAssetHandlers();
  // 2026-09-26 多模态：asset:readDataUrl（气泡缩略图读图，spec §10；与 saveImage 同址接线）
  registerAssetReadHandlers();
  registerAgentHandlers();
  registerStreamIpc();
// 三级中断四通道（spec 2026-10-13 §7.2）：注册先于 RouterService lazy 启动
//（main/index.ts 中 initTaskDrivenRuntime 在 registerIpcHandlers 之后），故
// abortTurn/stopAll/cancelChain 于 invoke 时刻经 getRouterService 解析单例——
// 未启动 = 无在途流/链，幂等空结果（与 abortStreamBySessionId 未注入 resolver
// 返回 false 同语义）。listInFlight 走 inflight-view 真实现（P2-D Task D1）：
// registry 在途链 + 主进程解析子 agent 展示名（成员已删/DB 异常降级 null）。
  registerInterruptIpc({
    abortTurn: (sessionId) =>
      getRouterService()?.abortTurn(sessionId) ?? { stoppedStream: false },
    stopAll: (sessionId) =>
      getRouterService()?.stopAll(sessionId) ?? { stoppedStreams: 0, cancelledChains: 0 },
    cancelChain: (arg) => getRouterService()?.cancelChain(arg) ?? { status: 'not_found' },
    listInFlight: listInFlightViews,
  });
  registerSessionIpcHandlers();
  // 会话分组/置顶七通道（spec 2026-10-22 §7）
  registerSessionGroupIpcHandlers();
  registerMcpHandlers();
  registerAllocationHandlers();
  registerGitPolicyHandlers();
  registerAuditHandlers();
  registerProviderHandlers();
  registerOAuthHandlers();
  registerSettingsIpc();
  registerSandboxIpc();
  registerMemoryIpc();
  // v2.5：变更账本通道（journal/ipc.handlers.ts）——list / revert / scan / 组合回滚
  registerJournalIpc();
  registerResourceHandlers();
  // 扩权确认通道（spec §7）：reply 裁决回传单一通道
  registerAgentOpConfirmHandlers();
  // 插件系统 P1（spec 2026-10-15）：installZip / installDevDir / setEnabled / uninstall
  registerPluginHandlers();
  registerTaskHandlers();
  // 任务生命周期 v2（Task 16）：human:list/answer/attention + human:changed /
  // task:runChanged 推送 + boot 孤儿回收 + 60s 超时 sweeper（内部幂等）
  registerHumanIpc();
  // 看板重构 Task 7：taskGroup 命名空间（组 CRUD + 归档级联 + abort 补偿）
  registerTaskGroupHandlers();
  registerDialogHandlers();
  // 新装引导（spec 2026-10-10）
  registerOnboardingHandlers();
  // M0 节点互联（spec 2026-10-23）：hub 连接管理四通道 + 两推送
  registerHubIpc();
  // P2 S6：跨节点代答 / 远端验收通知转发器接线（hubRequest 错误语义单点——
  // 未连接人话 / hub 原文 / 超时）。task.answer 顶层 decision 为协议旧兼容
  // 必填（interventionId 在场时 hub 只消费 answer 段）；HumanAnswerInput 的
  // accept/reject 决策与 reason 字段按协议 InterventionAnswer 收敛映射。
  setMirrorAnswerForwarder(async ({ delegationId, remoteId, answer }) => {
    const decision =
      answer.decision === 'deny' || answer.decision === 'reject'
        ? 'deny'
        : answer.decision !== undefined
          ? 'approve'
          : undefined;
    const text =
      answer.reason !== undefined && answer.reason !== ''
        ? [answer.text, answer.reason].filter((s) => s !== undefined && s !== '').join('\n')
        : answer.text;
    const interventionAnswer: InterventionAnswer = {
      ...(decision !== undefined ? { decision } : {}),
      ...(text !== undefined && text !== '' ? { text } : {}),
      ...(answer.selected !== undefined ? { selected: answer.selected } : {}),
      ...(answer.completed !== undefined ? { completed: answer.completed } : {}),
    };
    return (
      await hubRequest<{ disposition: 'granted' | 'denied' | 'stale' | 'answered' }>(
        TASK_RPC.answer,
        {
          taskId: delegationId,
          decision: decision ?? 'approve',
          interventionId: remoteId,
          answer: interventionAnswer,
        },
        undefined,
      )
    ).disposition;
  });
  setRemoteTerminalForwarder(async ({ delegationId, outcome, reason }) => {
    await hubRequest(
      outcome === 'accepted' ? TASK_RPC.accept : TASK_RPC.reject,
      outcome === 'accepted' ? { taskId: delegationId } : { taskId: delegationId, reason },
      undefined,
    );
  });
  // 窗口控制（自绘 titlebar）——注册先于窗口创建，getWin 每次调用时懒查首个窗口
  registerWindowIpc(() => BrowserWindow.getAllWindows()[0] ?? null);
}
