// electron/src/main/agent/tools/memory-tools.ts
// v2.2 记忆 P2 Task 2（spec §6.2）：agent 记忆三工具。
//   - memory_save：source='agent'；scope 缺省 'workspace'（ctx.workspaceId）；
//     session 层须 ctx.roomId 归属校验（无会话上下文禁止写 session 层）
//   - memory_search：走 getMemoryProvider().searchMemories（命中自动递增
//     use_count / 更新 last_used_at，provider 契约）；子 agent 不检索 session 层
//     （fresh-session 对齐，spec §6.3：parentStreamSessionId 非空 → sessionId=null）
//   - memory_forget：仅 source='agent'|'auto' 可删；user 条目拒绝删除（用户主权）
//
// 审计裁定：写操作（save / forget）在模块层走 logToolCall（参数形态与
// runtime-entry 统一路由一致：inputSummary=参数 JSON / outputSummary=输出文本 /
// success / durationMs）；读操作（search）不在模块层重复审计——生产链路所有
// 注册中心工具调用已由 runtime-entry executeTool 的 try/finally 统一记录，
// 模块层只对敏感的记忆写操作追加一条落点审计。
//
// sourceDetail 裁定：ToolContext 现有字段不携带 agent 名（见 types.ts），故用
// streamSessionId（本次 agent 运行的唯一流 id）作溯源标识——`agent:<streamSessionId>`，
// 可经 message_events 流日志反查到具体 agent 运行。
//
// 不提供 memory_update（spec §6.2 v2.2 取舍）：更新 = 删旧 + 存新两步，
// 规避改坏用户条目的边界判定复杂化。

import { getMemoryProvider } from '../../memory';
import { getMemory } from '../../storage/memories/repo';
import type { MemoryEntry, SaveMemoryInput } from '../../storage/memories/repo';
import type { LLMToolDef } from '../llm-provider';
import { logToolCall } from './shared/audit';
import { parseStringArg } from './shared/arg-parse';
import type { ToolContext, ToolModule } from './types';

/** 合法 kind 白名单（与 memories 表 CHECK 约束同集） */
const KINDS = ['rule', 'preference', 'knowledge', 'summary'] as const;
/** 合法 scope 白名单（三层记忆） */
const SCOPES = ['global', 'workspace', 'session'] as const;
/** memory_search 缺省返回条数（spec §6.2：BM25 top-N 缺省 10） */
const SEARCH_LIMIT_DEFAULT = 10;
/** memory_search 单次上限（防 LLM 传巨大 limit 撑爆上下文） */
const SEARCH_LIMIT_MAX = 50;
/** 检索结果内容预览截断长度（spec §6.2：前 120 字） */
const PREVIEW_MAX = 120;

/**
 * 校验 value 属于白名单并收窄类型；非法时抛错（错误信息含字段名与合法值，
 * 给 LLM 明确的纠正反馈——与 parseStringArg 同风格）。
 */
function assertOneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`参数 "${name}" 非法：${value}（合法值：${allowed.join(' / ')}）`);
  }
  return value as T;
}

/** 写操作审计包装：计时 + 成功/失败均记一条（形态同 runtime-entry 统一路由） */
async function audited(
  toolName: string,
  args: Record<string, unknown>,
  fn: () => Promise<string>,
): Promise<string> {
  const startTime = Date.now();
  let success = true;
  let output = '';
  try {
    output = await fn();
    return output;
  } catch (err) {
    success = false;
    output = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    logToolCall({
      toolName,
      inputSummary: JSON.stringify(args),
      outputSummary: output,
      success,
      durationMs: Date.now() - startTime,
    });
  }
}

/** 记忆工具模块——v2.2 ToolModule 接口实现，经 tools/index.ts 注册中心登记。 */
export class MemoryTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'memory_save',
        description:
          '保存一条长期记忆供后续任务复用。kind：rule=规范 / preference=偏好 / knowledge=知识 / summary=摘要'
          + '（rule 与 preference 默认常驻注入每轮上下文）。scope 缺省 workspace（当前工作空间）；'
          + 'global=跨工作空间共享；session=仅本会话可见。',
        inputSchema: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              description: '记忆类型',
              enum: [...KINDS],
            },
            content: { type: 'string', description: '记忆内容（一句话、自包含，后续任务可直接理解）' },
            tags: { type: 'array', items: { type: 'string' }, description: '可选标签（检索辅助）' },
            scope: { type: 'string', description: '记忆层级', enum: [...SCOPES] },
          },
          required: ['kind', 'content'],
        },
      },
      {
        name: 'memory_search',
        description:
          'BM25 全文检索既有记忆（全局 + 当前工作空间 + 本会话三层并集），返回 top-N'
          + `（缺省 ${SEARCH_LIMIT_DEFAULT} 条）：每条含 id / kind / 内容前 ${PREVIEW_MAX} 字。命中条目自动计入使用热度。`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词' },
            scope: { type: 'string', description: '可选：限定层级', enum: [...SCOPES] },
            limit: { type: 'number', description: `返回条数上限（缺省 ${SEARCH_LIMIT_DEFAULT}，最大 ${SEARCH_LIMIT_MAX}）` },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_forget',
        description:
          '删除一条 agent / auto 来源的过时记忆。用户手动创建的记忆只能由用户在设置中删除（工具会拒绝）。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '记忆条目 id（来自 memory_save 返回或 memory_search 结果）' },
          },
          required: ['id'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === 'memory_save' || name === 'memory_search' || name === 'memory_forget';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'memory_save') return audited(name, args, () => this.executeSave(args, ctx));
    if (name === 'memory_search') return this.executeSearch(args, ctx);
    if (name === 'memory_forget') return audited(name, args, () => this.executeForget(args));
    throw new Error(`未知记忆工具: ${name}`);
  }

  /** memory_save：写操作（source='agent'） */
  private async executeSave(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const kind = assertOneOf(parseStringArg(args.kind, 'kind'), KINDS, 'kind');
    const content = parseStringArg(args.content, 'content');
    if (content.trim() === '') throw new Error('参数 "content" 不能为空');

    let tags: string[] | undefined;
    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== 'string')) {
        throw new Error('参数 "tags" 必须是字符串数组');
      }
      tags = args.tags as string[];
    }

    const scopeArg = args.scope === undefined ? 'workspace' : parseStringArg(args.scope, 'scope');
    const scope = assertOneOf(scopeArg, SCOPES, 'scope');

    // 三层归属：global 跨工作空间 / workspace 绑 ctx.workspaceId / session 绑 ctx.roomId。
    // session 层归属校验：无会话上下文（roomId 为空，如后台任务）禁止写 session 层。
    if (scope === 'session' && !ctx.roomId) {
      throw new Error('scope=session 需要会话上下文（当前不在任何会话中）');
    }

    const input: SaveMemoryInput = {
      scope,
      workspaceId: scope === 'global' ? null : ctx.workspaceId,
      sessionId: scope === 'session' ? ctx.roomId : null,
      kind,
      content,
      tags,
      source: 'agent',
      // ToolContext 无 agent 名字段——溯源用本次运行唯一流 id（见文件头裁定注释）
      sourceDetail: `agent:${ctx.streamSessionId}`,
    };
    const entry = await getMemoryProvider().saveMemory(input);
    return `已保存记忆（id=${entry.id}，kind=${entry.kind}，常驻=${entry.pinned ? '是' : '否'}）`;
  }

  /** memory_search：读操作（走 provider，命中自动递增 use_count） */
  private async executeSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const query = parseStringArg(args.query, 'query');
    if (query.trim() === '') throw new Error('参数 "query" 不能为空');

    // 可选 scope 过滤：provider 检索是三层并集，限定层在结果侧收窄
    // （use_count 已对全部真实命中递增，过滤只影响展示）
    let scopeFilter: MemoryEntry['scope'] | undefined;
    if (args.scope !== undefined) {
      scopeFilter = assertOneOf(parseStringArg(args.scope, 'scope'), SCOPES, 'scope');
    }

    let limit = SEARCH_LIMIT_DEFAULT;
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
        throw new Error(`参数 "limit" 必须是正整数（1-${SEARCH_LIMIT_MAX}）`);
      }
      limit = Math.min(args.limit, SEARCH_LIMIT_MAX);
    }

    // 子 agent fresh-session 对齐（spec §6.3）：parentStreamSessionId 非空不带会话记忆
    const sessionId = ctx.parentStreamSessionId ? null : ctx.roomId || null;
    let hits = await getMemoryProvider().searchMemories(
      query,
      { workspaceId: ctx.workspaceId, sessionId },
      limit,
    );
    if (scopeFilter) hits = hits.filter((h) => h.scope === scopeFilter);

    if (hits.length === 0) return '（无命中记忆。可换个关键词重试，或用 memory_save 保存新记忆）';
    return hits
      .map((h) => {
        // MemoryEntry 无 score 字段——按 plan「score 无则省」不输出
        const preview = h.content.length > PREVIEW_MAX ? `${h.content.slice(0, PREVIEW_MAX)}…` : h.content;
        return `${h.id} | ${h.kind} | ${preview}`;
      })
      .join('\n');
  }

  /** memory_forget：写操作（用户主权——user 条目拒删） */
  private async executeForget(args: Record<string, unknown>): Promise<string> {
    const id = parseStringArg(args.id, 'id');
    // 按 id 读条目：MemoryProvider 接口冻结（无按 id 读方法），经 repo 直查
    const entry = getMemory(id);
    if (!entry) throw new Error(`记忆不存在: ${id}`);
    if (entry.source === 'user') {
      throw new Error('用户记忆只能由用户在设置中删除');
    }
    await getMemoryProvider().deleteMemory(id);
    return `已遗忘记忆（id=${id}，kind=${entry.kind}）`;
  }
}
