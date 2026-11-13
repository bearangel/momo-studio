# 首启引导体验优化（Onboarding UX Overhaul）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-11-13-onboarding-ux-overhaul-design.md` 的 T1–T6 六主题：模型列表动态拉取、跳过引导后必填工作空间页、终点直通快速会话、三处交互 bug 清理、等待反馈与预告文案、TitleBar 产品标识。

**Architecture:** 主进程从 `fetchRemoteModels` 抽共享底层并新增未落库 `provider:probeModels` 通道（零副作用）；renderer 侧向导 ProviderStep 接字段级拉取状态机；App 分支矩阵插入 WorkspaceGate；DoneStep 复用 `session.store.createQuickSession` 全链。既有 onboarding 语义（幂等预填、C1 闩锁、markDone 收闩）不动。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（Vite ESM）+ zustand + vitest + lucide-react。

**Spec:** `docs/specs/2026-11-13-onboarding-ux-overhaul-design.md`

## Global Constraints

- Node 24 线（`.nvmrc` 已钉）；包管理一律 `npx pnpm@9.0.0`；测试命令见 AGENTS.md（renderer 贴源单测、electron 集中 `electron/tests/` 镜像结构）
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- renderer 新代码只用语义 token（`bg-surface-*` / `text-secondary`…），图标 lucide-react 16px / stroke 1.75，状态色走 `lib/task-status.ts`；禁 inline 硬编码颜色
- 所有代码注释中文；Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:`）；**一律不动版本号**
- IPC 契约改动必须同步 `renderer/src/ipc/types.d.ts` 与 `electron/src/preload/index.ts`，且两 workspace `npx pnpm@9.0.0 typecheck` 双过
- mock 保真纪律（momo-test-rules）：mock 打在 fetch/IPC 边界，用真实响应形状，不 mock 到两跳以外

## Review Focus

1. **anthropic 平台 fetchModels 回归**：现行 `fetchRemoteModels` 一律 Bearer 头打 anthropic 原生 API 必 401；共享底层重构后 anthropic 走 `x-api-key` + `anthropic-version`——Task 1 测试锁定（openai Bearer 不变 + anthropic 新头）。
2. **超长模型目录**：供应商返回 200+ 模型时 `probeModels` 截断并置 `truncated: true`，UI 下拉不爆量——Task 1（截断）+ Task 3（下拉消费 truncated 提示）测试锁定。
3. **等待期转手动后的迟到结果**：`generatePlan` 在用户已转手动后 resolve，不得把状态拉回 preview——Task 9 用 abandoned ref + 假 promise 迟到 resolve 测试锁定。
4. **C1 闩锁与 Gate 互斥**：向导进行期镜像推送使 workspaces 变非空，不得闪现 WorkspaceGate（wizardOpen 优先）——Task 5 App 分支矩阵测试锁定。
5. **DoneStep 无默认 agent 降级**：`createQuickSession` 失败（NO_DEFAULT_AGENT / IPC 错误）→ toast 降级，不阻断进入主界面——Task 7 测试锁定。

---

### Task 1: T1 后端 — 共享模型拉取底层 + `provider:probeModels` IPC

**Files:**
- Modify: `electron/src/main/agent/provider-crud.ts:402-451`（fetchRemoteModels 重构 + 新增 probeModels）
- Modify: `electron/src/main/agent/provider-ipc.ts:113` 附近（注册 handler）
- Modify: `renderer/src/ipc/types.d.ts` provider 面（:2622 fetchModels 附近加签名）
- Modify: `electron/src/preload/index.ts:244` 附近（透传）
- Test: `electron/tests/agent/provider-probe-models.test.ts`（新建）
- Test: `electron/tests/agent/provider-fetch-models.test.ts`（既有，回归不动）

**Interfaces:**
- Produces: `fetchModelIdsFromEndpoint(baseUrl: string, apiKey: string, platform: ProviderPlatform, timeoutMs?: number): Promise<string[]>`（provider-crud.ts 导出，后续任务不直接用）
- Produces: `probeModels(input: { baseUrl: string; apiKey: string; platform: 'openai' | 'anthropic' }): Promise<{ models: string[]; truncated: boolean }>`（provider-crud.ts 导出）
- Produces（renderer 契约）: `ipc.provider.probeModels(input): Promise<{ models: string[]; truncated: boolean }>`——Task 3/4 消费
- 不变量: `ipc.provider.fetchModels(id): Promise<string[]>` 签名与语义不变（openai 行为逐字节等价）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/provider-probe-models.test.ts
// probeModels（spec 2026-11-13 §3.2）：未落库先拉 /models、平台头分派、10s 真中断、200 截断。
// mock 打在 global.fetch（真实响应形状），零副作用断言：不触 DB / keychain。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const crud = await import('../../src/main/agent/provider-crud');

let fetched: Array<{ url: string; init: RequestInit | undefined }> = [];
function ok(models: string[]) {
  return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
}
beforeEach(() => {
  fetched = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetched.push({ url: String(url), init });
    return ok(['m-b', 'm-a']);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('probeModels', () => {
  const base = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' } as const;

  it('openai 平台：Bearer 头 + {base}/models + 升序返回', async () => {
    const r = await crud.probeModels({ ...base, platform: 'openai' });
    expect(r).toEqual({ models: ['m-a', 'm-b'], truncated: false });
    expect(fetched[0]!.url).toBe('https://api.example.com/v1/models');
    expect((fetched[0]!.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-x');
  });

  it('anthropic 平台：x-api-key + anthropic-version 头（修正现行 Bearer 通吃）', async () => {
    await crud.probeModels({ ...base, platform: 'anthropic' });
    const h = fetched[0]!.init!.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-x');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['Authorization']).toBeUndefined();
  });

  it('401 → 中文错误明示 key 无效', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"bad key"}', { status: 401 }));
    await expect(crud.probeModels({ ...base, platform: 'openai' })).rejects.toThrow(
      /API Key 无效或无权限/,
    );
  });

  it('超 200 条 → 截断 + truncated:true', async () => {
    vi.stubGlobal(
      'fetch',
      async () => ok(Array.from({ length: 300 }, (_, i) => `m-${i}`)),
    );
    const r = await crud.probeModels({ ...base, platform: 'openai' });
    expect(r.models).toHaveLength(200);
    expect(r.truncated).toBe(true);
  });

  it('10s 超时真中断（AbortController）', async () => {
    vi.stubGlobal(
      'fetch',
      (_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.useFakeTimers();
    const p = crud.probeModels({ ...base, platform: 'openai' });
    const assertion = expect(p).rejects.toThrow(/获取模型列表超时/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });

  it('非 JSON / 形状不符 → 中文错误', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 200 }));
    await expect(crud.probeModels({ ...base, platform: 'openai' })).rejects.toThrow(
      /响应不是有效 JSON|不符合 \/models 约定/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/provider-probe-models.test.ts --pool=forks`
Expected: FAIL —— `probeModels is not a function`（导出不存在）。

- [ ] **Step 3: 实现（重构 fetchRemoteModels + 新增 probeModels）**

`electron/src/main/agent/provider-crud.ts`：将 fetchRemoteModels 的 URL 校验/协议白名单/回环 warn/fetch/解析整体抽为共享底层，加平台头分派与可选超时；原函数变薄壳：

```ts
/** 平台请求头分派（spec 2026-11-13 §3.2）：openai=Bearer；anthropic=x-api-key+version */
function modelEndpointHeaders(apiKey: string, platform: string): Record<string, string> {
  if (platform === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/** 共享底层：URL 校验 + 协议白名单 + 回环 http 放行 warn + GET {base}/models + 解析。
 *  timeoutMs 缺省不超时（fetchRemoteModels 现行行为）；probeModels 传 10s。 */
export async function fetchModelIdsFromEndpoint(
  baseUrl: string,
  apiKey: string,
  platform: string,
  timeoutMs?: number,
): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('baseUrl 格式无效');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http/https 协议');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    logger.warn('模型列表拉取 baseUrl 为非本机 http（明文传输），继续（用户自担）', {
      host: parsed.hostname,
    });
  }
  const ctrl = timeoutMs !== undefined ? new AbortController() : undefined;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: modelEndpointHeaders(apiKey, platform),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`API Key 无效或无权限（HTTP ${resp.status}）`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let body: unknown;
    try {
      body = await resp.json();
    } catch (err) {
      throw new Error(`响应不是有效 JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error('响应格式不符合 /models 约定（缺少 data 数组）');
    const ids: string[] = [];
    for (const item of data) {
      const id = (item as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('响应格式不符合 /models 约定（data 条目缺少字符串 id）');
      }
      ids.push(id);
    }
    return ids;
  } catch (err) {
    if (ctrl?.signal.aborted) throw new Error('获取模型列表超时（10 秒），请重试或手输模型名');
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

fetchRemoteModels 主体替换为（保留函数签名与现有导出）：

```ts
export async function fetchRemoteModels(providerId: string): Promise<string[]> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`供应商不存在: ${providerId}`);
  const apiKey = await getProviderApiKey(providerId);
  return fetchModelIdsFromEndpoint(provider.baseUrl, apiKey ?? '', provider.platform);
}
```

同文件新增（spec §3.2 出参与上限）：

```ts
/** probeModels 上限（spec §3.2）：超出截断 + truncated 标志 */
const PROBE_MODELS_LIMIT = 200;
const PROBE_MODELS_TIMEOUT_MS = 10_000;

/** 未落库先拉模型列表（引导表单帮填，spec 2026-11-13 §3.2）：零副作用——
 *  不写 DB / keychain，key 即用即弃；与 fetchRemoteModels 共享同一底层。 */
export async function probeModels(input: {
  baseUrl: string;
  apiKey: string;
  platform: 'openai' | 'anthropic';
}): Promise<{ models: string[]; truncated: boolean }> {
  if (!input.baseUrl.trim() || !input.apiKey.trim()) {
    throw new Error('baseUrl 与 API Key 不能为空');
  }
  const ids = await fetchModelIdsFromEndpoint(
    input.baseUrl.trim(),
    input.apiKey,
    input.platform,
    PROBE_MODELS_TIMEOUT_MS,
  );
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  return {
    models: sorted.slice(0, PROBE_MODELS_LIMIT),
    truncated: sorted.length > PROBE_MODELS_LIMIT,
  };
}
```

`electron/src/main/agent/provider-ipc.ts`（:113 fetchModels 注册旁）：

```ts
// 未落库先拉模型列表（引导表单帮填，spec 2026-11-13 §3.2）——零副作用
ipcMain.handle('provider:probeModels', (_e, input: { baseUrl: string; apiKey: string; platform: 'openai' | 'anthropic' }) =>
  probeModels(input),
);
```

（顶部 import 行加 `probeModels`。）

`renderer/src/ipc/types.d.ts` provider 面（fetchModels 签名后）：

```ts
/** T1 probe：未落库先拉远端模型 id（引导表单帮填；零副作用，key 不落 keychain） */
probeModels(input: { baseUrl: string; apiKey: string; platform: ProviderPlatform }): Promise<{ models: string[]; truncated: boolean }>;
```

`electron/src/preload/index.ts` provider 段（fetchModels 行后）：

```ts
// T1 probe：未落库先拉模型列表（引导帮填）
probeModels: (input) => invoke('provider:probeModels', input),
```

- [ ] **Step 4: 跑测试确认通过 + 既有回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/provider-probe-models.test.ts tests/agent/provider-fetch-models.test.ts --pool=forks`
Expected: 全 PASS（fetch-models 既有用例不得回归——openai 行为逐字节等价）。

- [ ] **Step 5: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双过。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/provider-crud.ts electron/src/main/agent/provider-ipc.ts renderer/src/ipc/types.d.ts electron/src/preload/index.ts electron/tests/agent/provider-probe-models.test.ts
git commit -m "feat(provider): probeModels 未落库先拉模型列表 + 平台头分派共享底层"
```

---

### Task 2: T1/T2 静态预览稿（P1 门禁，阻塞 Task 3–6）

**Files:**
- Create: `.omo/previews/onboarding-t1-model-field.html`（三形态模型字段三态：custom 手输↔下拉、preset 合并刷新、existing 刷新）
- Create: `.omo/previews/onboarding-t2-workspace-gate.html`（WorkspaceGate 整页 + MiddlePanel 新空态对照）

**Interfaces:** 无代码接口；产出用户确认记录（会话内）。**未经用户确认不得进入 Task 3。**

- [ ] **Step 1: 按 momo-ui-preview-rules 产出两份静态稿**（语义 token 同名 class、16/1.75 图标、真文案；每稿含关键态：idle/fetching/fetched/error + truncated 提示；Gate 稿含目录确认层形态引用）
- [ ] **Step 2: 交用户确认**（`open` 两份 html，等待明确「可以」；有修改意见先改稿再确认）

---

### Task 3: T1 前端 — ProviderStep custom 形态模型字段三态

**Files:**
- Modify: `renderer/src/components/onboarding/ProviderStep.tsx`（custom 段 :237-266 + 状态区）
- Test: `renderer/src/components/onboarding/ProviderStep.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ipc.provider.probeModels(input): Promise<{ models: string[]; truncated: boolean }>`（Task 1）
- Produces: 无对外新接口（组件内部状态机）

- [ ] **Step 1: 写失败测试**（追加到 ProviderStep.test.tsx，vi.mock('../../ipc/client') 既有模式扩展 probeModels mock）

```tsx
describe('custom 形态模型拉取（spec T1）', () => {
  it('baseUrl/key 未填全时「获取模型列表」禁用', async () => {
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await userEvent.click(screen.getByText('+ 自定义供应商'));
    const btn = screen.getByRole('button', { name: '获取模型列表' });
    expect(btn).toBeDisabled();
  });

  it('拉取成功 → Input 变 Select（含「手动输入…」项）；选手动输入回退 Input', async () => {
    mocked.ipc.provider.probeModels.mockResolvedValue({ models: ['glm-5.3', 'glm-5.3-air'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await userEvent.click(screen.getByText('+ 自定义供应商'));
    await userEvent.type(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), 'http://x/v1');
    await userEvent.type(screen.getByPlaceholderText('sk-...'), 'sk-1');
    await userEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    const select = await screen.findByLabelText('模型');
    expect(select).toBeInTheDocument(); // fetched 态渲染 Select
    await userEvent.selectOptions(select, '__manual__');
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument(); // 回退手输
  });

  it('拉取失败 → 保留手输 Input + 显示错误；truncated 提示可见', async () => {
    mocked.ipc.provider.probeModels.mockRejectedValue(new Error('HTTP 401'));
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await userEvent.click(screen.getByText('+ 自定义供应商'));
    await userEvent.type(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), 'http://x/v1');
    await userEvent.type(screen.getByPlaceholderText('sk-...'), 'sk-1');
    await userEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument();
    expect(await screen.findByText(/获取失败：HTTP 401/)).toBeInTheDocument();
    mocked.ipc.provider.probeModels.mockResolvedValue({ models: ['m-1', 'm-2'], truncated: true });
    await userEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    expect(await screen.findByText(/仅显示前 200 个/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/onboarding/ProviderStep.test.tsx`；Expected: FAIL（无「获取模型列表」按钮）。

- [ ] **Step 3: 实现**（custom 段模型字段状态机）

```tsx
// 状态区新增：
const [modelFetch, setModelFetch] = useState<{ status: 'idle' | 'fetching' | 'fetched'; models: string[]; truncated: boolean }>({ status: 'idle', models: [], truncated: false });
const MANUAL_OPTION = '__manual__';

const fetchCustomModels = async (): Promise<void> => {
  if (modelFetch.status === 'fetching') return;
  setModelFetch({ status: 'fetching', models: [], truncated: false });
  try {
    const r = await ipc.provider.probeModels({ baseUrl: baseUrl.trim(), apiKey, platform });
    setModelFetch({ status: 'fetched', models: r.models, truncated: r.truncated });
    if (r.models.length > 0 && !r.models.includes(modelId)) setModelId(r.models[0]!);
    setModelError(null);
  } catch (e) {
    setModelFetch({ status: 'idle', models: [], truncated: false });
    setModelError(`获取失败：${e instanceof Error ? e.message : String(e)}——可手输模型名继续`);
  }
};
```

custom 段模型名 Input 替换为条件渲染：`modelFetch.status === 'fetched'` 渲染 Select（options = models + `__manual__`「手动输入…」，onChange 命中 MANUAL_OPTION 时 `setModelFetch({status:'idle',…})` 回退 Input）；否则渲染原 Input + 旁边按钮：

```tsx
<div className="flex items-end gap-2">
  <div className="flex-1">{/* 上述条件渲染字段（label「模型名」） */}</div>
  <Button type="button" variant="secondary" size="sm"
    onClick={() => void fetchCustomModels()}
    disabled={modelFetch.status === 'fetching' || !baseUrl.trim() || !apiKey.trim()}>
    {modelFetch.status === 'fetching' ? <Loader2 size={13} strokeWidth={1.75} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={1.75} />}
    获取模型列表
  </Button>
</div>
{modelFetch.truncated && <p className="text-[11px] text-status-warning">该供应商模型较多，仅显示前 200 个</p>}
{modelError && <div className="text-xs text-status-error">{modelError}</div>}
```

（RefreshCw 加入 lucide import；modelError 状态新增；chips 重选时重置 modelFetch。）

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令；Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/onboarding/ProviderStep.tsx renderer/src/components/onboarding/ProviderStep.test.tsx
git commit -m "feat(onboarding): 自定义供应商模型列表拉取（手输↔下拉三态）"
```

---

### Task 4: T1 前端 — preset「获取最新」合并 + existing 刷新

**Files:**
- Modify: `renderer/src/components/onboarding/ProviderStep.tsx`（preset 段 :209-236 / existing 段 :137-176）
- Test: `renderer/src/components/onboarding/ProviderStep.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ipc.provider.probeModels`（preset 用预填 baseUrl + 用户 key）；`ipc.provider.fetchModels(id)` + `ipc.provider.listModels(id)`（existing 既有通道）
- Produces: 无

- [ ] **Step 1: 写失败测试**

```tsx
describe('preset 形态获取最新（spec T1）', () => {
  const enterPreset = async (): Promise<void> => {
    await userEvent.click(screen.getByText('智谱 GLM'));
    await userEvent.type(screen.getByPlaceholderText('sk-...'), 'sk-1');
  };
  it('拉取成功 → options = 远端在前 + preset.models 去重合并', async () => {
    mocked.ipc.provider.listPresets.mockResolvedValue([
      { key: 'glm', name: '智谱 GLM', platform: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docsUrl: null, models: [{ id: 'glm-4.6' }] },
    ]);
    mocked.ipc.provider.probeModels.mockResolvedValue({ models: ['glm-5.3'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await enterPreset();
    await userEvent.click(screen.getByRole('button', { name: '获取最新模型' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['glm-5.3', 'glm-4.6']);
  });
  it('拉取失败 → 保留预置 options + 错误行内提示', async () => {
    mocked.ipc.provider.listPresets.mockResolvedValue([
      { key: 'glm', name: '智谱 GLM', platform: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docsUrl: null, models: [{ id: 'glm-4.6' }] },
    ]);
    mocked.ipc.provider.probeModels.mockRejectedValue(new Error('HTTP 500'));
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await enterPreset();
    await userEvent.click(screen.getByRole('button', { name: '获取最新模型' }));
    expect(await screen.findByText(/获取最新失败：HTTP 500/)).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'glm-4.6' })).toBeInTheDocument();
  });
});

describe('existing 形态刷新（spec T1）', () => {
  it('点刷新 → fetchModels(id) 后重拉 listModels 刷新下拉', async () => {
    mocked.ipc.provider.list.mockResolvedValue([{ id: 'p1', name: 'Mock', platform: 'openai', baseUrl: 'http://x/v1', isDefault: false, presetKey: null, lastVerifiedAt: null, defaultModel: null }]);
    mocked.ipc.provider.listModels
      .mockResolvedValueOnce([{ modelId: 'old-m', enabled: true, contextWindow: null, vision: false }])
      .mockResolvedValue([{ modelId: 'old-m', enabled: true, contextWindow: null, vision: false }, { modelId: 'new-m', enabled: true, contextWindow: null, vision: false }]);
    mocked.ipc.provider.fetchModels.mockResolvedValue(['old-m', 'new-m']);
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await userEvent.click(screen.getByText('使用已有供应商'));
    await userEvent.click(screen.getByText('Mock'));
    await userEvent.click(screen.getByRole('button', { name: '刷新模型' }));
    expect(await screen.findByRole('option', { name: 'new-m' })).toBeInTheDocument();
    expect(mocked.ipc.provider.fetchModels).toHaveBeenCalledWith('p1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run 同 Task 3；Expected: FAIL（无「获取最新模型」/existing 无刷新按钮）。

- [ ] **Step 3: 实现**

preset 段：新增 `const [presetRemote, setPresetRemote] = useState<string[] | null>(null);`；Select 的 options 改为 `presetRemote ? [...presetRemote, ...preset.models.map((m) => m.id)].filter((v, i, a) => a.indexOf(v) === i) : preset.models.map((m) => m.id)`；Select 旁刷新按钮（同 Task 3 样式，仅 key 必填启用）：

```tsx
<Button type="button" variant="secondary" size="sm" onClick={() => void refreshPresetModels()} disabled={busyFetch || !apiKey.trim()}>
  {busyFetch ? <Loader2 … /> : <RefreshCw size={13} strokeWidth={1.75} />} 获取最新模型
</Button>
```

```tsx
const refreshPresetModels = async (): Promise<void> => {
  if (!preset || busyFetch) return;
  setBusyFetch(true); setModelError(null);
  try {
    const r = await ipc.provider.probeModels({ baseUrl: preset.baseUrl, apiKey, platform: preset.platform });
    setPresetRemote(r.models);
    if (r.models.length > 0 && !r.models.includes(modelId)) setModelId(r.models[0]!);
  } catch (e) {
    setModelError(`获取最新失败：${e instanceof Error ? e.message : String(e)}——仍可用预置列表`);
  } finally { setBusyFetch(false); }
};
```

（choosePreset 时重置 presetRemote=null；busyFetch 状态新增。）

existing 段：chooseExisting 抽出 `refreshExisting = async (p: ModelProvider)`（现 listModels 逻辑），Select 旁加同款刷新按钮 → `await ipc.provider.fetchModels(p.id)` 后 `await refreshExisting(p)`。

- [ ] **Step 4: 跑测试确认通过**；**Step 5: Commit**

```bash
git add renderer/src/components/onboarding/ProviderStep.tsx renderer/src/components/onboarding/ProviderStep.test.tsx
git commit -m "feat(onboarding): 预设/已有供应商模型列表动态获取与合并"
```

---

### Task 5: T2 — WorkspaceGate 独立必填页 + App 分支 + hideCancel

**Files:**
- Modify: `renderer/src/components/workspace/CreateWorkspaceDialog.tsx:28-32,148`（hideCancel prop）
- Create: `renderer/src/routes/WorkspaceGate.tsx`
- Modify: `renderer/src/App.tsx:48,151-156`（obStatus 保留值 + 分支）
- Test: `renderer/src/routes/WorkspaceGate.test.tsx`（新建）；`renderer/src/components/workspace/CreateWorkspaceDialog.test.tsx`（若在，扩展；否则按贴源规则新建）；`renderer/src/App.test.tsx`（分支矩阵扩展——适配既有结构）

**Interfaces:**
- Produces: `CreateWorkspaceDialog props: { onClose: () => void; embedded?: boolean; hideCancel?: boolean }`（Task 6 消费）
- Produces: `WorkspaceGate()`（无 props；完成 = workspaces store 翻转，App 分支自然退出）
- Consumes: App 既有 `wizardOpen` 闩锁 / `obStatus` / `workspaces`（App.tsx:48 起改为 `const [obStatus, setObStatus] = useState<'pending' | 'completed' | 'skipped'>('pending')`——当前解构丢弃了值）

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/routes/WorkspaceGate.test.tsx
// mock：workspace.store（create 成功后 activeWorkspaceId 翻转语义用真实 store + mock ipc.workspace.create 对齐 WorkspaceStep.test 现行模式）
describe('WorkspaceGate（spec T2）', () => {
  it('渲染标题与内嵌表单，且无任何跳过出口', () => {
    render(<WorkspaceGate />);
    expect(screen.getByText('设置工作空间')).toBeInTheDocument();
    expect(screen.queryByText(/跳过/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument(); // hideCancel
  });
  it('创建成功（activeWorkspaceId 翻转）后自身不再渲染表单', async () => {
    mocked.ipc.workspace.probePath.mockResolvedValue({ exists: true, resolvedPath: '/tmp/ws', hasGit: false });
    mocked.ipc.workspace.create.mockImplementation(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' });
      return { id: 'ws-1', name: 'x', directoryPath: '/tmp/ws' };
    });
    render(<WorkspaceGate />);
    await userEvent.type(screen.getByPlaceholderText('我的项目'), '演示');
    await userEvent.type(screen.getByPlaceholderText('选择或输入目录路径'), '/tmp/ws');
    await userEvent.click(screen.getByRole('button', { name: '创建', exact: true }));
    expect(await screen.queryByPlaceholderText('我的项目')).not.toBeInTheDocument();
  });
});
```

App 分支矩阵（在 App.test.tsx 既有 mockApi 结构上追加——其已 mock ipc client / MainShell 桩）：

```tsx
// 顶部 mockApi 扩展：onboarding: { getStatus: vi.fn() }
it.each([
  { status: 'pending', wsCount: 0, shows: 'wizard' },
  { status: 'skipped', wsCount: 0, shows: 'gate' },
  { status: 'completed', wsCount: 0, shows: 'gate' },
  { status: 'completed', wsCount: 1, shows: 'main' },
])('status=$status ws=$wsCount → $shows（T2 分支矩阵）', async ({ status, wsCount, shows }) => {
  mockApi.onboarding.getStatus.mockResolvedValue({ status });
  mockApi.workspace.list.mockResolvedValue(Array.from({ length: wsCount }, (_, i) => mkWs(`w${i}`)));
  render(<App />);
  await waitFor(() => {
    if (shows === 'wizard') expect(screen.getByText('欢迎使用 Momo Studio')).toBeInTheDocument();
    else if (shows === 'gate') expect(screen.getByText('设置工作空间')).toBeInTheDocument();
    else expect(screen.getByTestId('main-shell')).toBeInTheDocument();
  });
});

it('C1 闩锁：向导进行期 workspaces 变非空不闪 Gate（T2 互斥回归）', async () => {
  mockApi.onboarding.getStatus.mockResolvedValue({ status: 'pending' });
  mockApi.workspace.list.mockResolvedValue([]); // boot 时 0-ws → 向导
  render(<App />);
  await waitFor(() => expect(screen.getByText('欢迎使用 Momo Studio')).toBeInTheDocument());
  // 向导进行期镜像推送使 ws 变非空（闩锁期 workspaces 更新不得卸载向导/不得闪 Gate）
  await act(async () => {
    useWorkspaceStore.setState({ workspaces: [mkWs('mirror')] });
  });
  expect(screen.getByText('欢迎使用 Momo Studio')).toBeInTheDocument();
  expect(screen.queryByText('设置工作空间')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `cd renderer && npx pnpm@9.0.0 vitest run src/routes/WorkspaceGate.test.tsx`；Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

CreateWorkspaceDialog（Props + formFields 底部按钮行）：

```tsx
interface Props {
  onClose: () => void;
  embedded?: boolean;
  /** 向导/WorkspaceGate 场景：无上级界面可关，不渲染取消（spec 2026-11-13 §4.4） */
  hideCancel?: boolean;
}
// formFields 内：
{!hideCancel && (
  <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
)}
```

`renderer/src/routes/WorkspaceGate.tsx`（新）：

```tsx
// WorkspaceGate（spec 2026-11-13 §4）：跳过引导/历史清空后的 0-ws 必填页。
// 无跳过出口——工作空间是 agent 文件操作的前提；创建完成 = activeWorkspaceId
// 翻转 → App 分支自然退回 MainShell（本组件无需自有完成回调）。
import { useEffect } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { CreateWorkspaceDialog } from '../components/workspace/CreateWorkspaceDialog';
import { useWorkspaceStore } from '../stores/workspace.store';

export function WorkspaceGate(): React.JSX.Element {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // 防御：创建完成后若 App 未来得及重渲（理论不发生），本组件隐藏表单防双入口
  useEffect(() => {
    if (activeWorkspaceId) useWorkspaceStore.getState().load();
  }, [activeWorkspaceId]);
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar wizardMode />
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6">
        <div className="w-[440px] mb-3">
          <h2 className="text-[15px] font-semibold text-primary mb-1">设置工作空间</h2>
          <p className="text-xs text-tertiary">agent 的文件操作都发生在这个目录里，创建后即可开始使用</p>
        </div>
        {!activeWorkspaceId && (
          <CreateWorkspaceDialog onClose={() => undefined} embedded hideCancel />
        )}
      </div>
    </div>
  );
}
```

App.tsx：`:48` 改 `const [obStatus, setObStatus] = useState<'pending' | 'completed' | 'skipped'>('pending');`；`:154` 向导分支后插入：

```tsx
// T2（spec 2026-11-13 §4.1）：0-ws 且引导非 pending（跳过/完成但空间被清空）→
// 必填工作空间页；wizardOpen 闩锁优先（C1：向导进行期 ws 创建不得闪 Gate）
if (!wizardOpen && workspaces.length === 0 && obStatus !== 'pending') {
  return <WorkspaceGate />;
}
```

（import WorkspaceGate。）

- [ ] **Step 4: 跑测试确认通过**（WorkspaceGate + CreateWorkspaceDialog + App 三处）— Run: `cd renderer && npx pnpm@9.0.0 vitest run src/routes/WorkspaceGate.test.tsx src/App.test.tsx src/components/workspace/CreateWorkspaceDialog.test.tsx`（无 App.test/Dialog.test 则建最小档，mock 模式对齐 OnboardingWizard.test）。

- [ ] **Step 5: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck && git add renderer/src/routes/WorkspaceGate.tsx renderer/src/routes/WorkspaceGate.test.tsx renderer/src/App.tsx renderer/src/App.test.tsx renderer/src/components/workspace/CreateWorkspaceDialog.tsx renderer/src/components/workspace/CreateWorkspaceDialog.test.tsx
git commit -m "feat(onboarding): 跳过引导后 WorkspaceGate 必填工作空间页 + hideCancel"
```

---

### Task 6: T2 — MiddlePanel 首启空态退役（嵌入表单 → Dialog）

**Files:**
- Modify: `renderer/src/components/layout/MiddlePanel.tsx:62-80`
- Test: `renderer/src/components/layout/MiddlePanel.test.tsx`（既有断言迁移）

**Interfaces:**
- Consumes: CreateWorkspaceDialog Dialog 形态（无 hideCancel）；`useState` 开关

- [ ] **Step 1: 改写既有测试**（首启空态从「内嵌表单」断言迁到「按钮 + Dialog」：初始仅 EmptyState + 「新建工作空间」按钮；点击后出现 Dialog 标题「新建工作空间」+ 取消按钮存在（对话框形态保留取消））
- [ ] **Step 2: 跑测试确认失败** — Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/layout/MiddlePanel.test.tsx`
- [ ] **Step 3: 实现**：

```tsx
const [wsDialogOpen, setWsDialogOpen] = useState(false);
// 0-ws 主区引导（T2 改造，spec 2026-11-13 §4.3）：嵌入表单退役——正常入口是
// WorkspaceGate；此处仅兜底（理论上 Gate 后不会到 0-ws 主壳），留按钮 + Dialog
if (!workspace) {
  return (
    <div className="flex flex-1 items-center justify-center bg-canvas p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5">
        <EmptyState icon={Folder} title="创建或选择一个工作空间开始"
          description="工作空间是 agent 协作与文件沙箱的根目录；也可先在左侧活动栏进入「工作组」接入节点网络" />
        <Button type="button" onClick={() => setWsDialogOpen(true)}>
          <Plus size={14} strokeWidth={1.75} /> 新建工作空间
        </Button>
        {wsDialogOpen && (
          <CreateWorkspaceDialog onClose={() => { setWsDialogOpen(false); void useWorkspaceStore.getState().load(); }} />
        )}
      </div>
    </div>
  );
}
```

（Plus 入 lucide import；移除 embedded 用法。）

- [ ] **Step 4: 跑测试确认通过**；**Step 5: Commit** — `git commit -m "refactor(workspace): MiddlePanel 首启空态嵌入表单退役为 Dialog 入口"`

---

### Task 7: T3 — DoneStep 自动创建快速会话

**Files:**
- Modify: `renderer/src/components/onboarding/DoneStep.tsx:20-28`
- Test: `renderer/src/components/onboarding/DoneStep.test.tsx`（扩展）

**Interfaces:**
- Consumes: `useSessionStore.getState().createQuickSession(workspaceId: string, groupId?: string): Promise<boolean>`（session.store:514，全链 activate/select/reveal 已内建）；`showToast`
- Produces: 无

- [ ] **Step 1: 写失败测试**

```tsx
it('开始使用 → markDone → createQuickSession(ctx.workspaceId) → finish', async () => {
  const { markDone, createQuickSession, finish } = fakes; // mkCtx 注入 finish spy
  await act(async () => { await userEvent.click(screen.getByText('开始使用')); });
  expect(markDone).toHaveBeenCalledWith({ skipped: false });
  expect(createQuickSession).toHaveBeenCalledWith('ws-1');
  expect(finish).toHaveBeenCalled();
});
it('createQuickSession 失败 → toast 降级，不阻断 finish', async () => {
  // createQuickSession mock 返回 false → expect(showToast).toHaveBeenCalledWith(expect.stringContaining('快速会话创建失败'))
  // finish 仍被调用
});
```

- [ ] **Step 2: 跑测试确认失败**；**Step 3: 实现**：

```tsx
import { useSessionStore } from '../../stores/session.store';
import { showToast } from '../ui/Toast';

const start = async (): Promise<void> => {
  try {
    await ipc.onboarding.markDone({ skipped: false });
  } catch (e) {
    setError(`保存引导状态失败（${e instanceof Error ? e.message : String(e)}），请重试`);
    return; // markDone 失败不建会话（I2 语义：向导不关）
  }
  // T3（spec §5）：终点直通——默认 agent 快速会话即开即用；失败降级不阻断
  const ok = await useSessionStore.getState().createQuickSession(ctx.workspaceId);
  if (!ok) showToast('快速会话创建失败，可稍后在会话列表手动新建');
  ctx.finish();
};
```

（测试对 session.store 的 mock 按 momo-test-rules：mock store 模块而非两跳外的 ipc。）

- [ ] **Step 4: 跑测试确认通过**；**Step 5: Commit** — `git commit -m "feat(onboarding): 完成页开始使用直通默认 agent 快速会话"`

---

### Task 8: T4 — 上一步直跳 provider + 「重新选择」渲染条件

**Files:**
- Modify: `renderer/src/components/onboarding/RequirementStep.tsx:83`、`ManualAgentStep.tsx:113`
- Modify: `renderer/src/components/onboarding/ProviderStep.tsx:282-287`
- Test: 三个组件既有 .test 扩展

**Interfaces:** 无新接口（行为修正）。

- [ ] **Step 1: 写失败测试**

```tsx
// RequirementStep.test / ManualAgentStep.test：
it('上一步 → ctx.go("provider")（不回 workspace 防直通弹回，spec T4）', async () => {
  render(<RequirementStep ctx={ctxSpy} />);
  await userEvent.click(screen.getByText('上一步'));
  expect(ctxSpy.go).toHaveBeenCalledWith('provider');
});
// ProviderStep.test：
it('chips 态无「重新选择」（仅 preset/custom 子表单出现）', async () => {
  render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
  expect(screen.queryByText('重新选择')).not.toBeInTheDocument(); // chips 态
  await userEvent.click(screen.getByText('+ 自定义供应商'));
  expect(screen.getByText('重新选择')).toBeInTheDocument();
});
```

- [ ] **Step 2: 确认失败**；**Step 3: 实现**：
  - RequirementStep:83 与 ManualAgentStep:113 的 `onClick={() => ctx.go('workspace')}` → `() => ctx.go('provider')`（各带注释：workspace 已建成不可重选，绕开直通弹回）
  - ProviderStep「重新选择」按钮包 `{(mode === 'preset' || mode === 'custom') && (…)}`（替换原无条件渲染；existing 已有「返回新建」注释保留）

- [ ] **Step 4: 三组件测试通过**；**Step 5: Commit** — `git commit -m "fix(onboarding): 上一步直跳 provider 防直通弹回；重新选择渲染条件收窄"`

---

### Task 9: T5 — RequirementStep 等待体验（阶段文案 + 等待期转手动）

**Files:**
- Modify: `renderer/src/components/onboarding/RequirementStep.tsx`
- Test: `renderer/src/components/onboarding/RequirementStep.test.tsx`（扩展）

**Interfaces:** 无新接口。

- [ ] **Step 1: 写失败测试**

```tsx
it('busy 期文案 8s 阶段轮换', async () => {
  vi.useFakeTimers();
  // generatePlan mock 为挂起 promise → 点击生成 → getByText('正在分析你的需求…')
  // advance 8000 → getByText('正在挑选合适的 agent…')
  vi.useRealTimers();
});
it('busy 期「转手动配置」可点，点击后立即 toManual，迟到成功结果被丢弃', async () => {
  let resolvePlan!: (v: GenerateOnboardingPlanResult) => void;
  mocked.ipc.onboarding.generatePlan.mockReturnValue(new Promise((res) => { resolvePlan = res; }));
  // 点击生成 → 点击「转手动配置」→ ctx.toManual 已调、未 go('preview')
  // 再 resolvePlan(合法结果) → 仍不在 preview（abandoned 丢弃）
});
```

- [ ] **Step 2: 确认失败**；**Step 3: 实现**：

```tsx
const [phase, setPhase] = useState(0);
const abandonedRef = useRef(false);
useEffect(() => {
  if (!busy) { setPhase(0); return; }
  const t = setInterval(() => setPhase((p) => Math.min(p + 1, 1)), 8_000);
  return () => clearInterval(t);
}, [busy]);

const generate = async (): Promise<void> => {
  if (!text.trim() || busy) return;
  setBusy(true); setError(null); abandonedRef.current = false;
  try {
    const r = await ipc.onboarding.generatePlan({ /* 现参数 */ });
    if (abandonedRef.current) return; // 已转手动——迟到结果静默丢弃（spec T5）
    ctx.setPlan(r.plan); ctx.setPlanWarnings(r.warnings); ctx.go('preview');
  } catch (e) {
    if (abandonedRef.current) return;
    setError(e instanceof Error ? e.message : String(e));
  } finally {
    if (!abandonedRef.current) setBusy(false);
  }
};

const toManualNow = (): void => {
  abandonedRef.current = true; setBusy(false);
  ctx.toManual();
};
```

busy 区块文案：`{phase === 0 ? '正在分析你的需求…' : '正在挑选合适的 agent…'}（通常需要 10–30 秒）`；错误卡与 busy 区块的「转手动配置」按钮均改调 `toManualNow`（busy 区块新增一枚，错误卡既有按钮同步换）。

- [ ] **Step 4: 测试通过**；**Step 5: Commit** — `git commit -m "feat(onboarding): 方案生成等待阶段文案与等待期转手动"`（useRef 加 import）

---

### Task 10: T5 — ProviderStep 细节 + 组队预告 ×2

**Files:**
- Modify: `renderer/src/components/onboarding/ProviderStep.tsx`（:93-95 逐字段校验、:251-257 custom API Key placeholder）
- Modify: `renderer/src/components/onboarding/PlanPreviewStep.tsx`（底部提示行）
- Modify: `renderer/src/components/onboarding/DoneStep.tsx`（团队行小字）
- Test: ProviderStep.test / PlanPreviewStep.test / DoneStep.test 扩展

- [ ] **Step 1: 写失败测试**

```tsx
// ProviderStep：仅缺 key → getByText('请填写 API Key')（不再四项全列）
// PlanPreviewStep：getByText(/自动组建团队/)；// DoneStep：getByText(/@ 成员/)
```

- [ ] **Step 2: 确认失败**；**Step 3: 实现**：

```tsx
// ProviderStep submitNew 头部替换：
const missing = [
  !name.trim() && '名称', !baseUrl.trim() && 'Base URL', !apiKey.trim() && 'API Key', !modelId.trim() && '模型名',
].filter((x): x is string => x !== false);
if (missing.length > 0) { setError(`请填写${missing.join('、')}`); return; }
// custom API Key Input 加 placeholder="sk-..."

// PlanPreviewStep 底部默认 agent 提示行后追加：
<p className="text-[11px] text-disabled mt-1.5">启用 ≥2 个 agent 时将自动组建团队，默认会话智能体担任队长</p>

// DoneStep 团队行 span 下：
<div className="text-[10.5px] text-disabled">多 agent 协作时可在会话中 @ 成员派发任务</div>
```

- [ ] **Step 4: 测试通过**；**Step 5: Commit** — `git commit -m "feat(onboarding): 逐字段校验与团队组建预告文案"`（P2 级 UI 小改，事后走查截图验收）

---

### Task 11: T6 — TitleBar 向导态产品标识

**Files:**
- Modify: `renderer/src/components/layout/TitleBar.tsx:44-46`
- Test: `renderer/src/components/layout/TitleBar.test.tsx`（扩展或新建贴源）

- [ ] **Step 1: 写失败测试**

```tsx
vi.mock('../../lib/platform', () => ({ isMac: () => true, dragStyle: {}, noDragStyle: {} }));
it('mac + wizardMode → 78px 占位后渲染 Momo Studio 字标（消解空条带，spec T6）', () => {
  render(<TitleBar wizardMode />);
  expect(screen.getByText('Momo Studio')).toBeInTheDocument();
});
it('mac 非 wizardMode → 无字标（不与 tab 挤占）', () => {
  render(<TitleBar />);
  expect(screen.queryByText('Momo Studio')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 确认失败**；**Step 3: 实现**（:45 mac 占位后）：

```tsx
{mac && wizardMode && (
  <span className="flex items-center gap-1.5 pr-2 text-xs text-secondary">
    <span className="flex items-center justify-center rounded-md bg-accent-500 text-inverse"
      style={{ width: 18, height: 18 }}>
      <Sparkles size={11} strokeWidth={2} aria-hidden />
    </span>
    Momo Studio
  </span>
)}
```

（与 win 既有标识同款样式，复用 Sparkles；win 分支不动。WorkspaceGate 经 `wizardMode` 自动获得。）

- [ ] **Step 4: 测试通过**；**Step 5: Commit** — `git commit -m "feat(titlebar): 向导态 mac 渲染产品标识"`

---

### Task 12: 收尾 — 全量验证 + 隔离走查 + 账本

- [ ] **Step 1: 双 workspace typecheck + 全量单测** — Run: `npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`（vitest 非正常退出按 AGENTS.md 清孤儿 worker；DB 重度目录加 `--pool=forks` 单独跑）
- [ ] **Step 2: momo-acceptance 隔离走查**（复用 `.omo/qa-reports/2026-11-13-onboarding-walkthrough/` 的 mock LLM 与 driver 方法，全新 profile）：双路线回归 16 截图对照 + 新增验证点——custom 拉取三态、preset 获取最新、跳过后落 WorkspaceGate、完成页直通快速会话、等待期转手动；产出报告 `.omo/qa-reports/<日期>-onboarding-overhaul-verify/`
- [ ] **Step 3: CHANGELOG.md 研发账本条目**（v2.x 研发期，不动版本号）— `git commit -m "docs: 首启引导体验优化研发账本"`
- [ ] **Step 4: 缺陷问询**：走查发现缺陷 → 报告 + 问用户是否沉淀 e2e 回归 spec（运行前提一并告知，见 momo-acceptance 技能第六步）
