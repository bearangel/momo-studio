// electron/src/main/plugin/human-gate.ts
//
// 插件 service ctx 的 human-gate 注入体（spec 2026-11-17 §7-1）。
// 沿 execSandboxed 注入先例：插件不直接 import 内部模块，主进程能力经 ctx 下发。
import {
  insertHumanRequest,
  getHumanRequest,
} from '../storage/tasks/human-requests-repo';
import { emitHumanChanged } from '../task/lifecycle-runs';

/** 插件面的人工请求行投影（避免整行 repo 类型跨域泄漏；payloadJson 供两段式取回执行参数） */
export interface HumanRequestRowLike {
  id: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled' | 'superseded';
  answerJson: string | null;
  payloadJson: string | null;
}

/** 人工请求门 ctx 面（spec 2026-11-17 §7-1）：create 落 kind=tool_gate 行，
 *  timeoutPolicy 缺省 keep_waiting（人工批准无超时，sweeper 只回收带 deadline 的行） */
export interface PluginHumanGate {
  create(input: {
    sessionId: string;
    taskId?: string | null;
    title: string;
    prompt?: string;
    payloadJson?: string;
  }): Promise<string>;
  status(id: string): Promise<HumanRequestRowLike | null>;
}

/** buildPluginHumanGateApi：无状态闭包——直接映射 human-requests-repo 读写面 */
export function buildPluginHumanGateApi(): PluginHumanGate {
  return {
    create: async (input) => {
      if (typeof input.sessionId !== 'string' || input.sessionId === '') {
        throw new Error('humanGate.create 缺少 sessionId（工具层须注入会话 id）');
      }
      const row = insertHumanRequest({
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        kind: 'tool_gate',
        title: input.title,
        prompt: input.prompt ?? '',
        payloadJson: input.payloadJson ?? null,
      });
      // 面板可见性锚：与存量 tool_gate 链同纪律——落行即广播 inserted，
      // 否则面板（listPendingBySession 挂载/事件驱动）不知道有新卡（验收 P0 实证）
      emitHumanChanged({ sessionId: input.sessionId, requestId: row.id, kind: 'inserted' });
      return row.id;
    },
    status: async (id): Promise<HumanRequestRowLike | null> => {
      const row = getHumanRequest(id);
      if (!row) return null;
      return { id: row.id, status: row.status, answerJson: row.answerJson, payloadJson: row.payloadJson };
    },
  };
}
