// electron/src/main/agent/agent-runner.ts
//
// AgentRunner（task-driven runtime 架构核心）——每个 agent_assignment 一个。
//
// v1：单 task 串行（per-agent max=1）。task 到达 → acquire warm runtime →
//     通过 IPC 注入 task config → 子进程跑 chat loop → end chunk → release runtime。
// v2：多 task 并发（warm pool 多 acquire）。
//
// 与 runtime-manager.ts 的关系：runtime-manager 是 v1 的"长期运行 agent"模式
// （一个 agent 一个常驻子进程），AgentRunner 取代它转为"task-driven"模式
// （task 来了 acquire，结束 release）。AgentRuntimeOpts 类型仍复用，spawn 实现
// 由 runtime-spawner（后续 task）接管。
import type { WarmPool, WarmRuntime } from './warm-pool';
import type { AgentRuntimeOpts } from './runtime-manager';

/** task 配置——由上层（消息路由层）构造后传给 executeTask */
export interface TaskConfig {
  /** task 主键；null = ephemeral chat（非 task 调度的即时对话） */
  taskId: string | null;
  /** 执行房间 ID（agent 在此房间输出流式回复） */
  executionRoomId: string;
  /** 用户输入的正文 */
  body: string;
  /** 流式会话 ID（贯穿 start→end chunk 的唯一标识） */
  streamSessionId: string;
  /** 消息 metadata（mentions 等） */
  mentions?: string[];
}

/** AgentRunner 构造选项 */
export interface AgentRunnerOpts {
  /** agent_assignment 主键（instanceId） */
  agentAssignmentId: string;
  /** agent bot 的 Matrix userId（@bot:home） */
  agentBotUserId: string;
  /** 所属 workspace ID */
  workspaceId: string;
  /** runtime 配置（复用 runtime-manager.ts 的 AgentRuntimeOpts；spawn 由 warmPool 注入） */
  config: AgentRuntimeOpts;
  /** 共享 warm pool（多个 AgentRunner 可共用同一 pool） */
  warmPool: WarmPool;
}

/** 活跃 task 记录——keyed by streamSessionId */
interface ActiveTask {
  streamSessionId: string;
  runtime: WarmRuntime;
  taskId: string | null;
  /** 注册到 child 的 message handler，destroy/end 时用于 off 反注册 */
  messageHandler: (msg: unknown) => void;
}

export class AgentRunner {
  private readonly opts: AgentRunnerOpts;
  /** streamSessionId → 活跃 task */
  private readonly activeTasks = new Map<string, ActiveTask>();

  constructor(opts: AgentRunnerOpts) {
    this.opts = opts;
  }

  /**
   * 启动一个 task（含 ephemeral chat）。
   *
   * 流程：acquire warm runtime → 注册 message handler（监听 end/error chunk）→
   * 注入 task config 给子进程 → 返回 streamSessionId。
   *
   * 注意：本方法不等候子进程跑完 chat loop——只负责"注入并启动"。
   * chunk 转发 / 落盘由 runtime-spawner 统一注册的 handler 处理；
   * 本 runner 只关注 end/error 以便 release runtime。
   */
  async executeTask(task: TaskConfig): Promise<{ streamSessionId: string }> {
    const runtime = await this.opts.warmPool.acquire(this.opts.agentAssignmentId);

    // 注册 message handler：过滤本 task 的 streamSessionId，收到 end/error 时 release
    const child = runtime.child;
    const messageHandler = (msg: unknown): void => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: string; streamSessionId?: string };
      // 只处理本 task 的 chunk（同一 runtime 未来可能复用跑多 task）
      if (m.streamSessionId !== task.streamSessionId) return;
      if (m.type === 'end' || m.type === 'error') {
        // 任务结束 → 反注册 handler + release runtime + 移出活跃表
        child.off('message', messageHandler);
        this.opts.warmPool.release(runtime);
        this.activeTasks.delete(task.streamSessionId);
      }
    };
    child.on('message', messageHandler);

    const active: ActiveTask = {
      streamSessionId: task.streamSessionId,
      runtime,
      taskId: task.taskId,
      messageHandler,
    };
    this.activeTasks.set(task.streamSessionId, active);

    // 注入 task config 给子进程（子进程据此启动 chat loop）
    child.send({
      type: 'task-config',
      taskId: task.taskId,
      executionRoomId: task.executionRoomId,
      body: task.body,
      streamSessionId: task.streamSessionId,
      mentions: task.mentions ?? [],
    });

    return { streamSessionId: task.streamSessionId };
  }

  /**
   * 中断指定 task 的 stream。
   * 通过 IPC 发 abort 消息，子进程的 abortListener 据此触发 AbortController.abort()。
   * 找不到活跃 task 时 no-op（可能已结束或从未启动）。
   */
  abortStream(streamSessionId: string): void {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return;
    active.runtime.child.send({ type: 'abort', streamSessionId });
  }

  /** 当前活跃 task 数（per-agent 并发检查用） */
  activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * 销毁 runner + 释放所有活跃 runtime。
   * 反注册所有 message handler + release 每个 runtime（v1 = kill 子进程）+ 清空活跃表。
   * 不销毁 warmPool 本身（warmPool 生命周期由外层管理，可能被其他 runner 共享）。
   */
  destroy(): void {
    for (const active of this.activeTasks.values()) {
      active.runtime.child.off('message', active.messageHandler);
      this.opts.warmPool.release(active.runtime);
    }
    this.activeTasks.clear();
  }
}
