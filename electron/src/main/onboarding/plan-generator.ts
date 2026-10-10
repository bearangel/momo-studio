// electron/src/main/onboarding/plan-generator.ts
//
// AI 路线方案生成（spec 2026-10-10 §6.1）：单次非流式 chat 直调 LLM
// （session-naming 同款 createLLMProvider 先例），60s 独立超时（不复用
// 300s 全局值），解析失败静默修复一轮。LLM 依赖经 PlanDeps 注入
// （测试保真边界在 LLMResponse 形状）。
import type { LLMMessage, LLMResponse } from '../agent/llm-provider';
import { createLLMProvider } from '../agent/llm-provider';
import { getProvider, getProviderApiKey } from '../agent/provider-crud';
import { listBuiltinPresetAgents, previewBuiltinPresetAgent } from '../agent/builtin';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled } from '../skill/zip-uploader';
import { sanitizePlan, type OnboardingPlan } from './plan-types';

/** 引导 LLM 调用独立超时（spec §6.1：引导场景等不了 300s 全局值） */
export const ONBOARDING_LLM_TIMEOUT_MS = 60_000;

/** 需求文本上限（spec §5 GenerateOnboardingPlanInput 注释） */
export const MAX_REQUIREMENT_CHARS = 4000;

/** LLM 调用注入点：生产 = createLLMProvider 包装；测试 = 直接给实现 */
export interface PlanDeps {
  callLlm: (messages: LLMMessage[]) => Promise<LLMResponse>;
}

/** prompt 上下文：预制 agent 预览 + MCP/skill 白名单 */
export interface PlanPromptContext {
  requirement: string;
  presets: Array<{
    slug: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    mcps: string[];
    skills: string[];
    iconEmoji: string;
  }>;
  mcpNames: string[];
  skills: Array<{ slug: string; name: string; description: string }>;
}

/** 剥离 markdown 代码围栏与前后杂文（LLM 常见输出形态容错） */
export function stripJsonFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return body.trim();
  return body.slice(start, end + 1);
}

/** 组装 prompt（纯函数，供测试直接断言） */
export function buildPlanPrompt(ctx: PlanPromptContext): { system: string; user: string } {
  const system = [
    '你是 Momo Studio（桌面端多 agent 协作平台）的新装配置助手。',
    '根据用户的工作需求，从「预置 agent 清单」中选择启用的 agent；仅当预置无法满足时才设计自定义 agent。',
    'MCP 与 skill 只能从「可挂载资源白名单」中选择，禁止编造名单外的名字。',
    '输出严格为一个 JSON 对象，不要输出任何其他文字。schema：',
    '{',
    '  "agents": [ 1~5 个元素，二选一：',
    '    {"kind":"preset","slug":"<预置清单中的 slug>","reason":"中文一句话理由","mcps":["<白名单 MCP 名>"],"skills":["<白名单 skill slug>"]}',
    '    {"kind":"custom","name":"<名称>","iconEmoji":"<一个 emoji>","systemPrompt":"<完整中文系统提示词>","toolPreset":"standard"|"all","reason":"中文一句话理由","mcps":[],"skills":[]}',
    '  ],',
    '  "defaultAgentIndex": <默认会话 agent 在 agents 数组的下标>',
    '}',
    '',
    '预置 agent 清单：',
    ...ctx.presets.map(
      (p) =>
        `- slug=${p.slug} 名称=${p.name} 描述=${p.description} 已有工具=${p.tools.join(',')} 已有MCP=${p.mcps.join(',')} 已有skill=${p.skills.join(',')}`,
    ),
    '',
    '可挂载 MCP 白名单：' + (ctx.mcpNames.join(', ') || '（空，mcps 一律给 []）'),
    '可挂载 skill 白名单：' +
      (ctx.skills.map((s) => `${s.slug}(${s.name}:${s.description})`).join(', ') ||
        '（空，skills 一律给 []）'),
  ].join('\n');
  const user = `我的工作需求：${ctx.requirement}`;
  return { system, user };
}

/** 从代码库现取 sanitize 白名单上下文（spec §7：白名单来自注册表/安装表） */
function buildSanitizeContext() {
  return {
    presetSlugs: listBuiltinPresetAgents().map((p) => p.slug),
    mcpNames: listRegistered().map((m) => m.name),
    skillSlugs: listInstalled().map((s) => s.slug),
  };
}

/** 解析 LLM 响应为 OnboardingPlan（结构复验在 sanitizePlan 内） */
function parsePlanResponse(content: string): OnboardingPlan {
  const plan: unknown = JSON.parse(stripJsonFence(content));
  if (typeof plan !== 'object' || plan === null) {
    throw new Error('方案不是 JSON 对象');
  }
  return plan as OnboardingPlan;
}

/**
 * 生成配置方案（onboarding:generatePlan 数据面）。
 * 流程：需求截断 → provider/key 校验 → 单次 chat（60s race 超时）
 * → 解析失败静默修复一轮 → sanitize 白名单过滤。
 */
export async function generateOnboardingPlan(
  input: { requirement: string; providerId: string; modelId: string },
  deps?: PlanDeps,
): Promise<{ plan: OnboardingPlan; warnings: string[] }> {
  const requirement = input.requirement.trim().slice(0, MAX_REQUIREMENT_CHARS);
  if (!requirement) throw new Error('需求描述不能为空');

  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`供应商不存在: ${input.providerId}`);
  const apiKey = await getProviderApiKey(input.providerId);
  if (!apiKey) throw new Error('供应商 API key 未配置，请回到上一步检查');

  const callLlm =
    deps?.callLlm ??
    (async (messages: LLMMessage[]): Promise<LLMResponse> => {
      const llm = createLLMProvider(
        { provider: provider.platform, model: input.modelId, baseUrl: provider.baseUrl },
        apiKey,
      );
      // 60s 外层 race：底层请求由模块级 300s 兜底终止，结果被丢弃即可
      return Promise.race([
        llm.chat(messages),
        new Promise<LLMResponse>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error('AI 生成超时（60s），建议换更快的模型（如 flash 档）后重试'),
              ),
            ONBOARDING_LLM_TIMEOUT_MS,
          ),
        ),
      ]);
    });

  const ctx: PlanPromptContext = {
    requirement,
    presets: listBuiltinPresetAgents().map((p) => {
      const pv = previewBuiltinPresetAgent(p.slug);
      return {
        slug: pv.slug,
        name: pv.name,
        description: p.description,
        systemPrompt: pv.systemPrompt,
        tools: pv.tools,
        mcps: pv.mcps,
        skills: pv.skills,
        iconEmoji: pv.iconEmoji,
      };
    }),
    mcpNames: listRegistered().map((m) => m.name),
    skills: listInstalled().map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description,
    })),
  };
  const { system, user } = buildPlanPrompt(ctx);

  // 第一轮
  let response = await callLlm([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  let parsed: OnboardingPlan;
  try {
    parsed = parsePlanResponse(response.content);
  } catch {
    // 静默修复一轮：原响应 + 纠错指令重发
    response = await callLlm([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: '你上一条回复不是合法 JSON。请只输出符合 schema 的 JSON 对象，不要有任何其他文字。',
      },
    ]);
    try {
      parsed = parsePlanResponse(response.content);
    } catch {
      throw new Error('AI 生成的方案格式无效，请重试或转手动配置');
    }
  }

  const { plan, warnings } = sanitizePlan(parsed, buildSanitizeContext());
  if (!plan) throw new Error(`方案过滤后无可应用项：${warnings.join('；')}`);
  return { plan, warnings };
}
