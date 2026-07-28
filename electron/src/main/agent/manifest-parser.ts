// electron/src/main/agent/manifest-parser.ts
//
// Declarative agent YAML manifest 解析器。
// 输入 K8s 风格的 YAML（apiVersion/kind/metadata/spec），校验必填字段后输出 AgentDefinition。
// 任何校验失败都会收集到错误列表一次性抛出，避免反复试错。

import { load } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, ModelRef, McpRef, SkillRef } from './types';

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
    // === M2 manifest schema 扩展 ===
    /**
     * 父 agent slug 引用（仅 type='sub' 时有意义）。
     * 注意：这里是 slug 字符串而非 UUID——builtin.ts 两阶段注册时会把 slug
     * 解析为已注册父 agent 的实际 id。YAML 编写时无法预知 UUID，故用 slug。
     */
    parentAgentId?: string;
    defaultMcps?: Array<{ kind?: string; ref?: string; versionRange?: string }>;
    defaultSkills?: Array<{ kind?: string; ref?: string; versionRange?: string }>;
  };
}

/** 支持的 agent 类型白名单 */
const ALLOWED_TYPES = new Set(['standalone', 'main', 'sub']);

/** 解析 YAML manifest 为 AgentDefinition。失败时抛出 Error。 */
export function parseAgentManifest(yamlContent: string): AgentDefinition {
  const raw = load(yamlContent) as RawManifest;
  const errors = validateRawManifest(raw);
  if (errors.length > 0) {
    throw new Error(`Agent manifest 校验失败:\n${errors.map((e) => '  - ' + e).join('\n')}`);
  }

  const spec = raw.spec!;
  const decl = spec.declarative!;
  const model = decl.model!;

  // type 缺省为 standalone；显式给出但不在白名单内则校验失败（防止 YAML 拼错）
  const type = (spec.type as AgentDefinition['type']) ?? 'standalone';

  return {
    id: randomUUID(),
    name: raw.metadata!.name!,
    slug: raw.metadata!.slug!,
    version: raw.metadata!.version!,
    type,
    runtime: 'declarative',
    systemPrompt: decl.systemPrompt!,
    model: {
      provider: model.provider as ModelRef['provider'],
      model: model.model!,
    },
    defaultTools: (spec.defaultTools ?? []).map((t) => ({
      kind: 'builtin' as const,
      ref: t.ref!,
    })),
    source: 'custom',
    description: raw.metadata!.description ?? '',
    iconEmoji: raw.metadata!.iconEmoji ?? '🤖',
    // parentAgentId 此处保留为 slug 字符串（YAML 原值）；builtin.ts 注册阶段
    // 会把它解析为父 agent 的实际 UUID。非 sub 类型或未声明时为 undefined。
    parentAgentId: spec.parentAgentId,
    defaultMcps: (spec.defaultMcps ?? []).map(parseMcpRef),
    defaultSkills: (spec.defaultSkills ?? []).map(parseSkillRef),
  };
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

  // type 白名单校验：缺省时 parseAgentManifest 回退 standalone，此处只校验显式非法值
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
