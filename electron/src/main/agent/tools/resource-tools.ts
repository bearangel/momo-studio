// electron/src/main/agent/tools/resource-tools.ts
//
// 资源创建工具模块（spec §5）：六个工具经 resource-ops 桥在主进程执行。
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
};

// 目录元数据：defaultOn=false = 非默认启用（资源创建属写操作，不进 Tier 1 公共默认集）
const CATALOG_META: Record<string, ToolMeta> = {
  resource_list: { displayName: '资源清单', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_agent: { displayName: '创建 Agent', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  add_agent_member: { displayName: '加工作空间成员', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_skill: { displayName: '创建技能', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_mcp: { displayName: '接入 MCP', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
  create_team: { displayName: '组建团队', category: '资源创建', categoryEmoji: '🧱', defaultOn: false },
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
          '创建 agent 定义（K8s 风格 YAML manifest 全文入参，格式见 create-agent 技能）。slug 全局唯一，冲突会拒绝；manifest 的 model 块必填（provider/model 填建议值；真实绑定走全局默认聊天模型兜底）。addToWorkspace=true 时同时加入当前工作空间。创建前必须向用户复述名称/slug/工具面。',
        inputSchema: {
          type: 'object',
          properties: {
            manifestYaml: { type: 'string', description: '完整 agent manifest YAML' },
            addToWorkspace: { type: 'boolean', description: '创建后加入当前工作空间（默认 false）' },
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
          '接入 MCP server（stdio 命令或 HTTP url 二选一）。落库前强制连通测试（initialize + tools/list），失败不落库并返回错误可修后重试。凭证只入配置不在回复回显。格式见 create-mcp 技能。',
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
