// electron/src/preload/index.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ApiSurface,
  AssignmentDeltas,
  ApplyOnboardingPlanInput,
  BrowserNotice,
  BrowserState,
  BundlePreview,
  BuiltinPresetItem,
  BuiltinPresetPreview,
  CollabTarget,
  DanglingMcpRef,
  GenerateOnboardingPlanInput,
  GenerateOnboardingPlanResult,
  GitImportResult,
  GroupRow,
  ImMessage,
  MarkOnboardingDoneInput,
  McpConfigUpdateInput,
  McpConfigView,
  McpEditView,
  McpEntryUpdateInput,
  MessageContext,
  MessageEventBatch,
  OnboardingApplyResult,
  OnboardingStatus,
  RegisterMcpInput,
  RegistryListEntry,
  RegistryProviderMeta,
  ResourceFilter,
  ResourceItem,
  ResourceType,
  ScannedSkill,
  SessionGroupRow,
  SkillCreateInput,
  SmitheryInstallResult,
  HubInstallResult,
  HubCatalogOwnership,
  HubCoexistIssue,
  PluginDupIssue,
  PluginDupTarget,
  PluginDupCleanupResult,
  TaskRow,
  TaskCreateBatchResult,
  UploadedSkill,
  PluginSummary,
  PluginDetail,
  PluginPanelInfo,
  PluginToolInfo,
  PluginConfigView,
  HubStateChangedEvent,
  HubNodePresenceEvent,
  HubPublishResourceInput,
  HubPublishResult,
  HubResourcePublishedEvent,
  HubResourceUnpublishedEvent,
  HubGroupChangedEvent,
  HubGroupListResult,
  HubGroupCreateResult,
  HubGroupInviteResult,
  HubGroupJoinResult,
  HubGroupLeaveResult,
  HubGroupTransferResult,
  HubMirrorWorkspaceInput,
  HubMirrorAcceptResult,
  HubMirrorResultEvent,
  HubInstallProgressEvent,
  HubMirrorRegistryRow,
  SubmitRoutedTaskInput,
  SubmitRoutedTaskResult,
  RoutingPrecheckResult,
  HubSnapshotBuildUploadResult,
  HubWorkspaceMirroredEvent,
  HubDelegationSettings,
  HubWorkspaceDirView,
  HubTaskListResult,
  HubTaskDelegateInput,
  HubTaskDelegateResult,
  HubTaskProgressEvent,
  HubTaskAnsweredEvent,
  HubTaskAnswerInput,
  HubTaskAnswerResult,
  HubTaskTerminalEvent,
  HubViewSettings,
  HubViewOverview,
  HubViewSessionSummary,
  HubViewMessagePage,
  HubViewLocalTask,
  HubViewAppendedEvent,
  HubViewWorkspaceSummary,
  HubViewFilesResult,
  DelegationBoardResult,
  HubLocalWaitingEntry,
  RetryDispatchResult,
} from '../../../renderer/src/ipc/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * hub 补装进度通道名（M2.3 T5 件5）——与主进程 resource/hub-install.ts 的
 * HUB_INSTALL_PROGRESS_CHANNEL 同值单点对齐。sandbox preload 不可运行时导入主进程
 * 模块（window.ts sandbox: true），故此处本地常量承载值；跨进程值一致由
 * tests/ipc/preload-hub-channel-contract.test.ts 契约锁（两侧导入机械比对），
 * 改通道名须两端同 commit（与主进程常量 JSDoc 约定一致）。
 */
const HUB_INSTALL_PROGRESS_CHANNEL = 'hub:installProgress';

const api: ApiSurface = {
  system: {
    getInfo: () => invoke('system:getInfo'),
    // P2 Task 2：同步注入 process.platform 常量（titlebar 平台分支用，避免异步首帧闪变）
    getPlatform: () => process.platform,
    // P5 Task 2：v1.x → 2.0 旧库升级首启提示（一次性 kv 标记）
    getUpgradeNotice: () =>
      invoke<{ exportDir: string } | null>('system:getUpgradeNotice'),
    dismissUpgradeNotice: () => invoke<void>('system:dismissUpgradeNotice'),
  },
  workspace: {
    create: (input) => invoke('workspace:create', input),
    list: () => invoke('workspace:list'),
    get: (id) => invoke('workspace:get', id),
    delete: (id) => invoke('workspace:delete', id),
    // P2 Task 2：重命名 / 在系统文件管理器打开目录
    rename: (id, name) => invoke('workspace:rename', id, name),
    openDirectory: (id) => invoke('workspace:openDirectory', id),
    // v25 Task 6（spec §5）：默认 agent 设置通道（原协调 agent 通道更名）
    setDefaultAgent: (id, instanceId) => invoke('workspace:setDefaultAgent', id, instanceId),
    // v2.7 T10：切换激活 workspace 通知（main 侧收口浏览器子系统 workspace 钩子）
    switch: (id) => invoke('workspace:switch', id),
    // M2.1 D3：主进程侧工作空间变更（镜像应用等）→ renderer 重拉列表
    onListChanged: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: { reason: string; workspaceName?: string }): void => callback(payload);
      ipcRenderer.on('workspace:listChanged', handler);
      return () => { ipcRenderer.off('workspace:listChanged', handler); };
    },
  },
  file: {
    read: (wsId, path) => invoke('file:read', wsId, path),
    write: (wsId, path, content) => invoke('file:write', wsId, path, content),
    list: (wsId, dir) => invoke('file:list', wsId, dir),
    create: (wsId, filePath, type) => invoke('file:create', wsId, filePath, type),
    delete: (wsId, filePath) => invoke('file:delete', wsId, filePath),
    rename: (wsId, srcPath, dstPath) => invoke('file:rename', wsId, srcPath, dstPath),
    searchNames: (wsId, query) => invoke('file:searchNames', wsId, query),
    // 文件区功能优化（2026-10-11）：四个 shell/路径通道——通道名与主进程
    // files/ipc.handlers.ts 逐一对应
    absolutePath: (wsId, path) => invoke('file:absolutePath', wsId, path),
    revealInFolder: (wsId, path) => invoke('file:revealInFolder', wsId, path),
    openWithDefaultApp: (wsId, path) => invoke('file:openWithDefaultApp', wsId, path),
    readForEditor: (wsId, path) => invoke('file:readForEditor', wsId, path),
  },
  // 2026-09-26 多模态（spec §5）：粘贴/拖入降采样图片内容寻址落盘，路径返回相对路径
  asset: {
    // Uint8Array 跨 contextBridge 走 structured clone 安全，IPC handler 自转 Buffer
    saveImage: (workspaceId: string, data: Uint8Array, ext: 'png' | 'jpg') =>
      invoke<{ path: string }>('asset:saveImage', workspaceId, data, ext),
    // 2026-09-26 多模态（spec §10）：气泡缩略图读图——`.momo/assets/` 白名单路径 → data URL
    readDataUrl: (workspaceId: string, path: string) =>
      invoke<string>('asset:readDataUrl', workspaceId, path),
  },
  // v25 Task 6（spec §5）：assignment 系列通道平移更名 member；角色指派/
  // 改角色通道随 role 概念退役删除（preload 悬空绑定一并清理）。
  agent: {
    addMember: (input) => invoke('agent:addMember', input),
    createFromYaml: (yaml) => invoke('agent:createFromYaml', yaml),
    createCustom: (input) => invoke('agent:createCustom', input),
    list: (workspaceId?: string) => invoke('agent:list', workspaceId),
    assign: (workspaceId, defId, agentUserId) =>
      invoke('agent:assign', workspaceId, defId, agentUserId),
    listMembers: (workspaceId) => invoke('agent:listMembers', workspaceId),
    start: (opts) => invoke('agent:start', opts),
    stop: (instanceId) => invoke('agent:stop', instanceId),
    removeMember: (instanceId) => invoke('agent:removeMember', instanceId),
    isRunning: (instanceId) => invoke('agent:isRunning', instanceId),
    updateDefinition: (input) => invoke('agent:updateDefinition', input),
    enablePreset: (input) => invoke('agent:enablePreset', input),
    setMemberApiKeyOverride: (instanceId: string, apiKey: string | null) =>
      invoke('agent:setMemberApiKeyOverride', instanceId, apiKey),
    deleteDefinition: (defId: string) => invoke('agent:deleteDefinition', defId),
    definitionImpact: (defId: string) => invoke('agent:definitionImpact', defId),
    disablePreset: (defId: string) => invoke('agent:disablePreset', defId),
    getBuiltinSuggestions: () => invoke('agent:getBuiltinSuggestions'),
    getMemberDeltas: (instanceId: string) => invoke('agent:getMemberDeltas', instanceId),
    setMemberDeltas: (instanceId: string, deltas: AssignmentDeltas) =>
      invoke('agent:setMemberDeltas', instanceId, deltas),
    // spec 2026-10-22 §6.1：批量生效能力（与 spawn 同源合并）；未知 id 主进程侧省略
    getEffectiveCapabilities: (instanceIds: string[]) =>
      invoke('agent:getEffectiveCapabilities', instanceIds),
    onRuntimeChanged: (callback) => {
      const handler = (): void => callback();
      ipcRenderer.on('agent:runtimeChanged', handler);
      return () => {
        ipcRenderer.off('agent:runtimeChanged', handler);
      };
    },
    abortStream: (streamSessionId: string) => invoke('agent:abortStream', streamSessionId),
    // 三级中断·回合级（spec 2026-10-13 §7.3）：载荷 { sessionId }——级联含本回合派生子链
    abortTurn: (sessionId: string) => invoke('agent:abortTurn', { sessionId }),
  },
  // v25 Task 6：团队通道面（spec §4.2）
  team: {
    list: (workspaceId) => invoke('team:list', workspaceId),
    create: (workspaceId, input) => invoke('team:create', workspaceId, input),
    rename: (teamId, name, iconEmoji?) => invoke('team:rename', teamId, name, iconEmoji),
    delete: (teamId) => invoke('team:delete', teamId),
    setLeader: (teamId, leaderInstanceId) => invoke('team:setLeader', teamId, leaderInstanceId),
    addMember: (teamId, instanceId) => invoke('team:addMember', teamId, instanceId),
    removeMember: (teamId, instanceId) => invoke('team:removeMember', teamId, instanceId),
  },
  // v2.x：工具目录（注册中心自描述，单一真相源）——renderer 创建/编辑 agent 据此渲染
  tools: {
    getCatalog: () => invoke('tools:getCatalog'),
  },
  provider: {
    list: () => invoke('provider:list'),
    get: (id) => invoke('provider:get', id),
    create: (input) => invoke('provider:create', input),
    update: (input) => invoke('provider:update', input),
    delete: (id) => invoke('provider:delete', id),
    setDefault: (id) => invoke('provider:setDefault', id),
    testConnection: (input) => invoke('provider:testConnection', input),
    getApiKey: (id) => invoke('provider:getApiKey', id),
    // Task 6：供应商模型列表管理
    fetchModels: (id) => invoke('provider:fetchModels', id),
    listModels: (id) => invoke('provider:listModels', id),
    addModel: (id, modelId) => invoke('provider:addModel', id, modelId),
    setModelEnabled: (id, modelId, enabled) => invoke('provider:setModelEnabled', id, modelId, enabled),
    setModelWindow: (id, modelId, contextWindow) => invoke('provider:setModelWindow', id, modelId, contextWindow),
    removeModel: (id, modelId) => invoke('provider:removeModel', id, modelId),
    listPresets: () => invoke('provider:listPresets'),
    setModelThinking: (id, modelId, config) => invoke('provider:setModelThinking', id, modelId, config),
    setModelVision: (id, modelId, vision) => invoke('provider:setModelVision', id, modelId, vision),
  },
  // v2.4：OS 沙箱通道（sandbox/ipc.handlers.ts）——状态/重探测/装 bwrap/关提示卡
  //（2026-10-03：grantToolchain 退役；grantWrite/revokeWrite + writeBlocked 推送上线）
  sandbox: {
    getState: () => invoke('sandbox:getState'),
    reprobe: () => invoke('sandbox:reprobe'),
    installBwrap: () => invoke('sandbox:installBwrap'),
    dismissPrompt: (kind) => invoke('sandbox:dismissPrompt', kind),
    grantWrite: (arg: { scope: 'session' | 'workspace'; key: string; dirs: string[] }) =>
      invoke('sandbox:grantWrite', arg),
    denyWrite: (arg: { sessionId: string | null; dirs: string[] }) =>
      invoke('sandbox:denyWrite', arg),
    listWriteGrants: () => invoke('sandbox:listWriteGrants'),
    revokeWrite: (arg: { scope: 'session' | 'workspace'; key: string; dir: string }) =>
      invoke('sandbox:revokeWrite', arg),
    onWriteBlocked: (callback: (e: { sessionId: string | null; workspaceId: string | null; dirs: string[]; command: string; streamSessionId: string | null; sourceAgentName: string | null; sessionTitle: string | null }) => void) => {
      type WriteBlockedPayload = Parameters<typeof callback>[0];
      const handler = (_e: IpcRendererEvent, payload: WriteBlockedPayload): void => callback(payload);
      ipcRenderer.on('sandbox:writeBlocked', handler);
      return () => {
        ipcRenderer.off('sandbox:writeBlocked', handler);
      };
    },
  },
  // v2.5：变更账本通道（journal/ipc.handlers.ts）——列表/撤销/组合回滚/干跑预检
  journal: {
    list: (scope) => invoke('journal:list', scope),
    revert: (workspaceId, ids, opts) => invoke('journal:revert', workspaceId, ids, opts),
    rollbackFileBefore: (workspaceId, filePath, beforeEntryId) =>
      invoke('journal:rollbackFileBefore', workspaceId, filePath, beforeEntryId),
    preview: (workspaceId, ids) => invoke('journal:preview', workspaceId, ids),
  },
  // v2.7：浏览器通道（browser/ipc.ts——通道名与主进程 16 invoke 通道 + 两推送逐一对应）
  browser: {
    getState: (workspaceId) => invoke('browser:getState', workspaceId),
    userNavigate: (workspaceId, url) => invoke('browser:userNavigate', workspaceId, url),
    takeover: (workspaceId) => invoke('browser:takeover', workspaceId),
    releaseTakeover: (workspaceId) => invoke('browser:releaseTakeover', workspaceId),
    openTab: (workspaceId, url) => invoke('browser:openTab', workspaceId, url),
    closeTab: (workspaceId, index) => invoke('browser:closeTab', workspaceId, index),
    switchTab: (workspaceId, index) => invoke('browser:switchTab', workspaceId, index),
    setSidebarBounds: (rect) => invoke('browser:setSidebarBounds', rect),
    // 归属制三通道（spec 2026-09-15）：收起=纯隐藏 / 活跃会话上报 / user 源全局关闭
    setSidebarVisible: (workspaceId, visible) =>
      invoke('browser:setSidebarVisible', workspaceId, visible),
    setActiveSession: (sessionId) => invoke('browser:setActiveSession', sessionId),
    closeBrowser: (workspaceId) => invoke('browser:closeBrowser', workspaceId),
    answerTrust: (workspaceId, answer) => invoke('browser:answerTrust', workspaceId, answer),
    listDevServers: () => invoke('browser:listDevServers'),
    updateSettings: (workspaceId, patch) => invoke('browser:updateSettings', workspaceId, patch),
    getSettings: (workspaceId) => invoke('browser:getSettings', workspaceId),
    clearBrowsingData: (workspaceId) => invoke('browser:clearBrowsingData', workspaceId),
    onBrowserState: (callback) => {
      const handler = (_e: IpcRendererEvent, state: BrowserState): void => callback(state);
      ipcRenderer.on('browser:state', handler);
      return () => {
        ipcRenderer.off('browser:state', handler);
      };
    },
    onBrowserNotice: (callback) => {
      const handler = (_e: IpcRendererEvent, notice: BrowserNotice): void => callback(notice);
      ipcRenderer.on('browser:notice', handler);
      return () => {
        ipcRenderer.off('browser:notice', handler);
      };
    },
  },
  // v2.0 P1 Task 12：im 命名空间收缩——全部 im:* invoke 通道已随 Matrix 全家删除，
  // 仅保留 im:conflict 推送订阅（发送方 session-service，通道名留待 P2 收敛）。
  im: {
    onConflict: (callback) => {
      const handler = (
        _e: IpcRendererEvent,
        data: { newTaskId: string; currentTaskId: string; currentRoomId: string },
      ): void => callback(data);
      ipcRenderer.on('im:conflict', handler);
      return () => {
        ipcRenderer.off('im:conflict', handler);
      };
    },
  },
  // 新装引导（spec 2026-10-10）：status 通道随状态服务接线；
  // generatePlan / applyPlan 的 main handler 分别随 plan-generator / plan-applier 注册
  onboarding: {
    getStatus: () => invoke<{ status: OnboardingStatus }>('onboarding:getStatus'),
    generatePlan: (input: GenerateOnboardingPlanInput) =>
      invoke<GenerateOnboardingPlanResult>('onboarding:generatePlan', input),
    applyPlan: (input: ApplyOnboardingPlanInput) =>
      invoke<OnboardingApplyResult>('onboarding:applyPlan', input),
    markDone: (input: MarkOnboardingDoneInput) => invoke<void>('onboarding:markDone', input),
  },
  mcp: {
    // P3 Task 7：register 收敛到 api.resource.registerMcp（mcp:register 通道已删除）
    start: (workspaceId, mcpName) => invoke('mcp:start', workspaceId, mcpName),
    listTools: (workspaceId, mcpName) => invoke('mcp:listTools', workspaceId, mcpName),
    callTool: (workspaceId, mcpName, toolName, args) =>
      invoke('mcp:callTool', workspaceId, mcpName, toolName, args),
    stop: (workspaceId, mcpName) => invoke('mcp:stop', workspaceId, mcpName),
  },
  session: {
    // v2.0 P1 Task 8：会话内核命名空间（纯 SQLite，无 Matrix）。
    // v25 Task 6：泛化 create 退役 → createQuick / createCollab 双通道（spec §4.4）。
    // invoke 通道 10 个（session.ipc.handlers.ts）+ 推送 2 个
    // （session:message / session:message_event_batch）。
    list: (workspaceId?: string) => invoke('session:list', workspaceId),
    get: (sessionId: string) => invoke('session:get', sessionId),
    createQuick: (workspaceId: string) => invoke('session:createQuick', workspaceId),
    createCollab: (workspaceId: string, title: string | undefined, target: CollabTarget) =>
      invoke('session:createCollab', workspaceId, title, target),
    rename: (sessionId: string, title: string) => invoke('session:rename', sessionId, title),
    delete: (sessionId: string) => invoke('session:delete', sessionId),
    send: (sessionId: string, body: string, mentionedInstanceIds?: string[], context?: MessageContext) =>
      invoke('session:send', sessionId, body, mentionedInstanceIds, context),
    // Task 7：斜杠命令通道（spec §5.4）——/compact 等确定性命令入口；renderer
    // 拦截后去 / 前缀，把裸 command 名（如 'compact'）传给主进程
    command: (sessionId: string, command: string) =>
      invoke('session:command', sessionId, command),
    // 命令注册表（v2.11，spec §6.1）——/ 菜单命令组数据源；commands.ts 单一真相源
    listCommands: () => invoke<Array<{ name: string; description: string }>>('session:listCommands'),
    getMessages: (sessionId: string) => invoke('session:getMessages', sessionId),
    // thinking 全量按需拉取（P0-2 wire 截断配套，2026-10-14）：runs 按 seq 升序
    getMessageThinking: (messageId: string) =>
      invoke<{ runs: Array<{ seq: number; delta: string }> }>(
        'session:getMessageThinking',
        messageId,
      ),
    // 工具结果全量按需拉取（wire 截断第二刀）：按消息批量，seq 与截断版同源
    getMessageToolResults: (messageId: string) =>
      invoke<{ results: Array<{ seq: number; callId: string; result: string }> }>(
        'session:getMessageToolResults',
        messageId,
      ),
    deleteMessages: (sessionId: string, ids: string[]) =>
      invoke('session:deleteMessages', sessionId, ids),
    loadOlder: (sessionId: string, beforeTs: number, count?: number) =>
      invoke('session:loadOlder', sessionId, beforeTs, count),
    exportMessages: (sessionId: string, limit: number) =>
      invoke<{ filename: string; content: string }>('session:exportMessages', sessionId, limit),
    // 三级中断·会话级急停（spec 2026-10-13 §7.5）：全部流 + 全链 + 待投递回执清空
    stopAll: (sessionId: string) => invoke('session:stopAll', { sessionId }),
    // 置顶切换（spec 2026-10-22 §7）：true=写时间戳 / false=取消。handler 同址在
    // im/session-group.ipc.handlers.ts（与分组校验耦合，通道名属 session 命名空间）
    setPinned: (sessionId: string, pinned: boolean) => invoke('session:setPinned', sessionId, pinned),
    // 归组/移出分组：groupId=null 移出；主进程校验组属该会话所在工作空间
    moveToGroup: (sessionId: string, groupId: string | null) =>
      invoke('session:moveToGroup', sessionId, groupId),
    onMessage: (callback) => {
      const handler = (_evt: IpcRendererEvent, msg: ImMessage): void => callback(msg);
      ipcRenderer.on('session:message', handler);
      return () => {
        ipcRenderer.off('session:message', handler);
      };
    },
    onMessageEventBatch: (callback) => {
      const handler = (_e: IpcRendererEvent, batch: MessageEventBatch): void => callback(batch);
      ipcRenderer.on('session:message_event_batch', handler);
      return () => {
        ipcRenderer.off('session:message_event_batch', handler);
      };
    },
    // K10：主进程主动新建执行会话（定时任务自动放行/手动启动）→ 轻量刷新列表
    onListChanged: (callback) => {
      const handler = (): void => callback();
      ipcRenderer.on('session:listChanged', handler);
      return () => {
        ipcRenderer.off('session:listChanged', handler);
      };
    },
  },
  // 三级中断·链级 + 在途查询（spec 2026-10-13 §7.6/§9）：通道名与载荷形状与
  // 主进程 agent/interrupt-ipc.ts 逐字对齐（boundary 规则 4）
  dispatch: {
    cancelChain: (arg: { taskId?: string; subStreamSessionId?: string }) =>
      invoke('dispatch:cancelChain', arg),
    listInFlight: (sessionId?: string) =>
      invoke('dispatch:listInFlight', sessionId === undefined ? {} : { sessionId }),
  },
  allocation: {
    get: (workspaceId) => invoke('allocation:get', workspaceId),
    add: (workspaceId, type, ref) => invoke('allocation:add', workspaceId, type, ref),
    remove: (workspaceId, type, ref) => invoke('allocation:remove', workspaceId, type, ref),
  },
  gitPolicy: {
    get: (workspaceId) => invoke('gitPolicy:get', workspaceId),
    set: (workspaceId, policy) => invoke('gitPolicy:set', workspaceId, policy),
  },
  audit: {
    getToolCalls: (workspaceId, opts) => invoke('audit:getToolCalls', workspaceId, opts),
    // P2 Task 8：容量配额——读取 / 设置（null=回退全局）/ 立即清理
    getQuota: (workspaceId) => invoke('audit:getQuota', workspaceId),
    setQuota: (workspaceId, quotaMb) => invoke('audit:setQuota', workspaceId, quotaMb),
    enforceNow: (workspaceId) => invoke('audit:enforceNow', workspaceId),
  },
  settings: {
    getGlobal: () => invoke('settings:getGlobal'),
    updateGlobal: (patch) => invoke('settings:updateGlobal', patch),
    getSession: (sessionId: string) => invoke('settings:getSession', sessionId),
    updateSession: (sessionId: string, patch) => invoke('settings:updateSession', sessionId, patch),
  },
  // v2.2 P1：记忆管理通道（memory/ipc.handlers.ts；总开关经 settings:updateGlobal 的 memoryEnabled）
  memory: {
    list: (scope, filter) => invoke('memory:list', scope, filter),
    save: (input) => invoke('memory:save', input),
    update: (id, patch) => invoke('memory:update', id, patch),
    delete: (id) => invoke('memory:delete', id),
    search: (q, scope, limit) => invoke('memory:search', q, scope, limit),
    // v2.2 P3：导出/导入 Markdown（通道名与 ipc.handlers.ts / renderer types.d.ts 三方逐字对齐）
    exportMarkdown: (scope) => invoke('memory:exportMarkdown', scope),
    importMarkdown: (scope, content) => invoke('memory:importMarkdown', scope, content),
  },
  resource: {
    // v1.7：统一资源列表（builtin + marketplace + custom 三源合并），filter 可选
    list: (filter?: ResourceFilter) => invoke<ResourceItem[]>('resource:list', filter),
    // v1.7：按 id 查单个资源详情（找不到返回 null）
    getDetail: (id: string) => invoke<ResourceItem | null>('resource:getDetail', id),
    // v1.7：安装资源（builtin/custom 不可安装）。P2.1 Task 3：smithery 条目返回
    // needsConfig 两态（Task 6 弹窗消费）。M2.3 T2：hub 条目返回 HubInstallResult
    // （alreadyLatest=true 如实回执「已是最新」），其余源返回空
    install: (id: string) => invoke<SmitheryInstallResult | HubInstallResult | void>('resource:install', id),
    // P2.1 Task 3：smithery needsConfig 二段安装（弹窗收集配置后提交）
    installSmitheryRemote: (id: string, config: Record<string, string>) =>
      invoke<void>('resource:installSmitheryRemote', id, config),
    // v1.7：删除/卸载资源（builtin 抛错；marketplace→uninstall；custom 三分支）
    delete: (id: string) => invoke<void>('resource:delete', id),
    // P3 Task 7：注册自定义 MCP（收敛自 api.mcp.register），返回新资源的 ResourceItem
    registerMcp: (config: RegisterMcpInput) =>
      invoke<ResourceItem>('resource:registerMcp', config),
    // P3 Task 7：上传自定义 skill zip（收敛自 api.skill.uploadZip），v1.6.2 起返回数组。
    // v1.6.3: 不能用 Buffer.from(buffer)——contextBridge 里 Node Buffer 跨 IPC
    // structured clone 时底层 ArrayBuffer view 关联会断，main 收到的是损坏数据。
    // 用标准 Uint8Array view 让 structured clone 正确拷贝，main process 自己转回 Buffer。
    uploadSkill: (buffer: ArrayBuffer, filename: string) =>
      invoke<UploadedSkill[]>('resource:uploadSkill', new Uint8Array(buffer), filename),
    /** 表单创建 skill（frontmatter+正文 → custom skill；slug 冲突覆盖） */
    createSkill: (input: SkillCreateInput) => invoke<UploadedSkill>('resource:createSkill', input),
    // P2.6：Git 仓库 skill 导入两通道——scan 下载+解析落 tmp（只读预览，返回
    // importId 一次性凭证 + skills 清单）；import 消费 tmp 落正式目录，返回
    // { imported, failures } 逐条结果（单条失败不中断）。通道名与 renderer
    // types.d.ts 的 ApiSurface 两方法逐字对齐。
    scanGitRepoSkills: (url: string) =>
      invoke<{ importId: string; skills: ScannedSkill[] }>('resource:scanGitRepoSkills', url),
    importGitRepoSkills: (importId: string) =>
      invoke<GitImportResult>('resource:importGitRepoSkills', importId),
    // P2.1 Task 5：DXT/MCPB 本地包两阶段导入。与 uploadSkill 同款 Uint8Array
    // 传输——contextBridge 里 Node Buffer 跨 IPC structured clone 会损坏，main
    // 收到后自行 Buffer.from 重建。
    parseMcpBundle: (buffer: ArrayBuffer, filename: string) =>
      invoke<BundlePreview>('resource:parseMcpBundle', new Uint8Array(buffer), filename),
    importMcpBundle: (buffer: ArrayBuffer, filename: string, userConfig: Record<string, string>) =>
      invoke<ResourceItem>(
        'resource:importMcpBundle',
        new Uint8Array(buffer),
        filename,
        userConfig,
      ),
    // P2 Task 4：网络注册表（hub provider 框架）——renderer 经此消费，不直连 hub。
    // P2.1 Task 4：query（服务端搜索）与 page（1 起始）透传，返回加 hasMore
    registryProviders: () => invoke<RegistryProviderMeta[]>('resource:registryProviders'),
    registryList: (
      providerKey: RegistryProviderMeta['key'],
      type: RegistryListEntry['type'],
      query?: string,
      page?: number,
      opts?: { fresh?: boolean },
    ) =>
      invoke<{
        entries: RegistryListEntry[];
        degraded: boolean;
        hasMore: boolean;
        notEnrolled?: boolean;
        nodeName?: string;
        total?: number;
        revision?: number;
      }>('resource:registryList', providerKey, type, query, page, opts),
    // P2.2 Task 6：查看已装远程 MCP 配置（bare=true 时无 schema——裸表单回显 url/headers）
    getMcpConfig: (name: string) => invoke<McpConfigView>('resource:getMcpConfig', name),
    // P2.2 Task 6：编辑已装远程 MCP 配置（headers 仅裸模式整包覆盖；schema 可选透传落库）
    updateMcpConfig: (name: string, input: McpConfigUpdateInput) =>
      invoke<void>('resource:updateMcpConfig', name, input),
    // P2.5 Task 2：MCP 全字段编辑视图（stdio + 远程通吃，编辑弹窗预填数据源）
    getMcpEditView: (name: string) => invoke<McpEditView>('resource:getMcpEditView', name),
    // P2.5 Task 2：MCP 全字段编辑提交（专用 UPDATE 保 id/source/installed_at + 池驱逐）
    updateMcpEntry: (name: string, input: McpEntryUpdateInput) =>
      invoke<void>('resource:updateMcpEntry', name, input),
    // 组⑤：MCP 启停（写库 + 禁用时驱逐池内运行实例；未注册 reject）
    setMcpEnabled: (name: string, enabled: boolean) =>
      invoke<void>('resource:setMcpEnabled', name, enabled),
    // P2.2 Task 6：悬空 MCP 引用扫描（空数组 = 无悬空，卡片不显示）
    danglingMcpRefs: () => invoke<DanglingMcpRef[]>('resource:danglingMcpRefs'),
    // P2.3：预置清单只读（本地 resources/agents/*.yaml 直读零网络；mcp/skill 空数组）
    listBuiltinPresets: (type: ResourceType) =>
      invoke<BuiltinPresetItem[]>('resource:listBuiltinPresets', type),
    // 2026-10-08：单个预置 agent 能力预览（详情面板能力清单 + 薄 fork 预填数据源）
    previewBuiltinPreset: (slug: string) =>
      invoke<BuiltinPresetPreview>('resource:previewBuiltinPreset', slug),
    // 走查 D9：远程目录降级态（资源库「网络目录暂时不可达」提示条数据源）
    getCatalogStatus: () =>
      invoke<{
        degraded: boolean;
        hubNotEnrolled: boolean;
        sources?: Array<{ source: 'marketplace' | 'hub'; degraded: boolean }>;
      }>('resource:getCatalogStatus'),
    // M5.0：hub 目录归属快照（徽标/发布钮/下架钮收敛判定输入）
    hubCatalogOwnership: () => invoke<HubCatalogOwnership>('resource:hubCatalogOwnership'),
    // M5.0 §7.5：存量并存扫描（设置页 hub 面板清理小票）
    hubCoexistScan: () => invoke<HubCoexistIssue[]>('resource:hubCoexistScan'),
    // M5.1 §1.1：插件×本地副本重复清单（库页提示条）+ 一键清理（部分失败续删）
    pluginDupScan: () => invoke<PluginDupIssue[]>('resource:pluginDupScan'),
    pluginDupCleanup: (targets: PluginDupTarget[]) =>
      invoke<PluginDupCleanupResult>('resource:pluginDupCleanup', targets),
  },
  task: {
    create: (input) => invoke<TaskRow>('task:create', input),
    // M3.3 批量创建（上限 50；per-item union 部分成功允许）
    createBatch: (input) => invoke<TaskCreateBatchResult>('task:createBatch', input),
    // M3.3 关系写通道（parentTaskId / dependsOn 各自可选更新；dependsOn 全量替换）
    setRelations: (input) => invoke<TaskRow>('task:setRelations', input),
    list: (opts) => invoke<TaskRow[]>('task:list', opts),
    get: (id) => invoke<TaskRow | null>('task:get', id),
    update: (id, patch) => invoke<void>('task:update', id, patch),
    transition: (id, to, extraPatch) => invoke<TaskRow>('task:transition', id, to, extraPatch),
    // B8：execution_session 决策树 + 转 in_progress + 锁定 execution_session
    start: (id, opts) =>
      invoke<{ executionSessionId: string; createdNewRoom: boolean }>('task:start', id, opts),
    cancel: (id) => invoke<void>('task:cancel', id),
    // K7-5：恢复暂停的任务（paused → in_progress + kickoff 重注入执行会话）
    // v2.6.0 多路扩展：in_progress 走断点续跑；assigned/session_queued 走既有 executor 放行
    resume: (id) => invoke<TaskRow & { streamSessionId?: string }>('task:resume', id),
    // v2.6.0 启动恢复卡数据源
    listInterrupted: () => invoke('task:listInterrupted'),
    // B9：任务冲突处理（5 策略）
    resolveConflict: (input) => invoke('task:resolveConflict', input),
    // 看板重构 Task 6：拖拽换列 / 归档域（动作裁决单点在主进程 move.ts）
    move: (id, target) => invoke<TaskRow>('task:move', id, target),
    // 顶置开关（迁移 050，语义单点在主进程 repo.setTaskPinned）
    setPinned: (id, pinned) => invoke<TaskRow>('task:setPinned', id, pinned),
    archive: (id) => invoke<TaskRow>('task:archive', id),
    unarchive: (id) => invoke<TaskRow>('task:unarchive', id),
  },
  // 看板重构 Task 7：任务组命名空间（组 CRUD + 归档级联，groups.ipc.handlers.ts）
  taskGroup: {
    list: (workspaceId, opts?) => invoke<GroupRow[]>('taskGroup:list', workspaceId, opts),
    create: (input) => invoke<GroupRow>('taskGroup:create', input),
    update: (id, patch) => invoke<GroupRow>('taskGroup:update', id, patch),
    reorder: (orderedIds) => invoke<void>('taskGroup:reorder', orderedIds),
    archive: (id) =>
      invoke<{ cancelledIds: string[]; archivedCount: number }>('taskGroup:archive', id),
    unarchive: (id) => invoke<GroupRow>('taskGroup:unarchive', id),
    delete: (id, moveToGroupId) =>
      invoke<{ movedCount: number }>('taskGroup:delete', id, moveToGroupId),
  },
  // 会话分组命名空间（spec 2026-10-22 §7）：分组 CRUD，按 workspace 隔离。
  // 置顶/归组两个会话行写面在 api.session（setPinned / moveToGroup）。
  sessionGroup: {
    list: (workspaceId: string) => invoke<SessionGroupRow[]>('sessionGroup:list', workspaceId),
    create: (workspaceId: string, name: string) =>
      invoke<SessionGroupRow>('sessionGroup:create', workspaceId, name),
    rename: (groupId: string, name: string) => invoke<void>('sessionGroup:rename', groupId, name),
    delete: (groupId: string) => invoke<void>('sessionGroup:delete', groupId),
    setColor: (groupId: string, color: string) =>
      invoke<void>('sessionGroup:setColor', groupId, color),
  },
  dialog: {
    pickDirectory: (opts) => invoke('dialog:pickDirectory', opts),
  },
  // P2.3：misc 命名空间首个通道——外链转系统浏览器（主进程侧强制 https 校验）
  misc: {
    openExternal: (url: string) => invoke<void>('misc:openExternal', url),
  },
  // 插件系统 P1（spec 2026-10-15）：安装 / 启停 / 卸载；P2 加 reload
  plugin: {
    installZip: (data: Uint8Array, filename: string, workspaceId?: string) =>
      invoke<PluginSummary>('plugin:installZip', data, filename, workspaceId),
    installDevDir: (dir: string, workspaceId?: string) =>
      invoke<PluginSummary>('plugin:installDevDir', dir, workspaceId),
    setEnabled: (id: string, workspaceId: string, enabled: boolean) =>
      invoke<void>('plugin:setEnabled', id, workspaceId, enabled),
    uninstall: (id: string, keepData: boolean) => invoke<void>('plugin:uninstall', id, keepData),
    reload: (id: string) => invoke<PluginSummary>('plugin:reload', id),
    getDetail: (pluginId: string, workspaceId?: string) =>
      invoke<PluginDetail>('plugin:getDetail', pluginId, workspaceId),
    // P4：面板与 config 面（spec §6）
    listPanels: (workspaceId: string) => invoke<PluginPanelInfo[]>('plugin:listPanels', workspaceId),
    listAssembledTools: (workspaceId: string) =>
      invoke<PluginToolInfo[]>('plugin:listAssembledTools', workspaceId),
    callService: (pluginId: string, method: string, params: unknown, workspaceId?: string) =>
      invoke<unknown>('plugin:callService', pluginId, method, params, workspaceId),
    getConfig: (pluginId: string, workspaceId?: string) =>
      invoke<PluginConfigView | null>('plugin:getConfig', pluginId, workspaceId),
    setConfig: (pluginId: string, values: Record<string, string | number | boolean | null>, workspaceId?: string) =>
      invoke<PluginConfigView>('plugin:setConfig', pluginId, values, workspaceId),
    onPanelsChanged: (callback: () => void) => {
      const handler = (): void => callback();
      ipcRenderer.on('plugin:panelsChanged', handler);
      return () => {
        ipcRenderer.off('plugin:panelsChanged', handler);
      };
    },
    onPanelEvent: (callback: (payload: { event: string; payload: unknown }) => void) => {
      const handler = (_e: unknown, payload: { event: string; payload: unknown }): void => callback(payload);
      ipcRenderer.on('plugin:panelEvent', handler);
      return () => {
        ipcRenderer.off('plugin:panelEvent', handler);
      };
    },
  },
  // M0 节点互联（spec 2026-10-23）：hub 连接状态/接入/忘记 + 状态与节点在线推送
  hub: {
    getStatus: () => invoke('hub:getStatus'),
    getNodes: () => invoke('hub:getNodes'),
    configure: (input) => invoke('hub:configure', input),
    enroll: (input) => invoke('hub:enroll', input),
    forget: () => invoke('hub:forget'),
    onStateChanged: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubStateChangedEvent): void => callback(payload);
      ipcRenderer.on('hub:stateChanged', handler);
      return () => { ipcRenderer.off('hub:stateChanged', handler); };
    },
    onNodePresence: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubNodePresenceEvent): void => callback(payload);
      ipcRenderer.on('hub:nodePresence', handler);
      return () => { ipcRenderer.off('hub:nodePresence', handler); };
    },
    publishResource: (input: HubPublishResourceInput) => invoke<HubPublishResult>('hub:publishResource', input),
    onResourcePublished: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubResourcePublishedEvent): void => callback(payload);
      ipcRenderer.on('hub:resourcePublished', handler);
      return () => { ipcRenderer.off('hub:resourcePublished', handler); };
    },
    // 撤回（M3.4 §2.4）：下架入口 + resource.unpublished 推送订阅——与发布面对称
    unpublishResource: (input: { slug: string }) => invoke<void>('hub:unpublishResource', input),
    onResourceUnpublished: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubResourceUnpublishedEvent): void => callback(payload);
      ipcRenderer.on('hub:resourceUnpublished', handler);
      return () => { ipcRenderer.off('hub:resourceUnpublished', handler); };
    },
    groupList: () => invoke<HubGroupListResult>('hub:groupList'),
    groupCreate: (input) => invoke<HubGroupCreateResult>('hub:groupCreate', input),
    groupInvite: (input) => invoke<HubGroupInviteResult>('hub:groupInvite', input),
    groupJoin: (input) => invoke<HubGroupJoinResult>('hub:groupJoin', input),
    groupLeave: (input) => invoke<HubGroupLeaveResult>('hub:groupLeave', input),
    groupTransfer: (input) => invoke<HubGroupTransferResult>('hub:groupTransfer', input),
    onGroupChanged: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubGroupChangedEvent): void => callback(payload);
      ipcRenderer.on('hub:groupChanged', handler);
      return () => { ipcRenderer.off('hub:groupChanged', handler); };
    },
    snapshotBuildUpload: (input) => invoke<HubSnapshotBuildUploadResult>('hub:snapshotBuildUpload', input),
    mirrorWorkspace: (input: HubMirrorWorkspaceInput) => invoke<HubMirrorAcceptResult>('hub:mirrorWorkspace', input),
    getDelegationSettings: () => invoke<HubDelegationSettings>('hub:getDelegationSettings'),
    setDelegationSettings: (input: HubDelegationSettings) => invoke<HubDelegationSettings>('hub:setDelegationSettings', input),
    getWorkspaceDirSettings: () => invoke<HubWorkspaceDirView>('hub:getWorkspaceDirSettings'),
    setWorkspaceDirSettings: (input: { rootDir: string | null }) => invoke<HubWorkspaceDirView>('hub:setWorkspaceDirSettings', input),
    onMirrorResult: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubMirrorResultEvent): void => callback(payload);
      ipcRenderer.on('hub:mirrorResult', handler);
      return () => { ipcRenderer.off('hub:mirrorResult', handler); };
    },
    // M2.2 P2-7：hub 资源补装进度（通道名见顶部 HUB_INSTALL_PROGRESS_CHANNEL 契约注记）
    onInstallProgress: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubInstallProgressEvent): void => callback(payload);
      ipcRenderer.on(HUB_INSTALL_PROGRESS_CHANNEL, handler);
      return () => { ipcRenderer.off(HUB_INSTALL_PROGRESS_CHANNEL, handler); };
    },
    onWorkspaceMirrored: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubWorkspaceMirroredEvent): void => callback(payload);
      ipcRenderer.on('hub:workspaceMirrored', handler);
      return () => { ipcRenderer.off('hub:workspaceMirrored', handler); };
    },
    taskList: (input?: { groupId?: string }) => invoke<HubTaskListResult>('hub:taskList', input ?? {}),
    taskDelegate: (input: HubTaskDelegateInput) => invoke<HubTaskDelegateResult>('hub:taskDelegate', input),
    taskCancel: (input: { taskId: string }) => invoke<{ ok: boolean }>('hub:taskCancel', input),
    // M3.1 远程代答：错误 rejection 的 message 带 `[code] ` 前缀（主进程编码——见 ipc.handlers）
    taskAnswer: (input: HubTaskAnswerInput) => invoke<HubTaskAnswerResult>('hub:taskAnswer', input),
    getViewSettings: () => invoke<HubViewSettings>('hub:getViewSettings'),
    setViewSettings: (input: HubViewSettings) => invoke<HubViewSettings>('hub:setViewSettings', input),
    viewWorkspace: (input: { targetNodeId: string; workspaceName: string; groupId?: string }) => invoke<HubViewOverview>('hub:viewWorkspace', input),
    viewSessions: (input: { targetNodeId: string; workspaceName: string; beforeSeq?: number; limit: number; groupId?: string }) =>
      invoke<{ sessions: HubViewSessionSummary[] }>('hub:viewSessions', input),
    viewMessages: (input: { targetNodeId: string; sessionId: string; workspaceName?: string; fromSeq: number; limit: number; groupId?: string }) =>
      invoke<HubViewMessagePage>('hub:viewMessages', input),
    viewTasks: (input: { targetNodeId: string; workspaceName: string; groupId?: string }) =>
      invoke<{ tasks: HubViewLocalTask[] }>('hub:viewTasks', input),
    viewSubscribe: (input: { targetNodeId: string; sessionId: string; groupId?: string }) => invoke<{ ok: boolean }>('hub:viewSubscribe', input),
    viewUnsubscribe: (input: { targetNodeId: string; sessionId: string; groupId?: string }) => invoke<{ ok: boolean }>('hub:viewUnsubscribe', input),
    // M3.2 远端可见性：远端空间清单 + 只读文件树（载荷原样透传主进程）
    viewWorkspaces: (input: { targetNodeId: string; groupId?: string }) =>
      invoke<{ workspaces: HubViewWorkspaceSummary[] }>('hub:viewWorkspaces', input),
    viewFiles: (input: { targetNodeId: string; workspaceName: string; op: 'list' | 'read'; path?: string; groupId?: string }) =>
      invoke<HubViewFilesResult>('hub:viewFiles', input),
    // 镜像登记表查询（M2.1 T6 / RM-M21-7）：workspaceName 可选过滤
    mirrorRegistry: (input?: { workspaceName?: string }) =>
      invoke<{ mirrors: HubMirrorRegistryRow[] }>('hub:mirrorRegistry', input ?? {}),
    // 路由提交链两通道（M2.1 T8）：三模式统一落点 + 预检概要
    submitRoutedTask: (input: SubmitRoutedTaskInput) =>
      invoke<SubmitRoutedTaskResult>('hub:submitRoutedTask', input),
    routingPrecheck: (input: { workspaceName: string }) =>
      invoke<RoutingPrecheckResult>('hub:routingPrecheck', input),
    // 看板外派投影两通道（M2.1 T9）：引导读（进度摘要 + worker 收委派记录）+ 重派单点
    delegationBoard: () => invoke<DelegationBoardResult>('hub:delegationBoard'),
    retryDispatch: (input: { taskId: string }) =>
      invoke<RetryDispatchResult>('hub:retryDispatch', input),
    // 本机等待确认会话清单（M2.1 T12 worker 等待卡）
    localWaiting: () => invoke<HubLocalWaitingEntry[]>('hub:localWaiting'),
    onViewAppended: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubViewAppendedEvent): void => callback(payload);
      ipcRenderer.on('hub:viewAppended', handler);
      return () => { ipcRenderer.off('hub:viewAppended', handler); };
    },
    onTaskProgress: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubTaskProgressEvent): void => callback(payload);
      ipcRenderer.on('hub:taskProgress', handler);
      return () => { ipcRenderer.off('hub:taskProgress', handler); };
    },
    onTaskCompleted: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubTaskTerminalEvent): void => callback(payload);
      ipcRenderer.on('hub:taskCompleted', handler);
      return () => { ipcRenderer.off('hub:taskCompleted', handler); };
    },
    onTaskFailed: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubTaskTerminalEvent): void => callback(payload);
      ipcRenderer.on('hub:taskFailed', handler);
      return () => { ipcRenderer.off('hub:taskFailed', handler); };
    },
    onTaskInterrupted: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubTaskTerminalEvent): void => callback(payload);
      ipcRenderer.on('hub:taskInterrupted', handler);
      return () => { ipcRenderer.off('hub:taskInterrupted', handler); };
    },
    onTaskAnswered: (callback) => {
      const handler = (_e: IpcRendererEvent, payload: HubTaskAnsweredEvent): void => callback(payload);
      ipcRenderer.on('hub:taskAnswered', handler);
      return () => { ipcRenderer.off('hub:taskAnswered', handler); };
    },
  },
  window: {
    // P2 Task 1：自绘 titlebar 窗口控制（send 单向 + is-maximized 查询 + maximized 推送）
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => invoke<boolean>('window:is-maximized'),
    onMaximizedChanged: (callback: (maximized: boolean) => void) => {
      const handler = (_evt: IpcRendererEvent, maximized: boolean): void => callback(maximized);
      ipcRenderer.on('window:maximized-changed', handler);
      return () => {
        ipcRenderer.off('window:maximized-changed', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
