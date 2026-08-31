// electron/src/main/agent/manifest-parser.ts
//
// Declarative agent YAML manifest 解析器。
// 输入 K8s 风格的 YAML（apiVersion/kind/metadata/spec），校验必填字段后输出 AgentDefinition。
// 任何校验失败都会收集到错误列表一次性抛出，避免反复试错。
//
// v1.3：YAML 仍可写 type/parentAgentId/model.provider 字段（向后兼容），
// 但这些字段不进 DB（DB schema 已删除），而是路由到 ParsedManifest.suggestion
// 供 builtin 加载时填充内存建议 Map（UI 默认值用）。

import { load } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  BuiltinSuggestion,
  McpRef,
  SkillRef,
} from './types';

/** YAML manifest 原始结构（解析后的弱类型形态，仅用于校验阶段） */
interface RawManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    slug?: string;
    version?: string;
    description?: string;
    iconEmoji?: string;
  };
  spec?: {
    type?: string;
    runtime?: string;
    declarative?: {
      systemPrompt?: string;
      model?: {
        provider?: string;
        model?: string;
      };
    };
    defaultTools?: Array<{ kind?: string; ref?: string }>;
    /** 父 agent slug 引用（仅 type='sub' 时有意义；builtin.ts 解析为 defId） */
    parentAgentId?: string;
    defaultMcps?: Array<{ kind?: string; ref?: string; versionRange?: string }>;
    defaultSkills?: Array<{ kind?: string; ref?: string; versionRange?: string }>;
  };
}

/** 支持的 agent 类型白名单 */
const ALLOWED_TYPES = new Set(['standalone', 'main', 'sub']);

/** parseAgentManifestWithSuggestion 的返回值：DB 字段 + UI 建议字段 */
export interface ParsedManifest {
  def: AgentDefinition;
  suggestion: BuiltinSuggestion;
}

/**
 * 解析 YAML manifest 为 v1.3 AgentDefinition。
 * 返回的 def 不含 type/parent/model.provider 字段（已从 schema 删除）；
 * 这些信息只在 parseAgentManifestWithSuggestion 的 suggestion 字段中保留供 UI 用。
 */
export function parseAgentManifest(yamlContent: string): AgentDefinition {
  return parseAgentManifestWithSuggestion(yamlContent).def;
}

/** 解析 YAML manifest，附带建议字段（builtin 加载用）。失败时抛出 Error。 */
export function parseAgentManifestWithSuggestion(yamlContent: string): ParsedManifest {
  const raw = load(yamlContent) as RawManifest;
  const errors = validateRawManifest(raw);
  if (errors.length > 0) {
    throw new Error(`Agent manifest 校验失败:\n${errors.map((e) => '  - ' + e).join('\n')}`);
  }

  const spec = raw.spec!;
  const decl = spec.declarative!;
  const model = decl.model!;

  const def: AgentDefinition = {
    id: randomUUID(),
    name: raw.metadata!.name!,
    slug: raw.metadata!.slug!,
    version: raw.metadata!.version!,
    runtime: 'declarative',
    systemPrompt: decl.systemPrompt!,
    defaultTools: (spec.defaultTools ?? []).map((t) => ({
      kind: 'builtin' as const,
      ref: t.ref!,
    })),
    source: 'custom',
    description: raw.metadata!.description ?? '',
    iconEmoji: raw.metadata!.iconEmoji ?? '🤖',
    defaultMcps: (spec.defaultMcps ?? []).map(parseMcpRef),
    defaultSkills: (spec.defaultSkills ?? []).map(parseSkillRef),
    // v1.3 新字段：YAML 加载时默认 global + provider 未配置（用户后续配置）
    workspaceId: null,
    modelProviderId: null,
    modelName: model.model!,
  };

  // v25：去编排——suggestion 不再携带角色建议（type 仅向后兼容可写，不消费）
  const suggestion: BuiltinSuggestion = {
    suggestedParentDefId: spec.parentAgentId,
    suggestedPlatform: model.provider as 'openai' | 'anthropic',
  };

  return { def, suggestion };
}

/** 解析单条 MCP 引用，ref 缺失时抛错（避免静默吞掉无效条目） */
function parseMcpRef(t: { kind?: string; ref?: string; versionRange?: string }): McpRef {
  if (!t.ref) throw new Error('defaultMcps 条目缺少 ref 字段');
  return { kind: 'mcp', ref: t.ref, versionRange: t.versionRange };
}

/** 解析单条 Skill 引用，ref 缺失时抛错 */
function parseSkillRef(t: { kind?: string; ref?: string; versionRange?: string }): SkillRef {
  if (!t.ref) throw new Error('defaultSkills 条目缺少 ref 字段');
  return { kind: 'skill', ref: t.ref, versionRange: t.versionRange };
}

/** 收集 manifest 的所有校验错误（不短路，便于一次性反馈给用户） */
function validateRawManifest(raw: RawManifest): string[] {
  const errors: string[] = [];
  if (raw.apiVersion !== 'v1') errors.push('apiVersion 必须为 "v1"');
  if (raw.kind !== 'AgentDefinition') errors.push('kind 必须为 "AgentDefinition"');
  if (!raw.metadata?.name) errors.push('metadata.name 不能为空');
  if (!raw.metadata?.slug) errors.push('metadata.slug 不能为空');
  if (!raw.spec?.declarative?.systemPrompt) errors.push('spec.declarative.systemPrompt 不能为空');
  if (!raw.spec?.declarative?.model?.provider) errors.push('spec.declarative.model.provider 不能为空');
  if (!raw.spec?.declarative?.model?.model) errors.push('spec.declarative.model.model 不能为空');

  const provider = raw.spec?.declarative?.model?.provider;
  if (provider && provider !== 'openai' && provider !== 'anthropic') {
    errors.push(`model.provider 仅支持 "openai" 或 "anthropic"，收到 "${provider}"`);
  }

  // type 白名单校验：缺省时 parseAgentManifestWithSuggestion 回退 standalone，此处只校验显式非法值
  const type = raw.spec?.type;
  if (type !== undefined && !ALLOWED_TYPES.has(type)) {
    errors.push(`spec.type 仅支持 "standalone" / "main" / "sub"，收到 "${type}"`);
  }

  // parentAgentId 语义校验：仅 sub 类型应声明；非 sub 声明视为错误（避免误配）
  if (raw.spec?.parentAgentId && type !== 'sub') {
    errors.push('spec.parentAgentId 仅 type="sub" 的 agent 可声明');
  }
  return errors;
}
