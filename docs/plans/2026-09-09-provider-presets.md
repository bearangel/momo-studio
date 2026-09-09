# 供应商预设与模型思维模式配置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 供应商新建时可一键选择预设（15 家，预填连接信息 + 种子模型），模型列表支持思维模式配置（模型级默认 + agent 级覆盖），LLM 请求体按 wire 方言注入 thinking 参数。

**Architecture:** 手写预设目录（`provider-presets.ts`）+ 正则目录升级（`model-catalog.ts` 补 reasoning 能力）双层 resolve；`thinking_json` 两级配置（`provider_models` / `agent_definitions`）经 `resolveThinkingConfig` 单点定型进 `AGENT_CONFIG`；`createLLMProvider` 实例级持有，四种 wire 方言（`toggle` / `toggle-effort` / `effort` / `anthropic-budget`）映射到请求体。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React renderer（Vite + zustand）、vitest 双 workspace。

**Spec:** `docs/specs/2026-09-09-provider-presets-design.md`（已评审批准）

## Global Constraints

- **Node 20 LTS**：容器默认 Node 26，任何命令前先 `nvm use 20`（better-sqlite3 ABI）。
- **包管理**：一律 `npx pnpm@9.0.0 <cmd>`。
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）。
- **注释一律中文**；Conventional Commits（`feat:` / `test:` / `docs:`）。
- **测试存放**：electron 单测集中 `electron/tests/**`（子目录镜像 src）；renderer 单测贴源 colocated。
- **UI**：语义 token、`components/ui/` 原子件、lucide-react 16px / stroke 1.75、禁 emoji 图标、禁标准 Tailwind 色阶与 inline 硬编码颜色。
- **Skills**：改 IPC / 跨模块数据流前加载 `momo-boundary-rules`；写测试前加载 `momo-test-rules`。
- **既有 resolve 语义**：用户覆盖列 → 预设模型表 → 正则目录 → null（未知 fail-safe）；spawn 时定型，之后改动下次 spawn 生效。

---

### Task 1: 预设目录 provider-presets.ts

**Files:**
- Create: `electron/src/main/llm/provider-presets.ts`
- Test: `electron/tests/llm/provider-presets.test.ts`

**Interfaces:**
- Produces: `ThinkingWire` / `ReasoningCapability` / `ThinkingConfig` / `ThinkingRequest` 类型；`PROVIDER_PRESETS` 常量；`listProviderPresets()` / `getProviderPreset(key)` / `getPresetModel(key, modelId)` / `parseThinkingConfig(raw)` / `isThinkingRequest(v)`——后续所有任务消费。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/llm/provider-presets.test.ts
//
// 预设目录数据完整性（spec §9）：schema 合法性机械强制——
// 手写目录随版本发布，错误在测试层拦截，不流入运行时。
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  getPresetModel,
  parseThinkingConfig,
  isThinkingRequest,
} from '../../src/main/llm/provider-presets';

const WIRES = ['toggle', 'toggle-effort', 'effort', 'anthropic-budget'];

describe('provider-presets 数据完整性', () => {
  it('key 全局唯一', () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('baseUrl 全部合法 http(s) URL', () => {
    for (const p of PROVIDER_PRESETS) {
      const u = new URL(p.baseUrl); // 非法即抛
      expect(['http:', 'https:']).toContain(u.protocol);
    }
  });

  it('每家：platform 合法、方言合法、模型 id 供应商内唯一', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(['openai', 'anthropic']).toContain(p.platform);
      expect(WIRES).toContain(p.thinkingWire);
      const ids = p.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('每模型：窗口正整数、能力形状合法、default ∈ values', () => {
    for (const p of PROVIDER_PRESETS) {
      for (const m of p.models) {
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.outputTokens).toBeGreaterThan(0);
        if (m.reasoning.kind === 'effort') {
          expect(m.reasoning.values.length).toBeGreaterThan(0);
          expect(m.reasoning.values).toContain(m.reasoning.default);
        }
        if (m.thinkingWire !== undefined) expect(WIRES).toContain(m.thinkingWire);
      }
    }
  });

  it('fetchListHint 商无预设模型（聚合/本地商引导拉取）', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.fetchListHint) expect(p.models).toHaveLength(0);
    }
  });

  it('收录 ≥15 家且覆盖用户点名的 glm/deepseek/moonshot', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(15);
    for (const k of ['zhipu', 'deepseek', 'moonshot']) {
      expect(getProviderPreset(k)).not.toBeNull();
    }
  });
});

describe('查找与解析', () => {
  it('getProviderPreset 未知 key 返回 null', () => {
    expect(getProviderPreset('nope')).toBeNull();
  });
  it('getPresetModel 命中预设模型（kimi-k3 带方言覆写）', () => {
    const m = getPresetModel('moonshot', 'kimi-k3');
    expect(m?.thinkingWire).toBe('effort');
    expect(m?.reasoning.kind).toBe('effort');
  });
  it('parseThinkingConfig：合法形状 / 非法返回 null', () => {
    expect(parseThinkingConfig({ mode: 'auto', effort: null })).toEqual({ mode: 'auto', effort: null });
    expect(parseThinkingConfig({ mode: 'on', effort: 'high' })).toEqual({ mode: 'on', effort: 'high' });
    expect(parseThinkingConfig({ mode: 'off', effort: 'high' })).toEqual({ mode: 'off', effort: null });
    expect(parseThinkingConfig(null)).toBeNull();
    expect(parseThinkingConfig({ mode: 'bad' })).toBeNull();
    expect(parseThinkingConfig('x')).toBeNull();
  });
  it('isThinkingRequest：结构守卫', () => {
    expect(isThinkingRequest({ wire: 'effort', kind: 'effort', mode: 'on', effort: 'low' })).toBe(true);
    expect(isThinkingRequest({ wire: 'bad', kind: 'effort', mode: 'on', effort: 'low' })).toBe(false);
    expect(isThinkingRequest(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/llm/provider-presets.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 provider-presets.ts**

```typescript
// electron/src/main/llm/provider-presets.ts
//
// 供应商预设目录（spec 2026-09-09-provider-presets §2）。
// 手写静态目录，随版本发布；用户覆盖列（provider_models.context_window /
// thinking_json）是目录错误时的修正通道。
//
// 数字查证：zhipu/deepseek/moonshot/openai/anthropic 五家按 2026-09-09 官方
// 文档查证（见 spec 附录 A）；dashscope/volcano-ark/gemini/xai/mistral/groq
// 为保守初值（不带思维能力声明），实施时按 Task 1 Step 4 文档清单复核。

/** 思维模式 wire 方言：决定请求体注入格式（spec §5.2 映射表） */
export type ThinkingWire = 'toggle' | 'toggle-effort' | 'effort' | 'anthropic-budget';

/** 模型思维模式能力词汇表（Cherry Studio ReasoningControl 精髓子集） */
export type ReasoningCapability =
  | { kind: 'none' }
  | { kind: 'toggle' }
  | { kind: 'effort'; values: readonly string[]; default: string };

/** 用户可配置的思维模式（provider_models / agent_definitions 的 thinking_json） */
export interface ThinkingConfig {
  /** auto=不发参数（厂商默认）；off=显式关闭；on=开启 */
  mode: 'auto' | 'off' | 'on';
  /** mode='on' 且模型 kind='effort' 时的档位；其余为 null */
  effort: string | null;
}

/** AGENT_CONFIG 定型后的思维配置（resolveThinkingConfig 产出，spawn 时快照） */
export interface ThinkingRequest {
  wire: ThinkingWire;
  kind: 'none' | 'toggle' | 'effort';
  mode: 'auto' | 'off' | 'on';
  effort: string | null;
}

/** 预设模型条目 */
export interface PresetModel {
  id: string;
  contextWindow: number;
  outputTokens: number;
  reasoning: ReasoningCapability;
  /** 覆写供应商级方言（缺省继承）——同一供应商混供 toggle-only 与 effort 模型时使用（如 moonshot K3） */
  thinkingWire?: ThinkingWire;
}

/** 供应商预设条目 */
export interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
  platform: 'openai' | 'anthropic';
  thinkingWire: ThinkingWire;
  /** 控制台 / API Key 入口（UI 引导链接） */
  docsUrl?: string;
  /** 聚合/本地商：无预设模型，创建后引导「获取模型列表」 */
  fetchListHint?: boolean;
  models: PresetModel[];
}

const GLM5_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' };
const V4_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' };
const CLAUDE_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' };
const GPT5_EFFORT: ReasoningCapability = { kind: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' };
const NONE: ReasoningCapability = { kind: 'none' };

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── 国内直连 ──────────────────────────────────────────────────────────────
  {
    key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5.3', contextWindow: 1_000_000, outputTokens: 128_000, reasoning: GLM5_EFFORT },
      { id: 'glm-5.2', contextWindow: 1_000_000, outputTokens: 128_000, reasoning: GLM5_EFFORT },
      { id: 'glm-4.7', contextWindow: 200_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
      { id: 'glm-4.6', contextWindow: 200_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
      { id: 'glm-4.5', contextWindow: 128_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
    ],
  },
  {
    key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, outputTokens: 384_000, reasoning: V4_EFFORT },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, outputTokens: 65_536, reasoning: V4_EFFORT },
      { id: 'deepseek-chat', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
      { id: 'deepseek-reasoner', contextWindow: 128_000, outputTokens: 32_768, reasoning: NONE },
    ],
  },
  {
    key: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.ai/v1',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      // K3 顶层 reasoning_effort、无 thinking 开关 → 模型级覆写 'effort' 方言
      { id: 'kimi-k3', contextWindow: 1_000_000, outputTokens: 32_768, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' }, thinkingWire: 'effort' },
      { id: 'kimi-k2.6', contextWindow: 262_144, outputTokens: 8_192, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' } },
      { id: 'kimi-k2', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
    ],
  },
  {
    key: 'dashscope', name: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://bailian.console.aliyun.com/',
    models: [
      { id: 'qwen-max', contextWindow: 32_768, outputTokens: 8_192, reasoning: NONE },
      { id: 'qwen-plus', contextWindow: 131_072, outputTokens: 8_192, reasoning: NONE },
    ],
  },
  {
    key: 'volcano-ark', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.volcengine.com/ark',
    models: [
      { id: 'doubao-seed-1-6-pro-250815', contextWindow: 256_000, outputTokens: 12_288, reasoning: NONE },
      { id: 'doubao-seed-1-6-flash-250815', contextWindow: 256_000, outputTokens: 12_288, reasoning: NONE },
    ],
  },
  // ── 国际直连 ──────────────────────────────────────────────────────────────
  {
    key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.2', contextWindow: 400_000, outputTokens: 128_000, reasoning: GPT5_EFFORT },
      { id: 'gpt-5.1', contextWindow: 400_000, outputTokens: 128_000, reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high'], default: 'medium' } },
      { id: 'gpt-5-mini', contextWindow: 400_000, outputTokens: 128_000, reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high'], default: 'medium' } },
      { id: 'gpt-4.1', contextWindow: 1_048_576, outputTokens: 32_768, reasoning: NONE },
      { id: 'gpt-4o', contextWindow: 128_000, outputTokens: 16_384, reasoning: NONE },
    ],
  },
  {
    key: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com',
    platform: 'anthropic', thinkingWire: 'anthropic-budget',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-4-5', contextWindow: 200_000, outputTokens: 32_000, reasoning: CLAUDE_EFFORT },
      { id: 'claude-sonnet-4-5', contextWindow: 200_000, outputTokens: 64_000, reasoning: CLAUDE_EFFORT },
      { id: 'claude-haiku-4-5', contextWindow: 200_000, outputTokens: 64_000, reasoning: CLAUDE_EFFORT },
    ],
  },
  {
    key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3-pro-preview', contextWindow: 1_048_576, outputTokens: 65_536, reasoning: NONE },
      { id: 'gemini-2.5-flash', contextWindow: 1_048_576, outputTokens: 65_536, reasoning: NONE },
    ],
  },
  {
    key: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-4', contextWindow: 256_000, outputTokens: 32_768, reasoning: { kind: 'effort', values: ['low', 'high'], default: 'high' } },
      { id: 'grok-4-fast', contextWindow: 2_000_000, outputTokens: 100_000, reasoning: NONE },
    ],
  },
  {
    key: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'mistral-large-latest', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
      { id: 'magistral-medium-latest', contextWindow: 40_000, outputTokens: 8_192, reasoning: NONE },
    ],
  },
  {
    key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', contextWindow: 131_072, outputTokens: 32_768, reasoning: NONE },
      { id: 'openai/gpt-oss-120b', contextWindow: 131_072, outputTokens: 32_768, reasoning: NONE },
    ],
  },
  // ── 聚合 / 本地 ────────────────────────────────────────────────────────────
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://openrouter.ai/settings/keys', fetchListHint: true, models: [] },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://cloud.siliconflow.cn/account/ak', fetchListHint: true, models: [] },
  { key: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', platform: 'openai', thinkingWire: 'toggle', docsUrl: 'https://ollama.com', fetchListHint: true, models: [] },
  { key: 'lmstudio', name: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://lmstudio.ai', fetchListHint: true, models: [] },
];

/** 全量预设（IPC provider:listPresets 直接返回） */
export function listProviderPresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function getProviderPreset(key: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.key === key) ?? null;
}

export function getPresetModel(key: string, modelId: string): PresetModel | null {
  return getProviderPreset(key)?.models.find((m) => m.id === modelId) ?? null;
}

/** thinking_json 列的形状守卫：非法 / 缺失返回 null（DB 坏值不炸，回退 auto） */
export function parseThinkingConfig(raw: unknown): ThinkingConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.mode === 'auto' || o.mode === 'off') return { mode: o.mode, effort: null };
  if (o.mode === 'on') {
    return typeof o.effort === 'string' || o.effort === null
      ? { mode: 'on', effort: o.effort as string | null }
      : null;
  }
  return null;
}

/** AGENT_CONFIG 线协议守卫（runtime-config parseConfig 用） */
export function isThinkingRequest(v: unknown): v is ThinkingRequest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const wires = ['toggle', 'toggle-effort', 'effort', 'anthropic-budget'];
  const kinds = ['none', 'toggle', 'effort'];
  const modes = ['auto', 'off', 'on'];
  return (
    typeof o.wire === 'string' && wires.includes(o.wire) &&
    typeof o.kind === 'string' && kinds.includes(o.kind) &&
    typeof o.mode === 'string' && modes.includes(o.mode) &&
    (o.effort === null || typeof o.effort === 'string')
  );
}
```

- [ ] **Step 4: 未查证厂商数据复核（spec 附录 A 委托项）**

对照官方清单复核保守初值条目，与文档不符则改正数字/模型 id（保持 `reasoning: { kind: 'none' }` 除非文档明确支持 effort 参数）：
- dashscope：https://help.aliyun.com/zh/model-studio/models （qwen3 系窗口；如文档明确 thinking 参数支持可升级方言）
- volcano-ark：https://www.volcengine.com/docs/82379/1330310 （doubao-seed 系）
- gemini：https://ai.google.dev/gemini-api/docs/models （gemini-3 系 + OpenAI 兼容端点 reasoning_effort 支持度）
- xai：https://docs.x.ai/docs/models （grok-4 系窗口）
- mistral：https://docs.mistral.ai/models （large / magistral）
- groq：https://console.groq.com/docs/models （llama-3.3 / gpt-oss）

- [ ] **Step 5: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/llm/provider-presets.test.ts
```
预期：PASS 全绿。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/llm/provider-presets.ts electron/tests/llm/provider-presets.test.ts
git commit -m "feat: 供应商预设目录 provider-presets（15 家含思维模式能力元数据）"
```

---

### Task 2: model-catalog 能力字段与旗舰补位

**Files:**
- Modify: `electron/src/main/llm/model-catalog.ts`
- Test: `electron/tests/llm/model-catalog.test.ts`（新建）

**Interfaces:**
- Consumes: `ReasoningCapability`（Task 1）。
- Produces: `lookupReasoningCapability(platform, modelName): ReasoningCapability`；`CatalogEntry.reasoning`——Task 3/4 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/llm/model-catalog.test.ts
//
// 正则兜底层能力查询 + 旗舰缺位补齐（spec §4）：
// 预设表未命中的模型（自定义供应商 / 拉取的未知模型）经此层拿到能力与窗口。
import { describe, it, expect } from 'vitest';
import { lookupModelLimits, lookupReasoningCapability } from '../../src/main/llm/model-catalog';

describe('旗舰补位：窗口目录新条目', () => {
  it('glm-5.x：1M 上下文（须先于 glm-4 通配命中）', () => {
    expect(lookupModelLimits('openai', 'glm-5.3')).toEqual({ contextWindow: 1_000_000, outputTokens: 128_000 });
  });
  it('deepseek-v4：1M / 384K（须先于 chat/reasoner 命中）', () => {
    expect(lookupModelLimits('openai', 'deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, outputTokens: 384_000 });
  });
  it('kimi-k3：1M', () => {
    expect(lookupModelLimits('openai', 'kimi-k3')).toEqual({ contextWindow: 1_000_000, outputTokens: 32_768 });
  });
  it('gpt-5.2 带版本号变体命中 gpt-5 家族', () => {
    expect(lookupModelLimits('openai', 'gpt-5.2')?.contextWindow).toBe(400_000);
    expect(lookupModelLimits('openai', 'gpt-5')?.contextWindow).toBe(400_000);
  });
  it('gemini-3 命中新条目', () => {
    expect(lookupModelLimits('openai', 'gemini-3-pro-preview')).toEqual({ contextWindow: 1_048_576, outputTokens: 65_536 });
  });
});

describe('lookupReasoningCapability：正则兜底能力查询', () => {
  it('glm-5.x → effort low/high/max；glm-4.x → toggle', () => {
    expect(lookupReasoningCapability('openai', 'glm-5.2')).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'max' });
    expect(lookupReasoningCapability('openai', 'glm-4.6')).toEqual({ kind: 'toggle' });
  });
  it('deepseek-v4 → effort；deepseek-chat → none', () => {
    expect(lookupReasoningCapability('openai', 'deepseek-v4-flash')).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'high' });
    expect(lookupReasoningCapability('openai', 'deepseek-chat')).toEqual({ kind: 'none' });
  });
  it('kimi-k3 → effort；kimi-k2 → none', () => {
    expect(lookupReasoningCapability('openai', 'kimi-k3').kind).toBe('effort');
    expect(lookupReasoningCapability('openai', 'kimi-k2').kind).toBe('none');
  });
  it('o3 / claude → effort；gpt-4o → none；未收录 → none', () => {
    expect(lookupReasoningCapability('openai', 'o3').kind).toBe('effort');
    expect(lookupReasoningCapability('anthropic', 'claude-sonnet-4-5')).toEqual({ kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' });
    expect(lookupReasoningCapability('openai', 'gpt-4o')).toEqual({ kind: 'none' });
    expect(lookupReasoningCapability('openai', 'my-private-model')).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/llm/model-catalog.test.ts
```
预期：FAIL（`lookupReasoningCapability` 不存在 / 旗舰条目缺失）。

- [ ] **Step 3: 实现目录升级**

3a. 文件头 import 与 `CatalogEntry` 增加 reasoning 字段：

```typescript
import type { ReasoningCapability } from './provider-presets';

interface CatalogEntry {
  platform: CatalogPlatform;
  pattern: RegExp;
  limits: ModelLimits;
  /** v31：思维模式能力（预设表命中优先于本层，spec §4） */
  reasoning: ReasoningCapability;
}
```

3b. `CATALOG` 数组改动（**顺序敏感——新条目必须插在对应通配条目之前**）：

- 替换现有 gpt-5 条目（覆盖 5.1/5.2 带点变体 + 能力）：

```typescript
  {
    platform: 'openai',
    pattern: /^gpt-5(\.\d)?(-chat|-mini|-nano)?$/,
    limits: { contextWindow: 400000, outputTokens: 128000 },
    reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
  },
```

- `o1` 与 `o[34](-mini)?` 两个条目各加 `reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' }`。
- 全部 anthropic `claude-*` 条目（1m / 3.5-sonnet / 3.5-haiku / 3.7 / sonnet-4 / opus-4 / haiku-4）各加 `reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' }`。
- 在 `glm-4.6` 条目**之前**插入：

```typescript
  {
    platform: 'openai',
    pattern: /^glm-5(\.\d)?/,
    limits: { contextWindow: 1000000, outputTokens: 128000 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
  },
```

- `glm-4.6` / `glm-4` 两条目加 `reasoning: { kind: 'toggle' }`。
- 在 `deepseek-chat` 条目**之前**插入，且 `deepseek-chat` / `deepseek-reasoner` 加 `reasoning: { kind: 'none' }`：

```typescript
  {
    platform: 'openai',
    pattern: /^deepseek-v4/,
    limits: { contextWindow: 1000000, outputTokens: 384000 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' },
  },
```

- 在 `kimi-k2` 条目**之前**插入两条，`kimi-k2` 加 `reasoning: { kind: 'none' }`：

```typescript
  {
    platform: 'openai',
    pattern: /^kimi-k3/,
    limits: { contextWindow: 1000000, outputTokens: 32768 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
  },
  {
    platform: 'openai',
    pattern: /^kimi-k2\.6/,
    limits: { contextWindow: 262144, outputTokens: 8192 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' },
  },
```

- 在 `gemini-2.5-pro` 条目**之前**插入：

```typescript
  {
    platform: 'openai',
    pattern: /^gemini-3/,
    limits: { contextWindow: 1048576, outputTokens: 65536 },
    reasoning: { kind: 'none' },
  },
```

- 其余未提及条目（`gpt-4o` / `gpt-4.1` / `qwen-*` / `gemini-2.*`）一律加 `reasoning: { kind: 'none' }`。

3c. 文件尾新增导出：

```typescript
/**
 * 按协议平台 + 模型名查思维模式能力（正则兜底层）；未命中返回 none。
 * 优先级低于预设模型表（provider-presets，spec §4）。
 */
export function lookupReasoningCapability(
  platform: 'openai' | 'anthropic',
  modelName: string,
): ReasoningCapability {
  for (const e of CATALOG) {
    if (e.platform === platform && e.pattern.test(modelName)) {
      return e.reasoning;
    }
  }
  return { kind: 'none' };
}
```

- [ ] **Step 4: 跑本任务测试 + 既有 resolve 测试回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/llm/model-catalog.test.ts tests/agent/resolve-model-limits.test.ts
```
预期：全 PASS（`lookupModelLimits` 返回结构未变，既有测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/llm/model-catalog.ts electron/tests/llm/model-catalog.test.ts
git commit -m "feat: model-catalog 增加思维模式能力字段并补旗舰缺位（glm-5/deepseek-v4/kimi-k3）"
```

---

### Task 3: migration v31 + provider-crud 扩展

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（v31 追加在 v30 后）
- Modify: `electron/src/main/agent/provider-crud.ts`
- Test: `electron/tests/agent/provider-crud-presets.test.ts`（新建）

**Interfaces:**
- Consumes: `getProviderPreset` / `parseThinkingConfig` / `ThinkingConfig` / `ReasoningCapability`（Task 1）、`lookupModelLimits` / `lookupReasoningCapability`（Task 2）。
- Produces: `ModelProvider.presetKey`、`ProviderModel.thinkingJson / reasoning / effectiveWindow`、`createProvider({presetKey})`（种子模型）、`seedPresetModels(providerId, presetKey)`、`setProviderModelThinking(providerId, modelId, config | null)`、富化版 `listProviderModels`——Task 4/7/8/9 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/provider-crud-presets.test.ts
//
// migration v31 三列 + 预设种子 + thinking_json 读写 + listModels 富化（spec §3/§6/§7.2）。
// DB 隔离沿用仓库既定模式：AP_USER_DATA_DIR 临时目录 + getDb() 单例 + closeDb() 复位。
// keychain mock：createProvider 走 setSecret，测试环境无 keytar。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/storage/keychain', () => ({
  setSecret: vi.fn(async () => undefined),
  getSecret: vi.fn(async () => null),
  deleteSecret: vi.fn(async () => undefined),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  createProvider,
  listProviders,
  listProviderModels,
  setProviderModelThinking,
  seedPresetModels,
} from '../../src/main/agent/provider-crud';

const tmpRoot = path.join(os.tmpdir(), `ap-provider-presets-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration v31：三列可空，老行零破坏', () => {
  it('直接 SQL 插入老形状 provider 行可读回 presetKey=null', () => {
    getDb().prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, platform)
       VALUES ('p1', 'T', 'https://api.test.com', 'ref', NULL, 0, 'openai')`,
    ).run();
    expect(listProviders()[0]!.presetKey).toBeNull();
  });
});

describe('createProvider(presetKey)：种子模型幂等写入', () => {
  it('预设模型全部 enabled 落库；context_window 列保持 NULL；重复种子不覆盖用户改动', async () => {
    const p = await createProvider({
      name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k', platform: 'openai', presetKey: 'zhipu',
    });
    expect(p.presetKey).toBe('zhipu');
    const models = listProviderModels(p.id);
    expect(models.map((m) => m.modelId)).toContain('glm-5.3');
    expect(models.every((m) => m.enabled)).toBe(true);
    // 种子行 context_window 列保持 NULL（走预设表 resolve，spec §2.2）
    expect(models.find((m) => m.modelId === 'glm-5.3')!.contextWindow).toBeNull();

    // 用户禁用某模型后重跑种子：不覆盖（INSERT OR IGNORE 幂等）
    getDb().prepare(
      `UPDATE provider_models SET enabled = 0 WHERE provider_id = ? AND model_id = 'glm-4.6'`,
    ).run(p.id);
    seedPresetModels(p.id, 'zhipu');
    expect(listProviderModels(p.id).find((m) => m.modelId === 'glm-4.6')!.enabled).toBe(false);
  });

  it('未知 presetKey 抛错', () => {
    expect(() => seedPresetModels('p-x', 'nope')).toThrow(/未知供应商预设/);
  });
});

describe('setProviderModelThinking：形状校验与读写往返', () => {
  it('合法配置落库并可读回；null 清除；非法 mode 拒绝', async () => {
    const p = await createProvider({ name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k', platform: 'openai' });
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'glm-5.3', 1, 1)`,
    ).run(p.id);

    setProviderModelThinking(p.id, 'glm-5.3', { mode: 'on', effort: 'high' });
    expect(listProviderModels(p.id)[0]!.thinkingJson).toEqual({ mode: 'on', effort: 'high' });

    setProviderModelThinking(p.id, 'glm-5.3', null);
    expect(listProviderModels(p.id)[0]!.thinkingJson).toBeNull();

    expect(() => setProviderModelThinking(p.id, 'glm-5.3', { mode: 'bad' as 'on', effort: null })).toThrow();
  });
});

describe('listProviderModels 富化：reasoning + effectiveWindow（服务端单点 resolve，spec §6）', () => {
  it('预设供应商：presetKey 命中预设表能力；effectiveWindow 走预设数字', async () => {
    const p = await createProvider({
      name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k',
      platform: 'openai', presetKey: 'moonshot',
    });
    const k3 = listProviderModels(p.id).find((m) => m.modelId === 'kimi-k3')!;
    expect(k3.reasoning).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'max' });
    expect(k3.effectiveWindow).toBe(1_000_000);
  });

  it('自定义供应商：无 presetKey → 正则目录兜底；未知模型 → none / null', async () => {
    const p = await createProvider({ name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k', platform: 'openai' });
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'glm-4.6', 1, 1)`,
    ).run(p.id);
    getDb().prepare(
      `INSERT INTO provider_models (provider_id, model_id, enabled, added_at) VALUES (?, 'my-model', 1, 2)`,
    ).run(p.id);
    const models = listProviderModels(p.id);
    expect(models.find((m) => m.modelId === 'glm-4.6')!.reasoning).toEqual({ kind: 'toggle' });
    expect(models.find((m) => m.modelId === 'glm-4.6')!.effectiveWindow).toBe(200_000);
    expect(models.find((m) => m.modelId === 'my-model')!.reasoning).toEqual({ kind: 'none' });
    expect(models.find((m) => m.modelId === 'my-model')!.effectiveWindow).toBeNull();
  });

  it('用户覆盖列优先于预设表（effectiveWindow）', async () => {
    const p = await createProvider({
      name: 'T', baseUrl: 'https://api.test.com', apiKey: 'k',
      platform: 'openai', presetKey: 'zhipu',
    });
    getDb().prepare(
      `UPDATE provider_models SET context_window = 131072 WHERE provider_id = ? AND model_id = 'glm-4.6'`,
    ).run(p.id);
    expect(listProviderModels(p.id).find((m) => m.modelId === 'glm-4.6')!.effectiveWindow).toBe(131_072);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/provider-crud-presets.test.ts
```
预期：FAIL（无 presetKey 参数 / 列不存在）。

- [ ] **Step 3: 实现**

3a. `migrations/index.ts` 在 v30 条目后追加：

```typescript
  {
    version: 31,
    sql: `
-- ─── v31：供应商预设与思维模式（spec 2026-09-09-provider-presets）─────────────
-- 1. model_providers.preset_key：来源预设标识（选择器「已添加」徽标）；NULL=自定义
ALTER TABLE model_providers ADD COLUMN preset_key TEXT;
-- 2. provider_models.thinking_json：模型级思维配置默认；NULL=auto（不发参数）
ALTER TABLE provider_models ADD COLUMN thinking_json TEXT;
-- 3. agent_definitions.thinking_json：agent 级覆盖；NULL=继承模型级
ALTER TABLE agent_definitions ADD COLUMN thinking_json TEXT;
    `.trim(),
  },
```

3b. `provider-crud.ts`：

- 顶部 import 加：

```typescript
import {
  getProviderPreset,
  parseThinkingConfig,
  type ReasoningCapability,
  type ThinkingConfig,
} from '../llm/provider-presets';
import { lookupModelLimits, lookupReasoningCapability } from '../llm/model-catalog';
```

- `ModelProviderRow` 加 `preset_key: string | null;`；`ModelProvider` 加：

```typescript
  /** 来源预设 key（provider-presets）；NULL=自定义供应商 */
  presetKey: string | null;
```

- `rowToProvider` 返回对象加 `presetKey: row.preset_key ?? null,`。

- `ProviderModelRow` 加 `thinking_json: string | null;`；`ProviderModel` 加：

```typescript
  /** 模型级思维配置（用户设置）；null=未配置（auto） */
  thinkingJson: ThinkingConfig | null;
  /** 思维模式能力（服务端 resolve：预设表→正则目录；只读，spec §6 单一真相源） */
  reasoning: ReasoningCapability;
  /** resolve 链生效窗口（用户列→预设→目录）；null=未知（UI placeholder 用） */
  effectiveWindow: number | null;
```

- `rowToProviderModel` 加 `thinkingJson: parseThinkingConfig(safeParseJson(row.thinking_json)),`。文件内新增小工具（放在 `rowToProviderModel` 前）：

```typescript
/** thinking_json 列安全解析：坏 JSON 返回 null（单行坏数据不炸列表） */
function safeParseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
```

- `createProvider` 入参加 `presetKey?: string;`；INSERT 列与值各加 `preset_key`（值 `input.presetKey ?? null`）；在 keychain 写入成功后、`if (input.isDefault)` 之前加：

```typescript
  // 预设种子：模型清单幂等写入（INSERT OR IGNORE，不覆盖既有行，spec §2.2）
  if (input.presetKey) {
    seedPresetModels(id, input.presetKey);
  }
```

- `provider_models CRUD` 区追加：

```typescript
/** 预设模型种子写入（幂等；种子行 enabled=true、context_window=NULL 走预设表 resolve） */
export function seedPresetModels(providerId: string, presetKey: string): void {
  const preset = getProviderPreset(presetKey);
  if (!preset) throw new Error(`未知供应商预设: ${presetKey}`);
  for (const m of preset.models) {
    upsertProviderModel(providerId, m.id, true);
  }
}

/**
 * 设置模型的思维模式配置（模型级默认，spec §3）。
 * null=清除（回退 auto）；形状非法在写通道源头拒绝（不让坏值落库）。
 * effort ∈ 模型 values 的越界钳制在 resolve 层（resolveThinkingConfig）。
 */
export function setProviderModelThinking(
  providerId: string,
  modelId: string,
  config: ThinkingConfig | null,
): void {
  if (config !== null && !['auto', 'off', 'on'].includes(config.mode)) {
    throw new Error(`thinking mode 非法: ${String(config.mode)}`);
  }
  if (
    config !== null &&
    config.mode === 'on' &&
    typeof config.effort !== 'string' &&
    config.effort !== null
  ) {
    throw new Error('thinking effort 必须是字符串或 null');
  }
  const db = getDb();
  db.prepare(
    'UPDATE provider_models SET thinking_json = ? WHERE provider_id = ? AND model_id = ?',
  ).run(config === null ? null : JSON.stringify(config), providerId, modelId);
}
```

- `listProviderModels` 整体替换为富化版：

```typescript
/**
 * 列出某供应商的模型列表（按加入时间升序）。
 * v31 富化：reasoning 能力与 effectiveWindow 在服务端单点 resolve
 * （用户列→预设表→正则目录），客户端不重复实现 resolve 链（spec §6）。
 */
export function listProviderModels(providerId: string): ProviderModel[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY added_at ASC')
    .all(providerId) as ProviderModelRow[];
  const provider = getProvider(providerId);
  const platform = provider?.platform ?? 'openai';
  const preset = provider?.presetKey ? getProviderPreset(provider.presetKey) : null;
  return rows.map((row) => {
    const presetModel = preset?.models.find((m) => m.id === row.model_id) ?? null;
    const catalog = lookupModelLimits(platform, row.model_id);
    return {
      ...rowToProviderModel(row),
      reasoning: presetModel?.reasoning ?? lookupReasoningCapability(platform, row.model_id),
      effectiveWindow:
        row.context_window ?? presetModel?.contextWindow ?? catalog?.contextWindow ?? null,
    };
  });
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/provider-crud-presets.test.ts tests/agent/resolve-model-limits.test.ts
```
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/migrations/index.ts electron/src/main/agent/provider-crud.ts electron/tests/agent/provider-crud-presets.test.ts
git commit -m "feat: migration v31 三列 + provider CRUD 预设种子与思维配置读写"
```

---

### Task 4: resolveThinkingConfig + AGENT_CONFIG 透传

**Files:**
- Modify: `electron/src/main/agent/spawn-helpers.ts`
- Modify: `electron/src/main/agent/runtime-config.ts`
- Modify: `electron/src/main/agent/types.ts`（AgentDefinition 加 thinkingJson）
- Test: `electron/tests/agent/resolve-thinking.test.ts`（新建）

**Interfaces:**
- Consumes: `getProviderPreset` / `parseThinkingConfig` / `ThinkingRequest` / `ThinkingWire` / `ThinkingConfig`（Task 1）、`lookupReasoningCapability`（Task 2）、Task 3 后含 presetKey 的 `getProvider` / `ModelProvider`。
- Produces: `resolveThinkingConfig(def, provider): ThinkingRequest`；`AgentRuntimeOpts.thinking?` / `RuntimeConfig.thinking?` / `parseConfig` 还原；`AgentDefinition.thinkingJson?`——Task 5/6 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/resolve-thinking.test.ts
//
// 思维配置 fallback（spec §4）+ 方言解析 + 越界钳制 + spawn 透传往返：
//   agent_definitions.thinking_json → provider_models.thinking_json → {mode:'auto'}
// 能力词汇表：预设模型表 → 正则目录 → none
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { resolveThinkingConfig, buildSpawnOpts } from '../../src/main/agent/spawn-helpers';
import { parseConfig } from '../../src/main/agent/runtime-config';
import { getProvider, type ModelProvider } from '../../src/main/agent/provider-crud';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-resolve-thinking-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedProvider(id: string, platform: 'openai' | 'anthropic', presetKey: string | null): void {
  getDb().prepare(
    `INSERT INTO model_providers
       (id, name, base_url, api_key_ref, default_model, is_default, platform, preset_key)
     VALUES (?, 'T', 'https://api.test.com', 'ref', NULL, 0, ?, ?)`,
  ).run(id, platform, presetKey);
}

function seedModelThinking(providerId: string, modelId: string, thinkingJson: string | null): void {
  getDb().prepare(
    `INSERT INTO provider_models (provider_id, model_id, enabled, added_at, thinking_json)
     VALUES (?, ?, 1, 1, ?)`,
  ).run(providerId, modelId, thinkingJson);
}

function seedWorkspaceAndDef(defId: string, providerId: string, modelName: string, thinkingJson: string | null): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', '/tmp', 0, '@owner:s', 'X')`,
  ).run();
  getDb().prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills,
        source, description, icon_emoji, model_provider_id, model_name, task_driven, thinking_json)
     VALUES (?, 'T', 't', '1', 'declarative', 'p', '[]', '[]', '[]', 'custom', 'd', 'X', ?, ?, 1, ?)`,
  ).run(defId, providerId, modelName, thinkingJson);
}

function makeDef(
  defId: string,
  providerId: string,
  modelName: string,
  thinkingJson?: AgentDefinition['thinkingJson'],
): AgentDefinition {
  return {
    id: defId, name: 'T', slug: 't', version: '1', runtime: 'declarative', systemPrompt: 'p',
    defaultTools: [], defaultMcps: [], defaultSkills: [], source: 'custom', description: '',
    iconEmoji: 'X', workspaceId: null, modelProviderId: providerId, modelName, thinkingJson,
  };
}

describe('resolveThinkingConfig：配置 fallback 与方言', () => {
  it('无任何配置 → auto；预设供应商方言来自 preset；能力来自预设表', () => {
    seedProvider('p1', 'openai', 'zhipu');
    const p = getProvider('p1') as ModelProvider;
    expect(resolveThinkingConfig(makeDef('d1', 'p1', 'glm-5.3'), p)).toEqual({
      wire: 'toggle-effort', kind: 'effort', mode: 'auto', effort: null,
    });
  });

  it('模型级 thinking_json 生效；agent 级覆盖模型级', () => {
    seedProvider('p2', 'openai', 'zhipu');
    seedModelThinking('p2', 'glm-5.3', JSON.stringify({ mode: 'on', effort: 'low' }));
    const p = getProvider('p2') as ModelProvider;
    const base = makeDef('d2', 'p2', 'glm-5.3');
    expect(resolveThinkingConfig(base, p).mode).toBe('on');
    expect(resolveThinkingConfig(base, p).effort).toBe('low');
    const override = makeDef('d2', 'p2', 'glm-5.3', { mode: 'off', effort: null });
    expect(resolveThinkingConfig(override, p).mode).toBe('off');
  });

  it('effort 越界回退模型 default；kimi-k3 模型级方言覆写生效', () => {
    seedProvider('p3', 'openai', 'moonshot');
    seedModelThinking('p3', 'kimi-k3', JSON.stringify({ mode: 'on', effort: 'ultra' }));
    const req = resolveThinkingConfig(makeDef('d3', 'p3', 'kimi-k3'), getProvider('p3') as ModelProvider);
    expect(req.wire).toBe('effort');
    expect(req.effort).toBe('max'); // 越界 'ultra' → default 'max'
  });

  it('toggle 模型 on 不带 effort；能力=none 时 kind 透传', () => {
    seedProvider('p4', 'openai', 'zhipu');
    seedModelThinking('p4', 'glm-4.6', JSON.stringify({ mode: 'on', effort: 'whatever' }));
    const req = resolveThinkingConfig(makeDef('d4', 'p4', 'glm-4.6'), getProvider('p4') as ModelProvider);
    expect(req).toEqual({ wire: 'toggle-effort', kind: 'toggle', mode: 'on', effort: null });
  });

  it('自定义供应商：platform 兜底方言 + 正则目录能力', () => {
    seedProvider('p5', 'anthropic', null);
    expect(resolveThinkingConfig(makeDef('d5', 'p5', 'claude-sonnet-4-5'), getProvider('p5') as ModelProvider)).toEqual({
      wire: 'anthropic-budget', kind: 'effort', mode: 'auto', effort: null,
    });
    seedProvider('p6', 'openai', null);
    expect(resolveThinkingConfig(makeDef('d6', 'p6', 'glm-4.6'), getProvider('p6') as ModelProvider)).toEqual({
      wire: 'effort', kind: 'toggle', mode: 'auto', effort: null,
    });
  });
});

describe('spawn 透传：buildSpawnOpts → AGENT_CONFIG → parseConfig', () => {
  it('thinking 随 opts 定型，线协议往返保持', async () => {
    seedProvider('p7', 'openai', 'deepseek');
    seedModelThinking('p7', 'deepseek-v4-pro', JSON.stringify({ mode: 'on', effort: 'high' }));
    seedWorkspaceAndDef('d7', 'p7', 'deepseek-v4-pro', null);

    const opts = await buildSpawnOpts({
      instanceId: 'inst1', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('d7', 'p7', 'deepseek-v4-pro'), llmApiKey: 'k',
    });
    expect(opts.thinking).toEqual({ wire: 'toggle-effort', kind: 'effort', mode: 'on', effort: 'high' });

    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    expect(config.thinking).toEqual({ wire: 'toggle-effort', kind: 'effort', mode: 'on', effort: 'high' });
  });

  it('旧 AGENT_CONFIG 无 thinking 字段 / 非法结构 → undefined（兼容 + fail-safe）', async () => {
    seedProvider('p8', 'openai', null);
    seedWorkspaceAndDef('d8', 'p8', 'gpt-4o', null);
    const opts = await buildSpawnOpts({
      instanceId: 'inst1', agentUserId: 'agent-t-ab12cd', workspaceId: 'ws-1',
      workspaceDir: '/tmp', def: makeDef('d8', 'p8', 'gpt-4o'), llmApiKey: 'k',
    });
    const wire = JSON.parse(JSON.stringify(opts)) as Record<string, unknown>;
    delete wire.thinking;
    expect(parseConfig(wire).thinking).toBeUndefined();
    expect(parseConfig({ ...wire, thinking: { wire: 'bad' } }).thinking).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/resolve-thinking.test.ts
```
预期：FAIL。

- [ ] **Step 3: 实现**

3a. `agent/types.ts`：import 区加 `import type { ThinkingConfig } from '../llm/provider-presets';`，`AgentDefinition` 尾部加：

```typescript
  // === 供应商预设（migration v31） ===
  /** agent 级思维模式覆盖；NULL/undefined=继承模型级（provider_models.thinking_json） */
  thinkingJson?: ThinkingConfig | null;
```

3b. `spawn-helpers.ts`：import 区加：

```typescript
import {
  getProviderPreset,
  parseThinkingConfig,
  type ThinkingRequest,
  type ThinkingWire,
} from '../llm/provider-presets';
import { lookupReasoningCapability } from '../llm/model-catalog';
```

（`getProvider` 已 import；若未显式引入 `type ModelProvider` 则在 `./provider-crud` 的 import 中补。）在 `resolveModelLimits` 之后新增：

```typescript
/**
 * 思维配置 resolve（spec 2026-09-09-provider-presets §4，单点定型）：
 *   生效配置 = agent_definitions.thinking_json → provider_models.thinking_json → auto
 *   能力词汇表 = 预设模型表 → 正则目录 → none
 *   方言 = 模型级覆写 → 预设级 → platform 兜底（anthropic→anthropic-budget，openai→effort）
 * effort 越界在此处钳制回模型 default（warn 单点，请求层不再校验）。
 */
export function resolveThinkingConfig(
  def: AgentDefinition,
  provider: ModelProvider,
): ThinkingRequest {
  const preset = provider.presetKey ? getProviderPreset(provider.presetKey) : null;
  const presetModel = preset?.models.find((m) => m.id === def.modelName) ?? null;
  const wire: ThinkingWire =
    presetModel?.thinkingWire ?? preset?.thinkingWire ??
    (provider.platform === 'anthropic' ? 'anthropic-budget' : 'effort');
  const capability =
    presetModel?.reasoning ?? lookupReasoningCapability(provider.platform, def.modelName);

  const row = getDb()
    .prepare(
      'SELECT thinking_json FROM provider_models WHERE provider_id = ? AND model_id = ?',
    )
    .get(provider.id, def.modelName) as { thinking_json: string | null } | undefined;
  const cfg =
    def.thinkingJson ?? parseThinkingConfig(row?.thinking_json) ?? { mode: 'auto' as const, effort: null };

  let effort: string | null = null;
  if (capability.kind === 'effort' && cfg.mode === 'on') {
    effort =
      cfg.effort !== null && capability.values.includes(cfg.effort)
        ? cfg.effort
        : capability.default;
    if (effort !== cfg.effort) {
      logger.warn('thinking effort 越界，回退模型默认档', {
        providerId: provider.id,
        model: def.modelName,
        effort: cfg.effort,
        fallback: effort,
      });
    }
  }
  return { wire, kind: capability.kind, mode: cfg.mode, effort };
}
```

`buildSpawnOpts` 内 `resolveModelLimits` 调用之后加：

```typescript
  // 思维配置（spec §4）：同 resolve 链单点解析，随 AGENT_CONFIG 定型
  const thinking = resolveThinkingConfig(def, provider);
```

返回对象加（`outputTokens` 之后）：

```typescript
    // 思维配置（spawn 时快照；mode=auto 请求层不发参数）
    thinking,
```

3c. `runtime-config.ts`：import 加：

```typescript
import { isThinkingRequest, type ThinkingRequest } from '../llm/provider-presets';
```

`AgentRuntimeOpts` 尾部（`outputTokens?: number;` 后）加：

```typescript
  // === 供应商预设（spec 2026-09-09-provider-presets）===
  /** 思维模式配置（resolveThinkingConfig 产出；缺省=不发任何 thinking 参数） */
  thinking?: ThinkingRequest;
```

`RuntimeConfig` 尾部（`outputTokens: number;` 后）加：

```typescript
  /** 思维模式配置；undefined=不发任何 thinking 参数（旧配置兼容） */
  thinking?: ThinkingRequest;
```

`parseConfig` 返回对象加（`outputTokens` 行后）：

```typescript
    // 供应商预设：thinking 结构守卫失败 → undefined（不发参数，fail-safe）
    thinking: isThinkingRequest(r.thinking) ? r.thinking : undefined,
```

- [ ] **Step 4: 跑测试确认通过 + spawn 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/resolve-thinking.test.ts tests/agent/resolve-model-limits.test.ts
```
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/spawn-helpers.ts electron/src/main/agent/runtime-config.ts electron/src/main/agent/types.ts electron/tests/agent/resolve-thinking.test.ts
git commit -m "feat: resolveThinkingConfig resolve 链与 AGENT_CONFIG thinking 透传"
```

---

### Task 5: llm-provider 请求注入（wire 方言）

**Files:**
- Modify: `electron/src/main/agent/llm-provider.ts`
- Modify: `electron/src/main/agent/runtime-entry.ts`（:321 调用点加第三参）
- Test: `electron/tests/agent/llm-provider-thinking.test.ts`（新建）

**Interfaces:**
- Consumes: `ThinkingRequest`（Task 1）、`RuntimeConfig.thinking`（Task 4）。
- Produces: `createLLMProvider(model, apiKey, opts?: { thinking?: ThinkingRequest })`——35 个既有调用点签名向后兼容（第三参可选）；导出 `applyOpenAIThinking` / `applyAnthropicThinking` 供测试与复用。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/llm-provider-thinking.test.ts
//
// wire 方言 × mode 请求体快照测试（spec §5.2 映射表唯一真相源）。
// mock 全局 fetch 捕获请求体（momo-test-rules：断言真实序列化产物）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLLMProvider, applyOpenAIThinking, applyAnthropicThinking } from '../../src/main/agent/llm-provider';
import type { ThinkingRequest } from '../../src/main/llm/provider-presets';

const bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
});

function tr(partial: Partial<ThinkingRequest> & { wire: ThinkingRequest['wire'] }): ThinkingRequest {
  return { kind: 'effort', mode: 'on', effort: 'high', ...partial };
}

describe('applyOpenAIThinking：方言 × mode 映射表', () => {
  const cases: Array<[string, ThinkingRequest | undefined, Record<string, unknown>]> = [
    ['toggle off', tr({ wire: 'toggle', kind: 'toggle', mode: 'off', effort: null }), { thinking: { type: 'disabled' } }],
    ['toggle on', tr({ wire: 'toggle', kind: 'toggle', mode: 'on', effort: null }), { thinking: { type: 'enabled' } }],
    ['toggle-effort on+effort', tr({ wire: 'toggle-effort' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['toggle-effort off', tr({ wire: 'toggle-effort', mode: 'off', effort: null }), { thinking: { type: 'disabled' } }],
    ['effort on', tr({ wire: 'effort' }), { reasoning_effort: 'high' }],
    ['effort off（不发参数）', tr({ wire: 'effort', mode: 'off', effort: null }), {}],
    ['auto（不发参数）', tr({ wire: 'toggle-effort', mode: 'auto', effort: null }), {}],
    ['kind none（不发参数）', { wire: 'effort', kind: 'none', mode: 'on', effort: null }, {}],
    ['undefined（不发参数）', undefined, {}],
  ];
  for (const [name, t, expected] of cases) {
    it(name, () => {
      const body: Record<string, unknown> = { model: 'm', messages: [] };
      applyOpenAIThinking(body, t);
      expect(body).toEqual({ model: 'm', messages: [], ...expected });
    });
  }
});

describe('applyAnthropicThinking：budget 阶梯 + max_tokens 抬升', () => {
  it('on + low/medium/high → budget 4096/10000/32768；max_tokens > budget', () => {
    for (const [effort, budget] of [['low', 4096], ['medium', 10000], ['high', 32768]] as const) {
      const body: Record<string, unknown> = { model: 'm', max_tokens: 4096, messages: [] };
      applyAnthropicThinking(body, tr({ wire: 'anthropic-budget', effort }));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
      expect(body.max_tokens as number).toBeGreaterThan(budget);
    }
  });
  it('auto / off / kind none / undefined → 不发 thinking 且 max_tokens 不动', () => {
    for (const t of [
      undefined,
      tr({ wire: 'anthropic-budget', mode: 'auto', effort: null }),
      tr({ wire: 'anthropic-budget', mode: 'off', effort: null }),
      { wire: 'anthropic-budget', kind: 'none', mode: 'on', effort: null },
    ]) {
      const body: Record<string, unknown> = { model: 'm', max_tokens: 4096, messages: [] };
      applyAnthropicThinking(body, t);
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(4096);
    }
  });
});

describe('createLLMProvider 端到端注入（chat 非流式）', () => {
  it('openai 方言 toggle-effort：请求体含 thinking + reasoning_effort', async () => {
    const llm = createLLMProvider(
      { model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', provider: 'openai' },
      'k',
      { thinking: tr({ wire: 'toggle-effort' }) },
    );
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('anthropic 方言：thinking + max_tokens 抬升', async () => {
    const llm = createLLMProvider(
      { model: 'claude-sonnet-4-5', provider: 'anthropic' },
      'k',
      { thinking: tr({ wire: 'anthropic-budget', effort: 'low' }) },
    );
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(bodies[0]!.max_tokens as number).toBeGreaterThan(4096);
  });

  it('无 thinking（既有调用点兼容）：请求体无 thinking 字段', async () => {
    const llm = createLLMProvider({ model: 'gpt-4o', provider: 'openai' }, 'k');
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(bodies[0]!.reasoning_effort).toBeUndefined();
  });
});

describe('chatStream 流式注入（SSE mock）', () => {
  it('openai 流式请求体同样注入 thinking', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const llm = createLLMProvider(
      { model: 'glm-5.3', provider: 'openai' },
      'k',
      { thinking: tr({ wire: 'toggle-effort' }) },
    );
    for await (const d of llm.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      void d;
    }
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/llm-provider-thinking.test.ts
```
预期：FAIL（`applyOpenAIThinking` 未导出）。

- [ ] **Step 3: 实现 llm-provider.ts**

3a. 文件头 import 与两个注入函数（放在 `detectPlatform` 之前）：

```typescript
import type { ThinkingRequest } from '../llm/provider-presets';

/**
 * OpenAI 方言 thinking 注入（spec §5.2 映射表唯一实现）。
 * auto / kind=none / undefined → 不发任何参数（厂商默认）。
 */
export function applyOpenAIThinking(
  body: Record<string, unknown>,
  t: ThinkingRequest | undefined,
): void {
  if (!t || t.kind === 'none' || t.mode === 'auto') return;
  const sendToggle = t.wire === 'toggle' || t.wire === 'toggle-effort';
  if (t.mode === 'off') {
    // 仅开关型方言有显式关闭；effort 方言关闭 = 不发参数
    if (sendToggle) body.thinking = { type: 'disabled' };
    return;
  }
  if (sendToggle) body.thinking = { type: 'enabled' };
  if (t.kind === 'effort' && t.effort) body.reasoning_effort = t.effort;
}

/** Anthropic budget 阶梯（medium=10000 沿用旧硬编码成本档，升级前后行为连续） */
const ANTHROPIC_BUDGET_TOKENS: Record<string, number> = { low: 4096, medium: 10000, high: 32768 };

/**
 * Anthropic 方言 thinking 注入：档位 → budget_tokens。
 * max_tokens 必须严格大于 budget_tokens 否则 400——按 budget+4096 抬升。
 * auto / off → 不发 thinking（Anthropic 缺省即关闭，无显式 disabled）。
 */
export function applyAnthropicThinking(
  body: Record<string, unknown>,
  t: ThinkingRequest | undefined,
): void {
  if (!t || t.kind === 'none' || t.mode !== 'on') return;
  const budget = ANTHROPIC_BUDGET_TOKENS[t.effort ?? 'medium'] ?? 10000;
  body.thinking = { type: 'enabled', budget_tokens: budget };
  const base = typeof body.max_tokens === 'number' ? body.max_tokens : 4096;
  body.max_tokens = Math.max(base, budget + 4096);
}
```

3b. `createLLMProvider` 加第三参并下传：

```typescript
export function createLLMProvider(
  model: { provider?: 'openai' | 'anthropic'; model: string; baseUrl?: string },
  apiKey: string,
  opts?: { thinking?: ThinkingRequest },
): LLMProvider {
  const provider = model.provider ?? detectPlatform(model.baseUrl);
  if (provider === 'openai') {
    return new OpenAIProvider(model.model, apiKey, model.baseUrl, opts?.thinking);
  }
  if (provider === 'anthropic') {
    return new AnthropicProvider(model.model, apiKey, model.baseUrl, opts?.thinking);
  }
  throw new Error(`不支持的 LLM provider: ${provider}`);
}
```

3c. `OpenAIProvider` / `AnthropicProvider` 构造器各加第四参 `private thinking?: ThinkingRequest`；两个 `chat()` 里在 `if (tools && tools.length > 0) {...}` 块之后分别加：

```typescript
    applyOpenAIThinking(body, this.thinking);      // OpenAIProvider.chat
    applyAnthropicThinking(body, this.thinking);   // AnthropicProvider.chat
```

两个 `chatStream` 委托改为：

```typescript
    yield* chatStreamOpenAI(this.model, this.baseUrl, this.apiKey, messages, tools, signal, this.thinking);
    // AnthropicProvider：
    yield* chatStreamAnthropic(this.model, this.baseUrl, this.apiKey, messages, tools, signal, this.thinking);
```

3d. `chatStreamOpenAI` / `chatStreamAnthropic` 签名各加末参 `thinking: ThinkingRequest | undefined`：

- `chatStreamOpenAI`：在 `if (tools && tools.length > 0) {...}` 之后加 `applyOpenAIThinking(body, thinking);`
- `chatStreamAnthropic`：**删除现有硬编码**（约 :562-563 的 `body.thinking = { type: 'enabled', budget_tokens: 10000 };` 及其上方「开启 thinking」注释行），在 `if (systemMsg) body.system = systemMsg.content;` 之后加：

```typescript
  // 思维模式按方言配置注入（取代旧硬编码 always-on 10000；spec §5.2）
  applyAnthropicThinking(body, thinking);
```

（:552 处「max_tokens 必须大于 thinking.budget_tokens」的注释改述为引用 applyAnthropicThinking 的抬升逻辑。）

3e. 解析别名（K3 等字段名容差，spec §5.3）：`chatStreamOpenAI` 的 thinking 解析段（:479-483）替换为：

```typescript
        // thinking（reasoning_content —— GLM/DeepSeek/Kimi；reasoning —— 部分网关别名）
        const delta = choice.delta as { reasoning_content?: string; reasoning?: string } | undefined;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'thinking', content: reasoning };
        }
```

3f. `runtime-entry.ts` :321 调用点加第三参：

```typescript
const llm = createLLMProvider(
  // P3 Task 1：modelPlatform 显式透传（来自 buildSpawnOpts provider.platform）。
  // undefined 时 createLLMProvider 退回到 baseUrl 启发式（v1.3 兼容路径）。
  { model: config.modelName, baseUrl: config.modelBaseUrl, ...(config.modelPlatform ? { provider: config.modelPlatform } : {}) },
  config.llmApiKey,
  // 供应商预设：思维配置随 AGENT_CONFIG 定型（缺省 = 不发参数）
  config.thinking ? { thinking: config.thinking } : undefined,
);
```

- [ ] **Step 4: 跑测试 + llm-provider 既有回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/llm-provider-thinking.test.ts tests/agent/llm-provider.test.ts tests/agent/llm-provider-stream.test.ts tests/agent/llm-provider-retry.test.ts
```
预期：PASS。若既有流式测试断言了 Anthropic 请求体「恒含 thinking 10000」——那是依赖旧硬编码，按新语义修正该断言（未配置 → 无 thinking）；**不得删除用例**。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/llm-provider.ts electron/src/main/agent/runtime-entry.ts electron/tests/agent/llm-provider-thinking.test.ts
git commit -m "feat: LLM 请求体按 wire 方言注入 thinking 参数（四方言映射表）"
```

---

### Task 6: agent 定义 thinkingJson 数据链

**Files:**
- Modify: `electron/src/main/agent/crud.ts`（AgentDefRow / rowToDef / saveAgentDefinition / updateAgentDefinition / CreateCustomDefInput / createCustomDef）
- Modify: `electron/src/main/agent/ipc.handlers.ts`（agent:createCustom / agent:updateDefinition 入参类型）
- Test: `electron/tests/agent/agent-def-thinking.test.ts`（新建）

**Interfaces:**
- Consumes: `ThinkingConfig` / `parseThinkingConfig`（Task 1）、`AgentDefinition.thinkingJson`（Task 4）。
- Produces: `CreateCustomDefInput.thinkingJson`、`updateAgentDefinition({thinkingJson})`——Task 7 renderer 对齐、Task 10 UI 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/agent-def-thinking.test.ts
//
// agent_definitions.thinking_json 读写往返 + undefined=不改 语义（migration v31）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createCustomDef, getAgentDefinition, updateAgentDefinition } from '../../src/main/agent/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-def-thinking-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('thinking_json 数据链', () => {
  it('createCustomDef 带 thinkingJson 落库并可读回', () => {
    const def = createCustomDef(null, {
      name: 'T', slug: 't', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-5.3',
      thinkingJson: { mode: 'on', effort: 'low' },
    });
    expect(def.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
  });

  it('缺省 thinkingJson → null（继承模型级）', () => {
    const def = createCustomDef(null, {
      name: 'T2', slug: 't2', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-4.6',
    });
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
  });

  it('updateAgentDefinition：undefined=不改；null=清除；传值=覆盖', () => {
    const def = createCustomDef(null, {
      name: 'T3', slug: 't3', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-5.3',
      thinkingJson: { mode: 'on', effort: 'low' },
    });
    updateAgentDefinition({ id: def.id, name: 'T3' });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'on', effort: 'low' });
    updateAgentDefinition({ id: def.id, thinkingJson: null });
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
    updateAgentDefinition({ id: def.id, thinkingJson: { mode: 'off', effort: null } });
    expect(getAgentDefinition(def.id)!.thinkingJson).toEqual({ mode: 'off', effort: null });
  });

  it('DB 坏值（非法 JSON）读回 null 不炸', () => {
    const def = createCustomDef(null, {
      name: 'T4', slug: 't4', systemPrompt: 'p',
      modelProviderId: 'p1', modelName: 'glm-4.6',
    });
    getDb().prepare(
      `UPDATE agent_definitions SET thinking_json = '{bad' WHERE id = ?`,
    ).run(def.id);
    expect(getAgentDefinition(def.id)!.thinkingJson).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/agent-def-thinking.test.ts
```
预期：FAIL。

- [ ] **Step 3: 实现 crud.ts**

- import 加：`import { parseThinkingConfig, type ThinkingConfig } from '../llm/provider-presets';`
- `AgentDefRow` 加 `thinking_json: string | null;`
- `rowToDef` 返回对象加（`taskDriven` 后）：

```typescript
    // v31：坏值容错读回 null（继承模型级），单行坏数据不炸列表
    thinkingJson: (() => {
      if (row.thinking_json === null) return null;
      try {
        return parseThinkingConfig(JSON.parse(row.thinking_json) as unknown);
      } catch {
        return null;
      }
    })(),
```

- `saveAgentDefinition`：列清单 `(…, task_driven)` → `(…, task_driven, thinking_json)`，VALUES 加 `@thinking_json`，run 参数加：

```typescript
    thinking_json: def.thinkingJson != null ? JSON.stringify(def.thinkingJson) : null,
```

- `CreateCustomDefInput` 加：

```typescript
  /** v31：agent 级思维模式覆盖；缺省/null=继承模型级 */
  thinkingJson?: ThinkingConfig | null;
```

- `createCustomDef` 构造 def 对象处（`modelName: effectiveModelName` 附近）加 `thinkingJson: input.thinkingJson ?? null,`。
- `updateAgentDefinition` 入参类型加 `thinkingJson?: ThinkingConfig | null;`；UPDATE 语句 SET 子句加 `thinking_json = ?`，参数列表（`input.id` 之前）加：

```typescript
    input.thinkingJson !== undefined
      ? input.thinkingJson === null
        ? null
        : JSON.stringify(input.thinkingJson)
      : existing.thinkingJson != null
        ? JSON.stringify(existing.thinkingJson)
        : null,
```

- [ ] **Step 4: ipc.handlers.ts 透传**

`agent:createCustom`（:140-160）与 `agent:updateDefinition`（:169 起）两个 handler 以整对象透传 crud 函数（createCustom :160 为 `createCustomDef(workspaceId, input)`），Step 3 已扩类型故**无需改 handler 逻辑**；仅当 handler 内有显式 inline 入参类型时，在其对象类型中补 `thinkingJson?: import('../llm/provider-presets').ThinkingConfig | null;`。验证：Task 7 完成后双端 typecheck 通过即证明链路闭合。

- [ ] **Step 5: 跑测试确认通过 + crud 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/agent-def-thinking.test.ts && npx pnpm@9.0.0 vitest run tests/agent/crud.test.ts
```
预期：PASS（`rowToDef` 增字段对既有断言是 additive；若 crud.test.ts 文件名不同，跑 `npx pnpm@9.0.0 vitest run tests/agent/` 全目录）。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/crud.ts electron/src/main/agent/ipc.handlers.ts electron/tests/agent/agent-def-thinking.test.ts
git commit -m "feat: agent 定义 thinkingJson 数据链（两级配置 agent 级）"
```

---

### Task 7: IPC 面 + 双端类型对齐

**Files:**
- Modify: `electron/src/main/agent/provider-ipc.ts`
- Modify: `electron/src/preload/index.ts`
- Modify: `renderer/src/ipc/types.d.ts`

**Interfaces:**
- Consumes: `listProviderPresets`（Task 1）、`setProviderModelThinking`（Task 3）、Task 3/6 的 electron 端类型。
- Produces: `ipc.provider.listPresets()` / `ipc.provider.setModelThinking(id, modelId, config | null)`；renderer `ProviderModel.reasoning/thinkingJson/effectiveWindow`、`ModelProvider.presetKey`、`AgentDefinition.thinkingJson`、agent 输入 `thinkingJson`——Task 8/9/10 消费。

- [ ] **Step 1: provider-ipc.ts 注册两个 handler**

import 区改为：

```typescript
import { setProviderModelThinking } from './provider-crud';
import { listProviderPresets } from '../llm/provider-presets';
```

`registerProviderHandlers` 内（`provider:removeModel` 注册之后）加：

```typescript
  // ─── 供应商预设（spec 2026-09-09-provider-presets §6）───────────────────────

  // 预设目录（只读静态数据，无密钥）
  ipcMain.handle('provider:listPresets', () => listProviderPresets());

  // 模型级思维配置默认；非法形状由 setProviderModelThinking 源头拒绝 → IPC error
  ipcMain.handle(
    'provider:setModelThinking',
    (_e, id: string, modelId: string, config: Parameters<typeof setProviderModelThinking>[2]) => {
      setProviderModelThinking(id, modelId, config);
    },
  );
```

- [ ] **Step 2: preload/index.ts 桥接**

`provider` 命名空间（:92-107）内 `removeModel` 之后加：

```typescript
    listPresets: () => invoke('provider:listPresets'),
    setModelThinking: (id, modelId, config) => invoke('provider:setModelThinking', id, modelId, config),
```

- [ ] **Step 3: types.d.ts（renderer）双端对齐**

3a. `ProviderPlatform` 定义附近加镜像类型（与 electron 端 `llm/provider-presets` 结构对齐，仅结构对齐不含逻辑）：

```typescript
/** ─── 供应商预设（与 electron 端 llm/provider-presets 对齐，v31 起） ─── */
export type ThinkingWire = 'toggle' | 'toggle-effort' | 'effort' | 'anthropic-budget';

export type ReasoningCapability =
  | { kind: 'none' }
  | { kind: 'toggle' }
  | { kind: 'effort'; values: readonly string[]; default: string };

export interface ThinkingConfig {
  mode: 'auto' | 'off' | 'on';
  effort: string | null;
}

export interface PresetModel {
  id: string;
  contextWindow: number;
  outputTokens: number;
  reasoning: ReasoningCapability;
  thinkingWire?: ThinkingWire;
}

export interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
  platform: ProviderPlatform;
  thinkingWire: ThinkingWire;
  docsUrl?: string;
  fetchListHint?: boolean;
  models: PresetModel[];
}
```

3b. `ProviderModel` 加三个字段（`contextWindow` 后）：

```typescript
  /** 模型级思维配置（用户设置）；null=未配置（auto） */
  thinkingJson: ThinkingConfig | null;
  /** 思维模式能力（服务端 resolve：预设表→正则目录；只读） */
  reasoning: ReasoningCapability;
  /** resolve 链生效窗口（用户列→预设→目录）；null=未知 */
  effectiveWindow: number | null;
```

3c. `ModelProvider` 加（`platform` 后）：

```typescript
  /** 来源预设 key；null=自定义供应商（v31 起） */
  presetKey: string | null;
```

3d. renderer 侧 `AgentDefinition` 加：

```typescript
  /** agent 级思维模式覆盖；NULL=继承模型级（v31 起） */
  thinkingJson?: ThinkingConfig | null;
```

3e. `ApiSurface` 的 `provider` 段加两个方法（与 preload 一一对应）：

```typescript
    listPresets: () => Promise<ProviderPreset[]>;
    setModelThinking: (
      providerId: string,
      modelId: string,
      config: ThinkingConfig | null,
    ) => Promise<void>;
```

3f. `ApiSurface` 的 `agent.createCustom` / `agent.updateDefinition` 入参对象类型各加：

```typescript
      thinkingJson?: ThinkingConfig | null;
```

- [ ] **Step 4: 双端 typecheck**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```
预期：双 workspace 0 error。若 `agent:createCustom` handler inline 入参类型报缺字段，按 Task 6 Step 4 补。

- [ ] **Step 5: electron 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/provider-crud-presets.test.ts
```
预期：PASS。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/provider-ipc.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts
git commit -m "feat: provider:listPresets/setModelThinking IPC 与双端类型对齐"
```

---

### Task 8: ProviderDialog 预设选择两段式

**Files:**
- Modify: `renderer/src/components/settings/ProviderDialog.tsx`（整体重写，保留自定义路径）
- Test: `renderer/src/components/settings/ProviderDialog.preset.test.tsx`（新建，贴源）

**Interfaces:**
- Consumes: `ipc.provider.listPresets()` / `ProviderPreset` / `ModelProvider.presetKey`（Task 7）、`useProviderStore`。
- Produces: 创建供应商时 `provider.create({..., presetKey})` 触发 Task 3 种子。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/settings/ProviderDialog.preset.test.tsx
//
// 预设两段式：选卡 → 预填 → 提交带 presetKey；自定义路径回归（spec §7.1）。
// window.api mock 与 ipc client Proxy 约定一致（Object.assign 全局）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderDialog } from './ProviderDialog';
import type { ModelProvider, ProviderPreset } from '../../ipc/types';

const presets: ProviderPreset[] = [
  {
    key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai', thinkingWire: 'toggle-effort',
    models: [
      { id: 'glm-5.3', contextWindow: 1000000, outputTokens: 128000, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' } },
    ],
  },
  {
    key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    platform: 'openai', thinkingWire: 'effort', fetchListHint: true, models: [],
  },
];

const created: ModelProvider = {
  id: 'p1', name: '智谱 GLM', baseUrl: '', defaultModel: null,
  isDefault: false, createdAt: '', platform: 'openai', presetKey: 'zhipu',
};
const create = vi.fn(async () => created);

function mockApi(overrides?: Record<string, unknown>): void {
  Object.assign(globalThis, {
    window: {
      api: {
        provider: {
          listPresets: async () => presets,
          create,
          listModels: async () => [],
          list: async () => [],
          testConnection: async () => ({ ok: true }),
          ...overrides,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
});

describe('ProviderDialog 预设两段式', () => {
  it('打开即显示预设卡片（品牌名 + 拉取提示）', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('智谱 GLM')).toBeTruthy();
    expect(screen.getByText(/创建后可拉取模型列表/)).toBeTruthy();
  });

  it('点选预设 → 表单预填（名称/BaseURL/平台）→ 提交带 presetKey', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    expect(await screen.findByDisplayValue('https://open.bigmodel.cn/api/paas/v4')).toBeTruthy();
    expect(screen.getByDisplayValue('智谱 GLM')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ presetKey: 'zhipu', platform: 'openai' });
  });

  it('自定义入口保留手填路径（无 presetKey）', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('自定义供应商'));
    fireEvent.change(screen.getByLabelText(/^名称$/), { target: { value: 'My' } });
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: 'https://x.test/v1' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0].presetKey).toBeUndefined();
  });

  it('已添加的预设显示徽标（按 presetKey 判重）', async () => {
    mockApi({
      list: async () => [created],
    });
    const { useProviderStore } = await import('../../stores/provider.store');
    useProviderStore.setState({ providers: [], loading: false });
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('已添加')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ProviderDialog.preset.test.tsx
```
预期：FAIL（无预设 UI）。

- [ ] **Step 3: 重写 ProviderDialog.tsx**

```tsx
// renderer/src/components/settings/ProviderDialog.tsx
//
// 添加供应商对话框（仅用于创建；编辑在 ProviderSettings 右列配置卡）。
// v31 两段式（spec §7.1）：第一步预设卡片选择（预填 + 种子模型 + 已添加徽标），
// 第二步表单（预填可改，补 API Key）；底部「自定义供应商」保留旧手填路径。
import { useEffect, useState, type FormEvent } from 'react';
import { Link2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useProviderStore } from '../../stores/provider.store';
import type { ModelProvider, ProviderPreset, ProviderPlatform } from '../../ipc/types';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (created: ModelProvider) => void;
}

export function ProviderDialog({ open, onClose, onSaved }: Props) {
  // view：select=预设选择；form=预设表单（预填）；custom=手填（旧路径）
  const [view, setView] = useState<'select' | 'form' | 'custom'>('select');
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<ProviderPlatform>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const providers = useProviderStore((s) => s.providers);
  const loadProviders = useProviderStore((s) => s.loadProviders);

  useEffect(() => {
    if (!open) return;
    setView('select');
    setPreset(null);
    setName(''); setBaseUrl(''); setApiKey(''); setIsDefault(false);
    setTestResult(null);
    void loadProviders();
    ipc.provider.listPresets().then(setPresets).catch(() => setPresets([]));
  }, [open, loadProviders]);

  const choosePreset = (p: ProviderPreset): void => {
    setPreset(p);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setPlatform(p.platform);
    setView('form');
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await ipc.provider.testConnection({ baseUrl, apiKey, model: '' });
      setTestResult(r.ok ? { ok: true, message: '连接成功' } : { ok: false, message: r.error ?? '连接失败' });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await ipc.provider.create({
        name, baseUrl, apiKey, platform, isDefault,
        ...(view === 'form' && preset ? { presetKey: preset.key } : {}),
      });
      onSaved(created);
      onClose();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  // ── 第一步：预设选择 ──────────────────────────────────────────────────────
  if (view === 'select') {
    return (
      <Dialog open onClose={onClose} title="添加供应商" width={520}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2" data-testid="preset-grid">
            {presets.map((p) => {
              const added = providers.some((x) => x.presetKey === p.key);
              return (
                <button key={p.key} type="button" onClick={() => choosePreset(p)}
                  className="flex flex-col items-start gap-1 rounded border border-subtle bg-surface-2 px-3 py-2 text-left hover:bg-surface-3">
                  <span className="flex w-full items-center justify-between gap-1">
                    <span className="text-sm text-primary">{p.name}</span>
                    {added && (
                      <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-secondary">已添加</span>
                    )}
                  </span>
                  <span className="text-xs text-tertiary">
                    {p.fetchListHint ? '创建后可拉取模型列表' : `预置 ${p.models.length} 个常用模型`}
                  </span>
                </button>
              );
            })}
          </div>
          <Button type="button" variant="ghost" onClick={() => { setPreset(null); setView('custom'); }}>
            自定义供应商
          </Button>
        </div>
      </Dialog>
    );
  }

  // ── 第二步：表单（预设预填可改 / 自定义手填） ──────────────────────────────
  return (
    <Dialog open onClose={() => setView('select')} title={view === 'form' ? `添加 ${preset?.name ?? ''}` : '添加供应商'} width={420}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {view === 'form' && preset?.docsUrl && (
          <a href={preset.docsUrl} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300">
            <Link2 size={12} strokeWidth={1.75} aria-hidden /> 获取 API Key（{preset.name} 控制台）
          </a>
        )}
        <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="平台" value={platform} onChange={(e) => setPlatform(e.target.value as ProviderPlatform)}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </Select>
        <Input label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required
          placeholder="https://open.bigmodel.cn/api/paas/v4" />
        <Input label="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        <Checkbox label="设为默认供应商" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleTest} disabled={testing || !apiKey || !baseUrl}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          {testResult && (
            <span className={testResult.ok ? 'text-xs text-secondary' : 'text-xs text-status-error'}>
              {testResult.message}
            </span>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setView('select')}>返回</Button>
          <Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
```

（`useProviderStore` 若字段名与上述不同——以 `renderer/src/stores/provider.store.ts` 实际导出为准对齐；测试的 `useProviderStore.setState` 片段同调。）

- [ ] **Step 4: 跑测试 + 旧测试回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ProviderDialog.preset.test.tsx src/components/settings/ProviderDialog.test.tsx src/components/settings/ProviderSettings.test.tsx
```
预期：新测试 PASS；旧 `ProviderDialog.test.tsx` 依赖「打开即表单」旧交互的用例补一步 `fireEvent.click(screen.getByText('自定义供应商'))` 进入手填路径后应保持原断言——**不得删除既有断言**。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/settings/ProviderDialog.tsx renderer/src/components/settings/ProviderDialog.preset.test.tsx renderer/src/components/settings/ProviderDialog.test.tsx
git commit -m "feat: ProviderDialog 预设选择两段式（15 家预填 + 种子模型）"
```

---

### Task 9: ProviderModelList thinking 控件与窗口有效值

**Files:**
- Modify: `renderer/src/components/settings/ProviderModelList.tsx`
- Test: `renderer/src/components/settings/ProviderModelList.thinking.test.tsx`（新建，贴源）

**Interfaces:**
- Consumes: `ProviderModel.reasoning / thinkingJson / effectiveWindow`、`ipc.provider.setModelThinking`（Task 7）。
- Produces: 模型级思维默认的 UI 写入路径。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/settings/ProviderModelList.thinking.test.tsx
//
// 模型行思维控件（spec §7.2）：三态 + 档位下拉；kind=none 隐藏；窗口 placeholder 有效值。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderModelList } from './ProviderModelList';
import type { ProviderModel } from '../../ipc/types';

const setModelThinking = vi.fn(async () => undefined);
const models: ProviderModel[] = [
  {
    providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
    effectiveWindow: 1000000,
  },
  {
    providerId: 'p1', modelId: 'glm-4.6', enabled: true, addedAt: 2,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'toggle' },
    effectiveWindow: 200000,
  },
  {
    providerId: 'p1', modelId: 'glm-4.5-air', enabled: true, addedAt: 3,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'none' },
    effectiveWindow: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, {
    window: { api: { provider: {
      listModels: async () => models,
      setModelEnabled: async () => undefined,
      removeModel: async () => undefined,
      addModel: async () => undefined,
      fetchModels: async () => [],
      setModelWindow: async () => undefined,
      setModelThinking,
    } } },
  });
});

describe('模型行思维控件', () => {
  it('effort 模型渲染三态；开启后档位下拉选项=模型 values', async () => {
    render(<ProviderModelList providerId="p1" />);
    const modeSel = await screen.findByLabelText('思维模式 glm-5.3');
    expect(modeSel).toBeTruthy();
    fireEvent.change(modeSel, { target: { value: 'on' } });
    const effortSel = await screen.findByLabelText('思维档位 glm-5.3');
    for (const v of ['low', 'high', 'max']) {
      expect((effortSel as HTMLSelectElement).textContent).toContain(v);
    }
  });

  it('开+选档提交 ThinkingConfig；「默认」提交 null', async () => {
    render(<ProviderModelList providerId="p1" />);
    fireEvent.change(await screen.findByLabelText('思维模式 glm-5.3'), { target: { value: 'on' } });
    fireEvent.change(await screen.findByLabelText('思维档位 glm-5.3'), { target: { value: 'low' } });
    await waitFor(() =>
      expect(setModelThinking).toHaveBeenCalledWith('p1', 'glm-5.3', { mode: 'on', effort: 'low' }),
    );
    fireEvent.change(screen.getByLabelText('思维模式 glm-5.3'), { target: { value: 'auto' } });
    await waitFor(() =>
      expect(setModelThinking).toHaveBeenCalledWith('p1', 'glm-5.3', null),
    );
  });

  it('toggle 模型只有三态无档位；none 模型无控件', async () => {
    render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-4.6');
    expect(screen.queryByLabelText('思维档位 glm-4.6')).toBeNull();
    expect(screen.queryByLabelText('思维模式 glm-4.5-air')).toBeNull();
  });

  it('窗口 placeholder 显示 resolve 有效值（1M / 200K / 自动）', async () => {
    render(<ProviderModelList providerId="p1" />);
    expect((await screen.findByLabelText('上下文窗口 glm-5.3') as HTMLInputElement).placeholder).toBe('1M');
    expect((screen.getByLabelText('上下文窗口 glm-4.6') as HTMLInputElement).placeholder).toBe('200K');
    expect((screen.getByLabelText('上下文窗口 glm-4.5-air') as HTMLInputElement).placeholder).toBe('自动');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ProviderModelList.thinking.test.tsx
```
预期：FAIL。

- [ ] **Step 3: 实现 ProviderModelList.tsx**

3a. import 区加类型与工具函数（`ModelWindowInput` 之前）：

```tsx
import type { ReasoningCapability, ThinkingConfig } from '../../ipc/types';

/** 窗口数字的人类可读缩写（placeholder 用） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${m}M`;
  }
  return `${Math.round(n / 1000)}K`;
}
```

3b. `ModelWindowInput` 的 Props 加 `effectiveWindow: number | null;`，placeholder 替换为：

```tsx
      placeholder={
        contextWindow !== null
          ? formatTokens(contextWindow)
          : effectiveWindow !== null
            ? formatTokens(effectiveWindow)
            : '自动'
      }
```

（用户列有值时 placeholder 显示自身缩写——手动值与目录值直观可辨。）

3c. 新增行内控件组件（`ModelWindowInput` 之后）：

```tsx
/** 行内思维模式控件（spec §7.2）：三态 + 档位下拉；提交模型级默认；kind=none 不渲染 */
function ModelThinkingControl({
  providerId,
  modelId,
  capability,
  config,
  onError,
}: {
  providerId: string;
  modelId: string;
  capability: ReasoningCapability;
  config: ThinkingConfig | null;
  onError: (msg: string) => void;
}): JSX.Element | null {
  if (capability.kind === 'none') return null;
  const mode = config?.mode ?? 'auto';
  const effort = config?.effort ?? (capability.kind === 'effort' ? capability.default : null);

  const commit = async (next: ThinkingConfig | null): Promise<void> => {
    try {
      await ipc.provider.setModelThinking(providerId, modelId, next);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <span className="flex items-center gap-1">
      <select
        aria-label={`思维模式 ${modelId}`}
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'auto') void commit(null);
          else if (v === 'off') void commit({ mode: 'off', effort: null });
          else void commit({ mode: 'on', effort });
        }}
        className="rounded border border-subtle bg-surface-2 px-1 py-0.5 text-xs text-secondary"
      >
        <option value="auto">思维:默认</option>
        <option value="off">思维:关</option>
        <option value="on">思维:开</option>
      </select>
      {capability.kind === 'effort' && mode === 'on' && (
        <select
          aria-label={`思维档位 ${modelId}`}
          value={effort ?? capability.default}
          onChange={(e) => void commit({ mode: 'on', effort: e.target.value })}
          className="rounded border border-subtle bg-surface-2 px-1 py-0.5 text-xs text-secondary"
        >
          {capability.values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      )}
    </span>
  );
}
```

3d. 行渲染：`<ModelWindowInput ... />` 加 prop `effectiveWindow={m.effectiveWindow}`，其后插入：

```tsx
            <ModelThinkingControl
              providerId={providerId}
              modelId={m.modelId}
              capability={m.reasoning}
              config={m.thinkingJson}
              onError={setError}
            />
```

同时更新文件头注释（每行布局补「思维模式三态控件」）。

- [ ] **Step 4: 跑测试 + 既有回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ProviderModelList.thinking.test.tsx src/components/settings/ProviderModelList.test.tsx
```
预期：PASS。旧测试 mock 的 `listModels` 返回无新字段会因 `m.reasoning.kind` 取值炸——旧 mock 数据补 `reasoning: { kind: 'none' }` / `thinkingJson: null` / `effectiveWindow: null`（测试数据升级，不改断言语义）。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/settings/ProviderModelList.tsx renderer/src/components/settings/ProviderModelList.thinking.test.tsx renderer/src/components/settings/ProviderModelList.test.tsx
git commit -m "feat: 模型列表思维模式控件与窗口有效值展示"
```

---

### Task 10: agent 编辑器思维覆盖控件

**Files:**
- Create: `renderer/src/components/agent/ThinkingOverrideControl.tsx`
- Modify: `renderer/src/components/agent/ProviderModelPicker.tsx`（加可选 `onModelInfo`）
- Modify: `renderer/src/components/agent/CreateAgentDialog.tsx` / `DefinitionEditor.tsx` / `MemberEditDialog.tsx`
- Test: `renderer/src/components/agent/ThinkingOverrideControl.test.tsx`（新建，贴源）

**Interfaces:**
- Consumes: `ipc.provider.listModels`（含 reasoning，Task 7）、`ThinkingConfig` / `ReasoningCapability`、agent createCustom / updateDefinition 的 `thinkingJson`（Task 6/7）。
- Produces: agent 级覆盖 UI（spec §7.3）。

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/agent/ThinkingOverrideControl.test.tsx
//
// agent 级思维覆盖控件（spec §7.3）：跟随/关闭/开启(+档位)；能力 none 时整体隐藏。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingOverrideControl } from './ThinkingOverrideControl';
import type { ReasoningCapability } from '../../ipc/types';

beforeEach(() => {
  Object.assign(globalThis, { window: { api: { provider: {} } } });
});

const EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' };

describe('ThinkingOverrideControl', () => {
  it('能力 none → 不渲染', () => {
    const { container } = render(
      <ThinkingOverrideControl capability={{ kind: 'none' }} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('value=null → 跟随模型设置；选关闭/开启提交覆盖', () => {
    const onChange = vi.fn();
    render(<ThinkingOverrideControl capability={EFFORT} value={null} onChange={onChange} />);
    const sel = screen.getByLabelText('思维模式');
    expect((sel as HTMLSelectElement).value).toBe('inherit');
    fireEvent.change(sel, { target: { value: 'off' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'off', effort: null });
    fireEvent.change(sel, { target: { value: 'on' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'on', effort: 'max' });
  });

  it('effort 能力开启时渲染档位下拉并提交所选档', () => {
    const onChange = vi.fn();
    render(<ThinkingOverrideControl capability={EFFORT} value={{ mode: 'on', effort: 'high' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('思维档位'), { target: { value: 'low' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'on', effort: 'low' });
  });

  it('toggle 能力无档位下拉', () => {
    render(<ThinkingOverrideControl capability={{ kind: 'toggle' }} value={null} onChange={() => {}} />);
    expect(screen.queryByLabelText('思维档位')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/ThinkingOverrideControl.test.tsx
```
预期：FAIL（组件不存在）。

- [ ] **Step 3: 实现 ThinkingOverrideControl.tsx**

```tsx
// renderer/src/components/agent/ThinkingOverrideControl.tsx
//
// agent 级思维模式覆盖（spec §7.3）：跟随模型设置（null）/ 关闭 / 开启(+档位)。
// 受控组件：能力由父组件从 ProviderModelPicker 的 onModelInfo 取得；
// 能力 kind=none 时整体隐藏（该模型不支持思维模式）。
import type { ReasoningCapability, ThinkingConfig } from '../../ipc/types';

interface Props {
  capability: ReasoningCapability | null;
  value: ThinkingConfig | null;
  onChange: (v: ThinkingConfig | null) => void;
}

export function ThinkingOverrideControl({ capability, value, onChange }: Props): JSX.Element | null {
  if (!capability || capability.kind === 'none') return null;
  const mode = value?.mode ?? 'inherit';
  const effort = value?.effort ?? (capability.kind === 'effort' ? capability.default : null);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-secondary">
        思维模式
        <select
          aria-label="思维模式"
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'inherit') onChange(null);
            else if (v === 'off') onChange({ mode: 'off', effort: null });
            else onChange({ mode: 'on', effort });
          }}
          className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary"
        >
          <option value="inherit">跟随模型设置</option>
          <option value="off">关闭</option>
          <option value="on">开启</option>
        </select>
      </label>
      {capability.kind === 'effort' && mode === 'on' && (
        <label className="text-sm text-secondary">
          思维档位
          <select
            aria-label="思维档位"
            value={effort ?? capability.default}
            onChange={(e) => onChange({ mode: 'on', effort: e.target.value })}
            className="mt-1 w-full rounded border border-subtle bg-surface-2 px-2 py-1 text-sm text-primary"
          >
            {capability.values.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
```

- [ ] **Step 4: ProviderModelPicker 加 onModelInfo**

Props 加：

```tsx
  /** 选中模型变化时回传完整模型行（含 reasoning 能力；父组件驱动 ThinkingOverrideControl） */
  onModelInfo?: (m: ProviderModel | null) => void;
```

组件解构加 `onModelInfo`；在 `const enabledModels = ...` 之后加：

```tsx
  // 选中模型信息回调：列表或选择变化时回传（含 reasoning 能力）
  useEffect(() => {
    onModelInfo?.(models.find((m) => m.modelId === modelId && m.enabled) ?? null);
  }, [models, modelId, onModelInfo]);
```

- [ ] **Step 5: 三个编辑器接线**

5a. `CreateAgentDialog.tsx`：

- import 加 `import { ThinkingOverrideControl } from './ThinkingOverrideControl';` 与 `import type { ReasoningCapability, ThinkingConfig } from '../../ipc/types';`
- state 区加：

```tsx
  const [modelCapability, setModelCapability] = useState<ReasoningCapability | null>(null);
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(null);
```

- `<ProviderModelPicker ... />` 加 prop：

```tsx
        onModelInfo={(m) => { setModelCapability(m?.reasoning ?? null); setThinkingJson(null); }}
```

（换模型即重置覆盖，防旧模型档位残留。）

- picker 之后渲染：

```tsx
        <ThinkingOverrideControl capability={modelCapability} value={thinkingJson} onChange={setThinkingJson} />
```

- `ipc.agent.createCustom({...})` 入参加 `thinkingJson,`。

5b. `DefinitionEditor.tsx`：

- 同样加两个 state；def 加载 `useEffect`（edit/configure 分支）补 `setThinkingJson(def.thinkingJson ?? null);`。
- picker 加 `onModelInfo`（同上，换模型重置）；picker 后渲染 `<ThinkingOverrideControl ... />`。
- `createCustom` 入参与 `updateDefinition` 的 `input` 对象各加 `thinkingJson,`。

5c. `MemberEditDialog.tsx`（:62-63 state / :67-68 重置 effect / :121 变化判定 / :127 提交 / :187 picker）：

- 加 state：`const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(def.thinkingJson ?? null);` 与 `modelCapability`；:67-68 重置 effect 补 `setThinkingJson(def.thinkingJson ?? null);`。
- :121 模型变化判定补 `|| thinkingJson !== (def.thinkingJson ?? null)`；:127 提交对象改为 `ipc.agent.updateDefinition({ id: def.id, modelProviderId, modelName, thinkingJson })`。
- :187 picker 加 `onModelInfo`（换模型重置 thinkingJson），其后渲染 `<ThinkingOverrideControl ... />`。

- [ ] **Step 6: 跑测试 + picker 回归 + typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/ThinkingOverrideControl.test.tsx src/components/agent/ProviderModelPicker.test.tsx
cd .. && npx pnpm@9.0.0 typecheck
```
预期：PASS / 双 workspace 0 error。

- [ ] **Step 7: Commit**

```bash
git add renderer/src/components/agent/
git commit -m "feat: agent 编辑器思维模式覆盖控件（跟随/关闭/开启+档位）"
```

---

### Task 11: 全量验证收尾

**Files:**
- Modify: `README.md`（状态区追加一段）

**Interfaces:**
- Consumes: 全部前置任务。
- Produces: 验收证据（typecheck / 测试 / lint）。

- [ ] **Step 1: 双 workspace typecheck**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```
预期：双 workspace 0 error。

- [ ] **Step 2: 双 workspace 全量测试**

```bash
npx pnpm@9.0.0 test
```
预期：全绿。任何与本功能相关的失败先修复再继续；与本功能无关的预存失败单独记录，不扩scope。

- [ ] **Step 3: lint（如配置）**

```bash
cd electron && npx pnpm@9.0.0 lint 2>/dev/null || true
```
预期：无 error（`no-explicit-any` 等红线零触发）。

- [ ] **Step 4: README 状态区追加**

在 `README.md` 状态区顶部（v2.2.0-p1 条目之前）插入：

```markdown
**v2.2.1 — 供应商预设与模型思维模式（开发中，未发布）**

供应商新建预设化 + 思维模式两级配置。spec 见 `docs/specs/2026-09-09-provider-presets-design.md`，实施计划见 `docs/plans/2026-09-09-provider-presets.md`。

- **供应商预设目录**——15 家手写预设（国内直连 5 + 国际直连 6 + 聚合/本地 4）：ProviderDialog 两段式（预设卡片 → 预填表单 + API Key），预设模型种子幂等写入（INSERT OR IGNORE，不覆盖用户改动），聚合/本地商引导「获取模型列表」；`model_providers.preset_key` 标记来源（「已添加」徽标）
- **内置目录升级**——`model-catalog.ts` 条目增加思维模式能力（`ReasoningCapability`：none/toggle/effort{values,default}）+ 补旗舰缺位（GLM-5.x 1M / DeepSeek V4 1M+384K / Kimi K3 1M / gemini-3）
- **思维模式两级配置（migration v31）**——`provider_models.thinking_json`（模型级默认）+ `agent_definitions.thinking_json`（agent 级覆盖，NULL=继承）；`resolveThinkingConfig` 单点 resolve（配置四级 fallback + 能力词汇表预设→目录 + 方言模型级覆写→预设级→platform 兜底 + effort 越界钳制回默认）
- **请求注入（wire 方言）**——`createLLMProvider` 第三参实例级持有；四种方言映射表：`toggle` / `toggle-effort`（GLM-5.x、DeepSeek V4：thinking.type + reasoning_effort）/ `effort`（OpenAI、K3：顶层 reasoning_effort）/ `anthropic-budget`（档位→budget_tokens 阶梯 + max_tokens 抬升）；`chatStreamAnthropic` 旧硬编码 always-on 10000 退役为方言驱动（medium 档=10000 保持成本连续）；thinking 解析加 `reasoning` 别名容差
- **UI 三处**——ProviderDialog 预设两段式；模型列表行内思维三态控件 + 档位下拉 + 窗口 placeholder 显示 resolve 有效值（1M/200K/自动）；三个 agent 编辑器（Create/Definition/MemberEdit）「思维模式：跟随/关闭/开启(+档位)」覆盖控件
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: 供应商预设与思维模式 README 状态更新"
```

---

## 自审记录（writing-plans Self-Review）

**1. Spec 覆盖对照**

| spec 章节 | 落点任务 |
|---|---|
| §2 预设目录 + 收录清单 + 种子语义 | Task 1（数据）/ Task 3（种子） |
| §3 三列 migration + thinking_json 形状 | Task 3 / Task 6 |
| §4 三条 resolve 链 + AGENT_CONFIG 定型 | Task 3（窗口链已有，富化 effectiveWindow）/ Task 4 |
| §5 注入链 + 方言映射表 + 解析侧核对 | Task 5（映射表 + reasoning 别名容差 + Anthropic thinking_delta 已有） |
| §6 IPC 契约（listPresets / create presetKey / setModelThinking / listModels reasoning / agent 透传） | Task 3 / Task 6 / Task 7 |
| §7.1 ProviderDialog 两段式 | Task 8 |
| §7.2 模型行 thinking 控件 + 窗口有效值 | Task 9 |
| §7.3 agent 覆盖控件 | Task 10 |
| §8 错误处理（越界钳制 / 4xx 透传 / 种子幂等 / migration 兼容） | Task 4（钳制）/ Task 3（幂等 + 三列可空测试）/ 4xx 沿现有错误路径不新增代码 |
| §9 测试矩阵 | 各 Task Step 1 + Task 11 全量验证 |
| §10 切片 | Task 1-4=P1、Task 5-6=P2、Task 7-10=P3、Task 11=P4 |

**2. 占位符扫描**：无 TBD / TODO / 「适当处理」类占位。Task 1 Step 4 是受控的数据核对步骤（附 6 个官方 URL 与处置规则），非未决设计。Task 6 Step 4 / Task 8 Step 3 括注为「与实际 store/handler 形状对齐」的核对说明，主路径代码完整。

**3. 类型一致性**：`ThinkingWire` / `ReasoningCapability` / `ThinkingConfig` / `ThinkingRequest` 全链同名（Task 1 定义 → Task 4/5/7 消费）；`thinking_json` DB 列名、`thinkingJson` TS 字段名、`presetKey`/`preset_key` 全文一致；`applyOpenAIThinking` / `applyAnthropicThinking` 在 Task 5 定义并在测试中同名 import；`onModelInfo` 在 Task 10 Step 4 定义、Step 5 三处同名消费；`setModelThinking` IPC 通道名 preload 与 types.d.ts 一致。

**4. 已知实现期核对点（受控）**：① Task 1 Step 4 六家厂商数字；② Task 5 Step 4 既有流式测试若锁了 Anthropic 旧硬编码需按新语义修正断言；③ Task 8 Step 3 provider.store 字段名以实际导出为准（附了对齐规则）。

---

## 执行交接

按 writing-plans 惯例，本计划保存后向用户提供两种执行方式：

1. **Subagent-Driven（推荐）**——每任务派发全新子代理执行，任务间两阶段 review；
2. **Inline Execution**——当前会话内按 executing-plans 批量执行 + 检查点。

（Task 1-6 electron 主进程链有顺序依赖；Task 8/9/10 renderer 三任务在 Task 7 后可并行。）
