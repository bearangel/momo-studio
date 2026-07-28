// electron/src/main/agent/manifest-parser.ts
//
// Declarative agent YAML manifest 解析器。
// 输入 K8s 风格的 YAML（apiVersion/kind/metadata/spec），校验必填字段后输出 AgentDefinition。
// 任何校验失败都会收集到错误列表一次性抛出，避免反复试错。

import { load } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, ModelRef } from './types';

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
  };
}

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

  return {
    id: randomUUID(),
    name: raw.metadata!.name!,
    slug: raw.metadata!.slug!,
    version: raw.metadata!.version!,
    type: (spec.type as AgentDefinition['type']) ?? 'standalone',
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
    // M2 字段：parentAgentId / defaultMcps / defaultSkills 的 YAML schema 解析
    // 留待后续 task（manifest schema 升级）；此处保持最小可用默认。
    parentAgentId: undefined,
    defaultMcps: [],
    defaultSkills: [],
  };
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
  return errors;
}
