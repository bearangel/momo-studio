// electron/src/main/agent/tools/types.ts
// 工具模块统一接口 + 共享上下文。每个工具模块实现 ToolModule，
// 由 tools/index.ts 聚合并路由。

import type { WorkspaceFS } from '../../files/workspace-fs';
import type { SkillRegistry } from '../../skill/registry';
import type { LLMToolDef } from '../llm-provider';
import type { StreamChunk } from '../stream-chunk';
import type { ToolCatalogEntry } from './catalog-entry';
import type { ToolPermissionConfig } from './shared/permission';
import type { ReadTracker } from './shared/read-tracker';

/** 工具执行时的共享上下文。runtime-entry 在每次工具调用前组装并传入。 */
export interface ToolContext {
  wsFs: WorkspaceFS;
  workspaceId: string;
  workspaceDir: string;
  skillRegistry: SkillRegistry;
  streamSessionId: string;
  parentStreamSessionId?: string;
  roomId: string;
  sendStreamChunk: (chunk: StreamChunk) => void;
  permissionConfig: ToolPermissionConfig;
  /**
   * v2.3 任务工具：创建者 user ID（从 workspaces.owner_id 注入）。
   * LLM 不必填、也禁止覆盖 args 中的同名键——避免 FK 违约 + 跨用户冒名。
   */
  creatorUserId: string;
  /**
   * v1.5.1：当前 chat loop 的 abortSignal。
   * 长任务工具（bash/webfetch）应监听此 signal，被中断时立即清理（SIGKILL 子进程 / abort fetch）
   * 并 resolve "已中断"，否则会等到自身 timeout 才返回，期间用户停止按钮无效。
   */
  abortSignal?: AbortSignal;
  /**
   * v2.3 Read-before-Edit：维护 streamSession 维度已读取文件集合。
   * 文件写工具（edit_file / write_file 覆盖场景）写盘前必须 assertRead；
   * 可选——未注入时跳过守门（向后兼容旧调用方）。
   */
  readTracker?: ReadTracker;
  /**
   * v2.5 变更账本：当前关联任务 id（task-driven runtime 派发，快速会话等
   * 场景无任务 → undefined，记账时归一为 null）。写工具记账（RecordCtx.taskId）
   * 消费；可选——未注入不影响既有流程（向后兼容旧调用方）。
   */
  taskId?: string;
  /**
   * 归属制（spec 2026-09-15 §5.1）：当前 runtime 的 agent 实例 ID
   * （workspace_agent_members.instance_id）。runtime-entry 从 AGENT_CONFIG
   * 的 agentAssignmentId 注入；浏览器工具据此路由专属 tab。缺省（测试直调
   * 无 runner）由消费方归一为 'user'。
   */
  agentInstanceId?: string;
  /**
   * 主进程 userData 目录绝对路径（spawn-helpers 经 AGENT_CONFIG 定型注入）。
   * 工具在 runtime 子进程执行——无 electron API，apply_patch 备份等落盘位置
   * 以此为基准；缺省（测试直调 / 旧配置）由消费方回退 os.tmpdir()。
   */
  userDataDir?: string;
  /**
   * 多语言 LSP 检测快照（主进程 lsp/detect 检测、AGENT_CONFIG 透传）。
   * LspTools.create 以「非空」为注册门控；缺省 = 不注册（旧测试直调兼容）。
   */
  lspLanguages?: string[];
}

/** 工具模块统一接口。每个类别一个实现。 */
export interface ToolModule {
  getDefs(): LLMToolDef[];
  /** 目录自描述（v2.x 单一真相源）：与 getDefs() 一一对应的目录条目 */
  getCatalog(): ToolCatalogEntry[];
  handles(name: string): boolean;
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`未知工具: ${name}`);
    this.name = 'UnknownToolError';
  }
}
