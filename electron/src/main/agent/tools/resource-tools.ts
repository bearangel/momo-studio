// electron/src/main/agent/tools/resource-tools.ts
//
// 资源工具模块（spec 2026-11-09 资源创建 + spec 2026-11-12 能力管理 §5）：
// 资源创建七工具 + 资源管理五工具，经 resource-ops 桥在主进程执行。
// workspaceId 不经工具入参——主进程侧从 spawn 上下文注入（子进程不可伪造）。
// callOp 构造注入：生产默认 requestResourceOp；测试注入 fake（momo-test-rules）。
import type { LLMToolDef } from '../llm-provider';
import type { ToolCatalogEntry, ToolMeta } from './catalog-entry';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog } from './catalog-entry';

type OpCaller = (op: string, args: Record<string, unknown>) => Promise<unknown>;

// 生产默认 op 调用器：动态 import 打破循环依赖（resource-ops-bridge → session-service
// → … → tools/catalog 会在本模块求值期间回环；eager import 会拿到部分导出，
// index.ts 注册时 new ResourceTools() 即 undefined）。桥在首次 execute 时才加载——
// 届时模块图已稳定；execute 本就 async，语义不变。
const defaultCallOp: OpCaller = (op, args) =>
  import('../resource-ops-bridge').then((m) => m.requestResourceOp(op, args));

/** 工具名 → op 名映射（单点，防漂移） */
const TOOL_TO_OP: Record<string, string> = {
  resource_list: 'list',
  create_agent: 'createAgent',
  add_agent_member: 'addMember',
  create_skill: 'createSkill',
  create_mcp: 'createMcp',
  create_team: 'createTeam',
  list_models: 'listModels',
  describe_agent: 'describeAgent',
  update_agent_capabilities: 'updateCapabilities',
  update_agent_profile: 'updateProfile',
  update_skill: 'updateSkill',
  update_mcp: 'updateMcp',
};

// 目录元数据：defaultOn=false = 非默认启用（资源创建属写操作，不进 Tier 1 公共默认集）；
// 资源管理五工具同档（spec 2026-11-12 §5.7——能力面变更工具更不进公共默认集）
const CATALOG_META: Record<string, ToolMeta> = {
  resource_list: { displayName: '资源清单', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_agent: { displayName: '创建 Agent', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  add_agent_member: { displayName: '加工作空间成员', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_skill: { displayName: '创建技能', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_mcp: { displayName: '接入 MCP', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_team: { displayName: '组建团队', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  list_models: { displayName: '查询模型清单', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  describe_agent: { displayName: '查看智能体', category: '资源管理', categoryEmoji: '🧱', defaultOn: false },
  update_agent_capabilities: {
    displayName: '调整智能体能力',
    category: '资源管理',
    categoryEmoji: '🧱',
    defaultOn: false,
    riskNote: '能力面变更，需用户确认',
  },
  update_agent_profile: { displayName: '编辑智能体档案', category: '资源管理', categoryEmoji: '🧱', defaultOn: false },
  update_skill: { displayName: '更新技能', category: '资源管理', categoryEmoji: '🧱', defaultOn: false },
  update_mcp: {
    displayName: '更新 MCP',
    category: '资源管理',
    categoryEmoji: '🧱',
    defaultOn: false,
    riskNote: '连接与凭证变更，需用户确认',
  },
};

export class ResourceTools implements ToolModule {
  constructor(private readonly callOp: OpCaller = defaultCallOp) {}

  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'resource_list',
        description:
          '列出当前工作空间的资源清单（agent 定义 / 工作空间成员 / 已装 skill / 已配 MCP / 已有团队）。创建任何资源前先调用盘点，防重复创建。可选 type 过滤：agents / members / skills / mcps / teams。',
        inputSchema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['agents', 'members', 'skills', 'mcps', 'teams'] } },
        },
      },
      {
        name: 'create_agent',
        description:
          '创建 agent 定义（K8s 风格 YAML manifest 全文入参，格式见 create-agent 技能）。slug 全局唯一，冲突会拒绝；manifest 的 model 块必填（provider/model 填建议值；真实绑定走全局默认聊天模型兜底）。manifest 的 model 块：provider 只接受 openai/anthropic（协议平台，取 list_models 的 platform 字段）；真实供应商绑定用本工具的 modelProviderId/modelName 入参（取 list_models 的 providerId/modelId）。addToWorkspace=true 时同时加入当前工作空间。创建前必须向用户复述名称/slug/工具面。',
        inputSchema: {
          type: 'object',
          properties: {
            manifestYaml: { type: 'string', description: '完整 agent manifest YAML' },
            addToWorkspace: { type: 'boolean', description: '创建后加入当前工作空间（默认 false）' },
            modelProviderId: { type: 'string', description: '真实供应商绑定 id（= list_models 返回的 providerId；可选，缺省走全局默认聊天模型）' },
            modelName: { type: 'string', description: '所选模型 id（= list_models 的 modelId，与 modelProviderId 成对传）' },
          },
          required: ['manifestYaml'],
        },
      },
      {
        name: 'add_agent_member',
        description: '把已有 agent 定义加入当前工作空间（幂等）。definitionIdOrSlug 可传 resource_list 查到的定义 id 或 slug。组建团队前用它补位。',
        inputSchema: {
          type: 'object',
          properties: { definitionIdOrSlug: { type: 'string' } },
          required: ['definitionIdOrSlug'],
        },
      },
      {
        name: 'create_skill',
        description:
          '安装技能（SKILL.md 全文入参，frontmatter 须含 name/description；slug 显式必填，小写字母数字连字符）。可选 references 附属文件。同名已装会拒绝。格式见 create-skill 技能。',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: '技能 slug（英文小写-连字符，全局唯一）' },
            skillMd: { type: 'string', description: 'SKILL.md 全文（含 frontmatter）' },
            references: {
              type: 'array',
              description: '附属文件（相对路径 + 内容）',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
              },
            },
          },
          required: ['slug', 'skillMd'],
        },
      },
      {
        name: 'create_mcp',
        description:
          '接入 MCP server（stdio 命令或 HTTP url 二选一）。落库前强制连通测试（initialize + tools/list），失败不落库并返回错误可修后重试。唯一例外：HTTP 401/403 判定为服务器要求 OAuth 授权——此时已落库并返回 needsAuthorization=true 与 notice，须把 notice 中的授权路径转告用户（授权须用户在应用内完成，agent 无法代劳），不得重试创建。凭证只入配置不在回复回显。格式见 create-mcp 技能。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'server 名（英文小写-连字符，全局唯一）' },
            transport: {
              type: 'object',
              description: 'stdio: { kind, command, args?, env? } 或 http: { kind, url, headers? }',
              properties: {
                kind: { type: 'string', enum: ['stdio', 'http'] },
                command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object' }, url: { type: 'string' }, headers: { type: 'object' },
              },
              required: ['kind'],
            },
          },
          required: ['name', 'transport'],
        },
      },
      {
        name: 'create_team',
        description:
          '组建团队（成员 ≥2，leader 必须在成员内）。memberInstanceIds 用 resource_list 查到的成员 instanceId。组建流程见 build-team 技能：先盘点、补位、向用户复述阵容再创建。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            iconEmoji: { type: 'string' },
            memberInstanceIds: { type: 'array', items: { type: 'string' } },
            leaderInstanceId: { type: 'string' },
          },
          required: ['name', 'memberInstanceIds', 'leaderInstanceId'],
        },
      },
      {
        name: 'list_models',
        description:
          '查询系统已配置的模型供应商与可用模型清单（含全局默认聊天模型 globalDefault）。创建 agent 需要选模型、用户问有哪些模型可用、或需要向用户复述模型选项时使用。返回不含 API 密钥。用户未指定时优先建议 globalDefault。providers[].providerId 供 create_agent 的 modelProviderId 入参使用；platform 供 manifest model 块的 provider 建议值使用。',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'describe_agent',
        description:
          '盘点定位：改动任何 agent 能力前先调用本工具看清现状。返回定义（defaultTools/defaultMcps/defaultSkills/deniedTools）、成员运行态、三层合并后的生效能力集（含能力来源归属）与跨工作空间成员数。agent 可传 instanceId 或 slug。免确认（只读），但拿结果向用户复述时照常复述。',
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string', description: 'instanceId 或 slug' } },
          required: ['agent'],
        },
      },
      {
        name: 'update_agent_capabilities',
        description:
          '调整 agent 能力（增量：终态 = 现状 ∪ add − remove，同 ref 同现 add+remove 时 remove 胜）。scope 缺省 member（只改当前工作空间成员的增量层，不动定义）；仅当用户明确要求「改定义本身 / 全局生效 / 影响所有工作空间」时才传 definition（builtin 定义会被拒绝）。add 与 remove 至少传其一，ref 必须是已知资源名（工具/技能/MCP/插件工具），非法 ref 会逐条报出且零落库。确认纪律：含任一 add 或 scope=definition 属扩权类操作，会弹用户确认卡——被拒后不得重试原请求，改向用户确认意图或改道纯 remove；纯 member 纯 remove 复述即可。restart 仅 member 分支生效（definition 分支恒停止运行实例）。改前先 describe_agent 盘点，改后把生效能力集回报用户。',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'instanceId 或 slug' },
            scope: { type: 'string', enum: ['member', 'definition'], description: '缺省 member；仅用户明确要求改定义本身才传 definition' },
            add: {
              type: 'object',
              description: '增量添加的引用（终态 = 现状 ∪ add − remove）',
              properties: {
                skills: { type: 'array', items: { type: 'string' } },
                mcps: { type: 'array', items: { type: 'string' } },
                tools: { type: 'array', items: { type: 'string' } },
                pluginTools: { type: 'array', items: { type: 'string' } },
              },
            },
            remove: {
              type: 'object',
              description: '增量移除的引用（同 ref 同现 add+remove 时 remove 胜）',
              properties: {
                skills: { type: 'array', items: { type: 'string' } },
                mcps: { type: 'array', items: { type: 'string' } },
                tools: { type: 'array', items: { type: 'string' } },
                pluginTools: { type: 'array', items: { type: 'string' } },
              },
            },
            restart: { type: 'string', enum: ['auto', 'deferred'], description: '缺省 auto；仅 member 分支生效' },
          },
          required: ['agent'],
        },
      },
      {
        name: 'update_agent_profile',
        description:
          '编辑 agent 定义档案（名称 / 描述 / systemPrompt / 图标 / 模型绑定 / deniedTools）。model 用 list_models 的 providerId/modelId；deniedTools 是整列覆盖不是增量。恒确认：任何字段都会弹用户确认卡（systemPrompt / model / deniedTools 都改变 agent 行为面，统一一档防轻字段绕档），被拒后不得重试，先与用户对齐意图。builtin 定义只读会被拒绝，改道向用户说明。改动会停止该定义的全部运行实例，需重启生效。',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'instanceId / slug / definitionId' },
            name: { type: 'string' },
            description: { type: 'string' },
            systemPrompt: { type: 'string' },
            iconEmoji: { type: 'string' },
            model: {
              type: 'object',
              description: '模型绑定（= list_models 的 providerId/modelId）',
              properties: { providerId: { type: 'string' }, modelName: { type: 'string' } },
              required: ['providerId', 'modelName'],
            },
            deniedTools: { type: 'array', items: { type: 'string' }, description: '工具禁用模式串，整列覆盖' },
          },
          required: ['agent'],
        },
      },
      {
        name: 'update_skill',
        description:
          '更新已安装技能（SKILL.md 全量替换——清目录重写 SKILL.md + references + 校验和，不做差量 patch；references 缺省保留不动）。仅 custom 源可改：builtin / marketplace 源会被拒绝，指引用户走应用内资源库界面；slug 不存在报错并指路 create_skill。恒确认：技能内容即 agent 行为注入，会弹用户确认卡，被拒后不得重试。返回挂此技能的成员数与 needsRestart（技能在 spawn 时注入，已挂成员需重启才生效）。',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            skillMd: { type: 'string', description: 'SKILL.md 全文（含 frontmatter）' },
            references: {
              type: 'array',
              description: '附属文件全量（相对路径 + 内容）',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
              },
            },
          },
          required: ['slug', 'skillMd'],
        },
      },
      {
        name: 'update_mcp',
        description:
          '更新已注册 MCP server 的 transport 配置（stdio 命令或 HTTP url 二选一，与 create_mcp 同形）。先测后落库：落库前强制连通测试（initialize + tools/list），失败零落库并返回错误可修后重试。唯一例外：HTTP 401/403 判定为要求 OAuth 授权——此时落库未绑定并返回 needsAuthorization 与授权路径，须转告用户在应用内完成授权，不得重试更新。凭证（headers/env）只入配置不在回复回显。恒确认：连接与凭证变更会弹用户确认卡，被拒后不得重试。name 不存在报错并指路 create_mcp。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '已注册的 server 名' },
            transport: {
              type: 'object',
              description: 'stdio: { kind, command, args?, env? } 或 http: { kind, url, headers? }（与 create_mcp 同形）',
              properties: {
                kind: { type: 'string', enum: ['stdio', 'http'] },
                command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object' }, url: { type: 'string' }, headers: { type: 'object' },
              },
              required: ['kind'],
            },
          },
          required: ['name', 'transport'],
        },
      },
    ];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), CATALOG_META);
  }

  handles(name: string): boolean {
    return name in TOOL_TO_OP;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<string> {
    const op = TOOL_TO_OP[name];
    if (!op) throw new Error(`未知资源工具: ${name}`);
    const result = await this.callOp(op, args ?? {});
    return JSON.stringify(result, null, 2);
  }
}
