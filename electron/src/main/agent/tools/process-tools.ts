// electron/src/main/agent/tools/process-tools.ts
//
// 回合进程管理工具（2026-09-25 生命周期立项 E-A）：process_list / process_kill。
// 背景：seatbelt signal 过滤器无法表达「自身进程组」（实测），沙箱内 agent
// 连自己启动的 dev server 都杀不掉（沙箱测试-5 子 agent 穷尽 7 种杀法全
// EPERM）。本组工具经 process-bridge 请求主进程侧执行，授权口径 = 本回合
// bash 工具登记的进程组（process-registry）——零沙箱放宽、跨平台。
//
// 典型工作流：bash 后台起服务（&）→ curl 验证 → process_kill(port=8080)
// 关服务（端口即刻释放，无需等回合结束）→ 换配置重启。

import type { LLMToolDef } from '../llm-provider';
import { requestProcessList, requestProcessKill, requestProcessKeep } from './process-bridge';
import type { ToolContext, ToolModule } from './types';

export class ProcessTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'process_list',
        description:
          '列出本回合用 bash 启动的后台进程组及存活成员（pid + 命令行）。'
          + '沙箱内 ps/kill 被系统拦截——查看自己启动的进程用本工具，不要用 bash 里的 ps/kill -0。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'process_keep',
        description:
          '把本回合 bash 启动的服务标记为「用户保留」——回合结束后继续存活，供用户在浏览器中'
          + '亲自查看/验收（典型场景：起 dev server → 验证 → 本工具保留 → 告知用户访问地址 → 回合正常结束）。'
          + '三选一指定目标（推荐 port）。上限：每工作空间 5 个保留服务，超出需先 process_kill 关旧的。'
          + '保留服务的生命周期：app 会话内有效（应用重启即全部回收）；用户验收完毕后可用 process_kill(port) 关闭。'
          + '仅用户明确要求保留时使用——无人查看的服务不要保留（回合结束平台自动回收即可）。',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'number', description: '按监听端口保留（推荐，如 8080）' },
            pid: { type: 'number', description: '按进程 id 保留（须为本回合启动的进程组成员）' },
            pgid: { type: 'number', description: '按进程组 id 保留（来自 process_list）' },
          },
        },
      },
      {
        name: 'process_kill',
        description:
          '终止本回合用 bash 启动的后台进程（整组击杀，含 npm start 拉起的子进程树）。'
          + '三选一指定目标：port（推荐——直接按监听端口关服务）/ pid（组成员，杀其所在组）/ pgid（进程组 id，来自 process_list）。'
          + '只允许杀本回合自己启动的进程；沙箱内 bash kill/pkill 会被系统拦截（EPERM），关自己的服务一律用本工具。'
          + '注意：不 kill 时进程也会在回合结束时被平台统一回收——本工具用于回合内主动关闭（如释放端口重启服务）。',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'number', description: '按监听端口终止（推荐，如 8080）' },
            pid: { type: 'number', description: '按进程 id 终止（须为本回合启动的进程组成员）' },
            pgid: { type: 'number', description: '按进程组 id 终止（来自 process_list）' },
          },
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === 'process_list' || name === 'process_kill' || name === 'process_keep';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'process_list') return this.executeList(ctx);
    if (name === 'process_kill') return this.executeKill(args, ctx);
    if (name === 'process_keep') return this.executeKeep(args, ctx);
    throw new Error(`未知进程工具: ${name}`);
  }

  private async executeList(ctx: ToolContext): Promise<string> {
    const res = await requestProcessList(ctx.streamSessionId, ctx.workspaceId);
    if (res.groups.length === 0) {
      return '（本回合无存活的后台进程组，无保留服务）';
    }
    return res.groups
      .map((g) => {
        const head = g.kept
          ? `pgid ${g.pgid}${g.port !== undefined ? `（保留服务 :${g.port}）` : '（保留）'}`
          : `pgid ${g.pgid}`;
        return `${head}:\n` + g.members.map((mem) => `  pid ${mem.pid}  ${mem.command}`).join('\n');
      })
      .join('\n');
  }

  private async executeKill(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const target: { pgid?: number; pid?: number; port?: number } = {};
    if (args.port !== undefined) {
      if (typeof args.port !== 'number' || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
        throw new Error('参数 "port" 必须是 1-65535 的整数');
      }
      target.port = args.port;
    }
    if (args.pid !== undefined) {
      if (typeof args.pid !== 'number' || !Number.isInteger(args.pid) || args.pid < 1) {
        throw new Error('参数 "pid" 必须是正整数');
      }
      target.pid = args.pid;
    }
    if (args.pgid !== undefined) {
      if (typeof args.pgid !== 'number' || !Number.isInteger(args.pgid) || args.pgid < 1) {
        throw new Error('参数 "pgid" 必须是正整数');
      }
      target.pgid = args.pgid;
    }
    if (Object.keys(target).length === 0) {
      throw new Error('需要 port / pid / pgid 三选一');
    }
    const res = await requestProcessKill(ctx.streamSessionId, target, ctx.workspaceId);
    const parts = [`已终止 ${res.killedGroups} 个进程组`];
    if (res.refused.length > 0) {
      parts.push(`拒绝（非本回合进程/本工作空间保留服务）: ${res.refused.join('；')}`);
    }
    return parts.join('\n');
  }

  private async executeKeep(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const target: { pgid?: number; pid?: number; port?: number } = {};
    if (args.port !== undefined) {
      if (typeof args.port !== 'number' || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
        throw new Error('参数 "port" 必须是 1-65535 的整数');
      }
      target.port = args.port;
    }
    if (args.pid !== undefined) {
      if (typeof args.pid !== 'number' || !Number.isInteger(args.pid) || args.pid < 1) {
        throw new Error('参数 "pid" 必须是正整数');
      }
      target.pid = args.pid;
    }
    if (args.pgid !== undefined) {
      if (typeof args.pgid !== 'number' || !Number.isInteger(args.pgid) || args.pgid < 1) {
        throw new Error('参数 "pgid" 必须是正整数');
      }
      target.pgid = args.pgid;
    }
    if (Object.keys(target).length === 0) {
      throw new Error('需要 port / pid / pgid 三选一');
    }
    const res = await requestProcessKeep(ctx.streamSessionId, ctx.workspaceId, target);
    const addr = res.port !== undefined ? `（端口 ${res.port}）` : '';
    return `已保留进程组 pgid=${res.pgid}${addr}——回合结束后继续存活，用户验收后可用 process_kill 关闭；应用重启时自动回收`;
  }
}
