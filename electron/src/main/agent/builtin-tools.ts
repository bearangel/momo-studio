// electron/src/main/agent/builtin-tools.ts
//
// 残余的 LLM 工具声明工具——非真正的「工具调用」，只是给 LLM 看的能力占位。
// 真正的工具实现（read_file / write_file / list_files）已在 v1.5 拆分到
// tools/file-tools.ts（Task 4）+ 通过 tools/index.ts 注册中心接入（Task 5）；
// 本文件只保留与 runtime 元数据强耦合的两类工具声明：
//
//   - getVirtualToolDefs：渐进式披露的 loadSkill / readResource 虚拟工具。
//     执行由 runtime-entry 内联处理（不经过 ToolModule 路由——Skill 索引已在 ctx.systemPrompt，
//     SkillRegistry 直接由 runtime-entry 调用 loadFull/loadResource）。
//   - getDispatchToolDefs：主 agent 给每个 sub agent 注册 dispatch:<slug> 工具。
//     执行也由 runtime-entry 内联处理（发 dispatch 消息 → 等 task_reply）。
//   - getOrchestrationToolDefs：v2.8.0 编排元语 5 工具面（followup / bg / gather /
//     status / cancel）。声明在此，执行体在 dispatch-wait.ts，路由同 runtime-entry。
//   - getBuiltinLoopToolDefs：task_complete 主动分段 / compact 上下文压缩两个
//     chat loop 内联工具的声明（执行逻辑在 runChatLoop 工具循环顶部，不走 ToolModule）。
//
//   Task 4 留下的 re-export shim 已在 Task 5 移除——getBuiltinToolDefs/executeBuiltinTool
//   已从 runtime-entry.ts 删除，此文件恢复精简声明。

import type { LLMToolDef } from './llm-provider';
import { SkillRegistry } from '../skill/registry';

/**
 * 子 agent 引用（仅主 agent 的 config 携带）。
 * 主 agent 据此为每个归属的 sub agent 构建一个 `dispatch:<slug>` 工具。
 */
export interface SubAgentRef {
  slug: string;
  /** 子 agent 的 assignmentId（dispatch 消息 dispatch_to 字段的值，v2 Task 10 起直接作 runners key） */
  assignmentId: string;
  description: string;
}

/**
 * 已安装 skill 引用（runtime config 携带）。
 * 子进程启动时据此把各 skill 注册到 SkillRegistry（渐进式披露的三层都需要）。
 */
export interface RuntimeSkillRef {
  /** skill slug（SkillRegistry 的 key，loadSkill 工具入参） */
  slug: string;
  /** skill 包在磁盘上的绝对路径（须含 SKILL.md） */
  cachePath: string;
}

/**
 * 渐进式披露虚拟工具定义（loadSkill / readResource）。
 * 仅当 registry 已注册至少一个 skill 时返回，避免向 LLM 暴露必然失败的虚拟工具。
 *
 * 这两个工具的「执行」没有真正的副作用——loadSkill 返回 SKILL.md 正文（Layer 2），
 * readResource 返回资源文件文本（Layer 3）——具体执行在 runtime-entry 的 executeTool 路由。
 */
export function getVirtualToolDefs(skillRegistry: SkillRegistry): LLMToolDef[] {
  if (skillRegistry.list().length === 0) return [];
  return [
    {
      name: 'loadSkill',
      description: '加载指定技能的完整指令到上下文。当任务匹配某技能描述时调用。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（slug）' } },
        required: ['name'],
      },
    },
    {
      name: 'readResource',
      description: '读取技能引用的附加资源文件。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名（slug）' },
          path: { type: 'string', description: '资源文件相对技能目录的路径' },
        },
        required: ['skill', 'path'],
      },
    },
  ];
}

/**
 * 为主 agent 构建 dispatch:<slug> 工具定义——每个归属的 sub agent 一个。
 * 仅主 agent 调用。执行时构建 dispatch 消息发到 team room 并等待 task_reply。
 */
export function getDispatchToolDefs(subAgents: SubAgentRef[]): LLMToolDef[] {
  return subAgents.map((sub) => ({
    name: `dispatch:${sub.slug}`,
    description: sub.description || `调度子 agent: ${sub.slug}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '分配给该子 agent 的任务描述' },
      },
      required: ['task'],
    },
  }));
}

/**
 * v2.8.0 Orchestration（Task 7，spec 2026-09-12 orchestration-primitives §5）：
 * 5 类编排工具定义——与 getDispatchToolDefs 同门注入（sessionSubs 非空的多成员
 * 会话 leader），执行体在 dispatch-wait.ts（T4/T6），路由在 runtime-entry
 * doExecuteTool。
 *   - 4 个静态名：dispatch_followup / dispatch_gather / dispatch_status / dispatch_cancel
 *   - dispatch_bg:<slug>：随 subAgents 动态生成（同 dispatch:<slug> 模式）
 * 描述面向 LLM 教学使用模式（bg 先派→干别的→gather 收 / 超时非错误 pending
 * 可再等 / cancel 长任务止损 / followup 仅用 dispatch 返回的 taskId——T6 review
 * M2 路由项：禁止 LLM 拿任务板 #T 序号或自造 ID 追问）。
 */
export function getOrchestrationToolDefs(subAgents: SubAgentRef[]): LLMToolDef[] {
  return [
    {
      name: 'dispatch_followup',
      description:
        '对已完成的 dispatch 任务追问。仅可使用 dispatch 返回的 taskId；子 agent 保留该链全部上下文续答，无需重述背景。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '此前 dispatch 返回的任务链 taskId' },
          question: { type: 'string', description: '追问内容' },
        },
        required: ['taskId', 'question'],
      },
    },
    ...subAgents.map((sub) => ({
      name: `dispatch_bg:${sub.slug}`,
      description: `非阻塞后台派发给 ${sub.description || sub.slug}：立即返回 { taskId } 句柄。使用模式：先派发（可多个）→ 继续其他工作 → 用 dispatch_gather 收割结果。`,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '分配给该子 agent 的任务描述' },
          toolBudget: { type: 'number', description: '该子任务的工具调用预算（可选）' },
        },
        required: ['task'],
      },
    })),
    {
      name: 'dispatch_gather',
      description:
        '收割后台任务句柄（dispatch_bg 返回的 taskId）。mode="all" 等全部完成、mode="any" 任一完成即返回。超时不是错误——返回 { done, pending }，pending 句柄保留可再次 gather。',
      inputSchema: {
        type: 'object',
        properties: {
          handles: { type: 'array', items: { type: 'string' }, description: '句柄 taskId 列表' },
          mode: {
            type: 'string',
            enum: ['all', 'any'],
            description: 'all=全部完成才返回 / any=任一完成即返回',
          },
          timeoutMs: { type: 'number', description: '等待上限毫秒（1000-600000，默认 120000）' },
        },
        required: ['handles', 'mode'],
      },
    },
    {
      name: 'dispatch_status',
      description:
        '查询单个后台句柄状态（in_flight / done / cancelled / not_found），可选携带结果与耗时。',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: '句柄 taskId' },
        },
        required: ['handle'],
      },
    },
    {
      name: 'dispatch_cancel',
      description:
        '取消在途后台任务（长任务止损）。幂等：已终态返回当前状态，不重复发中断。',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: '句柄 taskId' },
        },
        required: ['handle'],
      },
    },
  ];
}

/**
 * chat loop 内联处理的两个内置工具声明（Task 13 自 runtime-entry.ts 迁出）：
 *   - task_complete：LLM 主动分段——把当前累积文本作为一段持久化后继续输出，
 *     防长回复触发 PDU 截断丢失 thinking/tool_calls（最多 5 段）。
 *   - compact：harness 化压缩触发器（压缩改造 spec §6.1）——LLM 不再撰写摘要，
 *     结构化摘要由主进程 CompactionService 专用链路生成；本工具仅声明动机
 *     （可选 note，仅入审计），执行体在 runtime-entry compact 分支（尾部保留 +
 *     IPC 摘要 + 双态续行）。
 */
export function getBuiltinLoopToolDefs(): LLMToolDef[] {
  return [
    {
      name: 'task_complete',
      description: '完成本段回复并持久化为一条消息。当回复内容超过约 3KB 或完成阶段性子任务时调用，把当前累积文本作为一段发出，然后继续输出下一段。避免长回复触发 PDU 截断丢失 thinking/tool_calls。最多 5 段。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '本段内容（写入消息 body）',
          },
          nextStep: {
            type: 'string',
            description: '下一段的内容提示（仅用于分段连贯性，不是新任务授权；可选）',
          },
        },
        required: ['summary'],
      },
    },
    {
      name: 'compact',
      description:
        '触发系统级上下文压缩：由专用链路生成结构化摘要（目标/工作状态/下一步等固定节），无需你撰写总结。' +
        '压缩会保留最近若干轮原文。当用户明确要求压缩、或你判断上下文过长影响工作质量时调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '压缩动机备注（可选，仅入审计）' },
        },
      },
    },
  ];
}
