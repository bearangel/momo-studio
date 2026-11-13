// renderer/src/components/onboarding/ProviderStep.test.tsx
//
// 供应商配置步测试（spec 2026-10-10 §8 + 预览确认稿）：
// 已有供应商快捷路径 / 预设新建验证失败行内错误 / 预设新建成功推进 / 自定义形态。
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockCreate = vi.fn();
const mockUpdateGlobal = vi.fn();
const mockTestConnection = vi.fn();
const mockList = vi.fn();
const mockListPresets = vi.fn();
const mockListModels = vi.fn();
const mockProbeModels = vi.fn();
const mockFetchModels = vi.fn();
const mockAddModel = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    provider: {
      list: (...a: unknown[]) => mockList(...a),
      listPresets: (...a: unknown[]) => mockListPresets(...a),
      listModels: (...a: unknown[]) => mockListModels(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      testConnection: (...a: unknown[]) => mockTestConnection(...a),
      probeModels: (...a: unknown[]) => mockProbeModels(...a),
      fetchModels: (...a: unknown[]) => mockFetchModels(...a),
      addModel: (...a: unknown[]) => mockAddModel(...a),
    },
    settings: {
      updateGlobal: (...a: unknown[]) => mockUpdateGlobal(...a),
    },
  },
}));

import { ProviderStep } from './ProviderStep';

const EXISTING = {
  id: 'p1',
  name: '智谱 GLM',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  defaultModel: null,
  isDefault: false,
  createdAt: '',
  platform: 'openai' as const,
  presetKey: 'zhipu',
};

const PRESETS = [
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai' as const,
    thinkingWire: 'effort' as const,
    models: [
      { id: 'glm-5.3', contextWindow: 128000, outputTokens: 8192, reasoning: { kind: 'none' as const } },
    ],
  },
];

const MODELS_P1 = [
  {
    providerId: 'p1',
    modelId: 'glm-5.3',
    contextWindow: null,
    thinkingJson: null,
    reasoning: { kind: 'none' as const },
    effectiveWindow: null,
    vision: false,
  },
];

function mkCtx(): WizardCtx {
  return {
    route: 'ai',
    providerId: '',
    modelId: '',
    workspaceId: '',
    plan: null,
    planWarnings: [],
    applyResult: null,
    setProvider: vi.fn(),
    setWorkspace: vi.fn(),
    setPlan: vi.fn(),
    setPlanWarnings: vi.fn(),
    setApplyResult: vi.fn(),
    go: vi.fn(),
    toManual: vi.fn(),
    finish: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockListPresets.mockResolvedValue(PRESETS);
  mockListModels.mockResolvedValue(MODELS_P1);
  mockCreate.mockResolvedValue(EXISTING);
  mockUpdateGlobal.mockResolvedValue(undefined);
});

describe('ProviderStep', () => {
  it('已有供应商快捷路径：选中 + 模型自动取列表首项 + 继续推进', async () => {
    mockList.mockResolvedValue([EXISTING]);
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('使用已有供应商'));
    fireEvent.click(await screen.findByText('智谱 GLM'));
    expect(await screen.findByText(/glm-5\.3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(ctx.setProvider).toHaveBeenCalledWith('p1', 'glm-5.3'));
    expect(ctx.go).toHaveBeenCalledWith('workspace');
  });

  it('预设新建 + 验证失败 → 行内错误，不 create 不推进', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    const keyInput = await screen.findByLabelText(/API Key/);
    fireEvent.change(keyInput, { target: { value: 'sk-bad' } });
    mockTestConnection.mockResolvedValue({ ok: false, error: 'HTTP 401' });
    fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(ctx.go).not.toHaveBeenCalled();
  });

  it('验收补修（2026-11-02）：chips 形态「上一步」→ 回欢迎页重选路线', () => {
    mockList.mockResolvedValue([]);
    mockListPresets.mockResolvedValue(PRESETS);
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect(ctx.go).toHaveBeenCalledWith('welcome');
  });

  it('验收补修：preset 表单「重新选择」→ 回 chips 列表（选错预设不再卡死）', async () => {
    mockList.mockResolvedValue([]);
    mockListPresets.mockResolvedValue(PRESETS);
    mockListModels.mockResolvedValue(MODELS_P1);
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    await screen.findByLabelText(/API Key/);
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    // 回到 chips 列表——预设卡重新可见
    expect(await screen.findByText('智谱 GLM')).toBeInTheDocument();
  });

  it('D6：验证成功 → create 携带 verifiedAtCreation:true（此前漏传致设置页永显「未验证」）', async () => {
    mockList.mockResolvedValue([]);
    mockListPresets.mockResolvedValue(PRESETS);
    mockListModels.mockResolvedValue(MODELS_P1);
    mockTestConnection.mockResolvedValue({ ok: true });
    mockCreate.mockResolvedValue({ ...EXISTING, id: 'p-new' });
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    // 预设卡进入表单（填 key 后验证——与既有成功路径用例同款前置）
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(await screen.findByLabelText(/API Key/), { target: { value: 'sk-good' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并继续' }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ verifiedAtCreation: true });
  });

  it('验收补修（2026-11-02）：自定义供应商手输模型 → create 带 defaultModel（无 presetKey）+ 模型行不再空', async () => {
    mockTestConnection.mockResolvedValue({ ok: true });
    mockCreate.mockResolvedValue({ ...EXISTING, id: 'p-custom' });
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    fireEvent.change(await screen.findByLabelText(/名称/), { target: { value: '公司网关' } });
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: 'https://gw.example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-gw' } });
    fireEvent.change(screen.getByLabelText(/模型名/), { target: { value: 'internal-pro-1' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并继续' }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({
      name: '公司网关', defaultModel: 'internal-pro-1', platform: 'openai',
    });
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('presetKey');
    await waitFor(() =>
      expect(mockUpdateGlobal).toHaveBeenCalledWith({
        defaultChatModel: { providerId: 'p-custom', modelId: 'internal-pro-1' },
      }),
    );
    expect(ctx.go).toHaveBeenCalledWith('workspace');
  });

  it('预设新建 + 验证成功 → create → setProvider → 推进 workspace', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(await screen.findByLabelText(/API Key/), { target: { value: 'sk-good' } });
    mockTestConnection.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
    await waitFor(() =>
      expect(mockTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: PRESETS[0]!.baseUrl, apiKey: 'sk-good', model: 'glm-5.3' }),
      ),
    );
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '智谱 GLM', presetKey: 'zhipu', isDefault: true,
          defaultModel: 'glm-5.3',
        }),
      ),
    );
    // 验收补修（2026-11-02）：首屏选定模型落全局默认会话模型
    await waitFor(() =>
      expect(mockUpdateGlobal).toHaveBeenCalledWith({
        defaultChatModel: { providerId: 'p1', modelId: 'glm-5.3' },
      }),
    );
    expect(ctx.setProvider).toHaveBeenCalledWith('p1', 'glm-5.3');
    expect(ctx.go).toHaveBeenCalledWith('workspace');
  });

  it('自定义供应商形态：名称/平台/Base URL/模型名手填', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    expect(await screen.findByLabelText(/名称/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toBeInTheDocument();
    expect(screen.getByLabelText(/模型名/)).toBeInTheDocument();
  });
});

describe('ProviderStep — 跳过出口（D1a，预览 S1）', () => {
  it('onSkip 注入时渲染跳过链接（chips 模式同样可见），点击调 onSkip', async () => {
    const ctx = mkCtx();
    const onSkip = vi.fn();
    render(<ProviderStep ctx={ctx} onSkip={onSkip} />);
    fireEvent.click(await screen.findByRole('button', { name: '跳过，稍后在设置中配置' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(ctx.go).not.toHaveBeenCalled();
    expect(ctx.setProvider).not.toHaveBeenCalled();
  });

  it('未注入 onSkip 时不渲染跳过链接（组件可独立使用）', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    await screen.findByText('+ 自定义供应商');
    expect(screen.queryByRole('button', { name: '跳过，稍后在设置中配置' })).not.toBeInTheDocument();
  });
});

describe('「重新选择」渲染条件（T4，spec 2026-11-13 §6——chips 空态语义收窄）', () => {
  it('chips 态不渲染「重新选择」（仅「上一步」）；preset/custom 子表单才出现', async () => {
    render(<ProviderStep ctx={mkCtx()} onSkip={() => undefined} />);
    await screen.findByText('+ 自定义供应商');
    expect(screen.queryByText('重新选择')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('+ 自定义供应商'));
    expect(screen.getByText('重新选择')).toBeInTheDocument();
    fireEvent.click(screen.getByText('重新选择'));
    expect(screen.queryByText('重新选择')).not.toBeInTheDocument();
  });
});

describe('custom 形态模型拉取（spec 2026-11-13 T1）', () => {
  /** 进入 custom 形态并填 BaseURL + Key */
  async function enterCustomFilled(): Promise<void> {
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    fireEvent.change(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), {
      target: { value: 'http://127.0.0.1:9911/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-demo' } });
  }

  it('baseUrl/key 未填全时「获取模型列表」禁用', async () => {
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    expect(screen.getByRole('button', { name: /获取模型列表/ })).toBeDisabled();
    // 填齐后解禁
    fireEvent.change(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), {
      target: { value: 'http://127.0.0.1:9911/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-demo' } });
    expect(screen.getByRole('button', { name: /获取模型列表/ })).toBeEnabled();
  });

  it('拉取成功 → Input 变 Select（含「手动输入…」）；选手动输入回退 Input', async () => {
    mockProbeModels.mockResolvedValue({ models: ['glm-5.3', 'glm-5.3-air'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    // fetched 态：下拉出现且首项自动选中（displayValue 定位，跳过 fetching 帧的 Input）
    const select = await screen.findByDisplayValue('glm-5.3');
    expect(select.tagName).toBe('SELECT');
    expect(screen.queryByPlaceholderText('手输模型名，验证连通后即可继续')).not.toBeInTheDocument();
    // 选「手动输入…」→ 回退手输 Input
    fireEvent.change(select, { target: { value: '__manual__' } });
    expect(
      screen.getByPlaceholderText('手输模型名，验证连通后即可继续'),
    ).toBeInTheDocument();
  });

  it('拉取失败 → 保留手输 Input + 行内错误；truncated 时提示可见', async () => {
    mockProbeModels.mockRejectedValue(new Error('API Key 无效或无权限（HTTP 401）'));
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    expect(
      screen.getByPlaceholderText('手输模型名，验证连通后即可继续'),
    ).toBeInTheDocument();
    expect(await screen.findByText(/获取失败：API Key 无效或无权限/)).toBeInTheDocument();
    // 第二轮：成功但 truncated
    mockProbeModels.mockResolvedValue({ models: ['m-1', 'm-2'], truncated: true });
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    expect(await screen.findByText(/仅显示前 200 个/)).toBeInTheDocument();
  });

  it('拉取成功时保留已在列表中的原手输值', async () => {
    mockProbeModels.mockResolvedValue({ models: ['glm-5.3', 'my-model'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.change(screen.getByPlaceholderText('手输模型名，验证连通后即可继续'), {
      target: { value: 'my-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    // fetching 帧的 Input 同值——等待其变为 SELECT 才算 fetched 态保留原值
    await waitFor(() => {
      expect(screen.getByDisplayValue('my-model').tagName).toBe('SELECT');
    });
  });
});

describe('preset/existing 模型列表动态获取（spec 2026-11-13 T1）', () => {
  it('preset 拉取成功 → 远端在前 + 预置去重合并', async () => {
    mockProbeModels.mockResolvedValue({ models: ['glm-5.3-air'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /获取最新模型/ }));
    const options = await waitFor(() => {
      const opts = screen.getAllByRole('option');
      expect(opts.length).toBeGreaterThanOrEqual(2);
      return opts;
    });
    expect(options.map((o) => o.getAttribute('value'))).toEqual(
      expect.arrayContaining(['glm-5.3-air', 'glm-5.3']),
    );
    // 远端项在前
    expect(options[0]!.getAttribute('value')).toBe('glm-5.3-air');
  });

  it('preset 拉取失败 → 预置项保留 + 行内错误', async () => {
    mockProbeModels.mockRejectedValue(new Error('HTTP 500'));
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /获取最新模型/ }));
    expect(await screen.findByText(/获取最新失败：HTTP 500/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /glm-5\.3/ })).toBeInTheDocument();
  });

  it('existing 点刷新 → fetchModels 拉取 ids → addModel 幂等入库 → 下拉见新模型（mock 保真：模拟表）', async () => {
    // Oracle 终审修正：主进程 fetchRemoteModels 纯拉取零落库——生产者模式是
    // 「调用方逐个 addModel 入库」（ProviderModelList/Picker 同款）。mock 用可变
    // 表建模：listModels 读表、addModel 写表、fetchModels 只返回远端 ids。
    const table = new Map(MODELS_P1.map((m) => [m.modelId, { ...m }]));
    mockList.mockResolvedValue([EXISTING]);
    mockListModels.mockImplementation(async () => [...table.values()]);
    mockAddModel.mockImplementation(async (_id: string, modelId: string) => {
      table.set(modelId, { ...MODELS_P1[0]!, modelId });
    });
    mockFetchModels.mockResolvedValue(['glm-5.3', 'glm-new']);
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('使用已有供应商'));
    fireEvent.click(await screen.findByText('智谱 GLM'));
    await screen.findByRole('option', { name: /glm-5\.3/ });
    expect(screen.queryByRole('option', { name: 'glm-new' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /刷新模型/ }));
    expect(await screen.findByRole('option', { name: 'glm-new' })).toBeInTheDocument();
    expect(mockFetchModels).toHaveBeenCalledWith('p1');
    expect(mockAddModel).toHaveBeenCalledWith('p1', 'glm-new');
  });
});

describe('T5 细节（spec 2026-11-13 §7.3）', () => {
  it('仅缺 API Key 提交 → 错误只点名缺失字段（不再四项全列）', async () => {
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    fireEvent.change(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), {
      target: { value: 'http://x/v1' },
    });
    fireEvent.change(screen.getByPlaceholderText('手输模型名，验证连通后即可继续'), {
      target: { value: 'm1' },
    });
    // 名称用首个无 placeholder 文本框（css input:not([placeholder]):not([type=password]) 同义）
    const nameInput = document.querySelector(
      'input:not([placeholder]):not([type=password])',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'N' } });
    fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
    expect(await screen.findByText('请填写API Key')).toBeInTheDocument();
  });

  it('custom 形态 API Key 有 sk-... placeholder（与 preset 形态一致）', async () => {
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
  });
});

describe('T-fix#2 preset truncated 提示（Oracle Minor #2）', () => {
  it('preset 拉取 truncated → preset 段显示仅显示前 200 个提示', async () => {
    mockProbeModels.mockResolvedValue({ models: ['m-1'], truncated: true });
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /获取最新模型/ }));
    expect(await screen.findByText(/仅显示前 200 个/)).toBeInTheDocument();
  });
});

// ── 异步护栏（2026-11-13 代码审查跟进）：请求令牌守卫——慢响应不得覆盖用户
//    更新的选择/手输；输入变更重置陈旧列表；在途按钮 disabled ──────────────────
describe('异步护栏（请求令牌守卫）', () => {
  /** 受控延迟 promise：模拟慢回包（测试手动决定落地时机） */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** 进入 custom 形态并填 BaseURL + Key（与 T1 describe 同款前置） */
  async function enterCustomFilled(): Promise<void> {
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    fireEvent.change(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), {
      target: { value: 'http://127.0.0.1:9911/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-demo' } });
  }

  it('custom 拉取在途时改 baseUrl → 慢回包丢弃：仍手输 Input、无陈旧列表、无报错', async () => {
    const slow = deferred<{ models: string[]; truncated: boolean }>();
    mockProbeModels.mockReturnValueOnce(slow.promise);
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    // 在途时改 baseUrl → modelFetch 重置回 idle（陈旧列表不得残留展示）
    fireEvent.change(screen.getByPlaceholderText('https://llm-gateway.example.com/v1'), {
      target: { value: 'http://other.example.com/v1' },
    });
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument();
    await act(async () => {
      slow.resolve({ models: ['stale-model'], truncated: false });
    });
    // 慢回包落地被令牌守卫整包丢弃
    expect(screen.queryByDisplayValue('stale-model')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('__manual__')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument();
    expect(screen.queryByText(/获取失败/)).not.toBeInTheDocument();
  });

  it('custom 已拉取后改 API Key → 模型下拉重置回手输 Input（陈旧列表不残留）', async () => {
    mockProbeModels.mockResolvedValue({ models: ['m-1', 'm-2'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    await waitFor(() => expect(screen.getByDisplayValue('m-1').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-changed' } });
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'm-1' })).not.toBeInTheDocument();
  });

  it('custom 已拉取后切换平台 → 同样重置（连接参数三个维度全覆盖）', async () => {
    mockProbeModels.mockResolvedValue({ models: ['m-1'], truncated: false });
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    await waitFor(() => expect(screen.getByDisplayValue('m-1').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'anthropic' } });
    expect(screen.getByPlaceholderText('手输模型名，验证连通后即可继续')).toBeInTheDocument();
  });

  it('custom 拉取在途 → 获取按钮 disabled（防重复发起）；回包后恢复', async () => {
    const slow = deferred<{ models: string[]; truncated: boolean }>();
    mockProbeModels.mockReturnValueOnce(slow.promise);
    render(<ProviderStep ctx={mkCtx()} />);
    await enterCustomFilled();
    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    expect(screen.getByRole('button', { name: /获取模型列表/ })).toBeDisabled();
    await act(async () => {
      slow.resolve({ models: ['m-1'], truncated: false });
    });
    // fetched 态换为下拉——手输分支（含获取按钮）退场，回包已消化
    await waitFor(() => expect(screen.getByDisplayValue('m-1').tagName).toBe('SELECT'));
  });

  it('preset 获取最新在途 → 按钮 disabled；期间换预设 → 慢回包丢弃、新预设预置列表不受污染', async () => {
    const PRESETS2 = [
      PRESETS[0]!,
      {
        key: 'other',
        name: '另一家',
        baseUrl: 'https://other.example.com/v1',
        platform: 'openai' as const,
        thinkingWire: 'effort' as const,
        models: [
          { id: 'o-1', contextWindow: 128000, outputTokens: 8192, reasoning: { kind: 'none' as const } },
        ],
      },
    ];
    mockListPresets.mockResolvedValue(PRESETS2);
    const slow = deferred<{ models: string[]; truncated: boolean }>();
    mockProbeModels.mockReturnValueOnce(slow.promise);
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /获取最新模型/ }));
    expect(screen.getByRole('button', { name: /获取最新模型/ })).toBeDisabled();
    // 慢回包在途时用户换预设
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    fireEvent.click(await screen.findByText('另一家'));
    await act(async () => {
      slow.resolve({ models: ['stale-remote'], truncated: false });
    });
    // 新预设的下拉只见其预置项（慢回包的远端列表被丢弃），选中值保持预置首项
    expect(screen.queryByRole('option', { name: 'stale-remote' })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('o-1')).toBeInTheDocument();
  });

  it('existing 快慢竞态：先点 A（慢）再点 B（快）→ B 的模型生效，A 慢回包丢弃', async () => {
    const EXISTING_B = { ...EXISTING, id: 'p2', name: '备用网关' };
    mockList.mockResolvedValue([EXISTING, EXISTING_B]);
    const slowA = deferred<typeof MODELS_P1>();
    mockListModels.mockImplementation(async (id: string) =>
      id === 'p1'
        ? slowA.promise
        : [{ ...MODELS_P1[0]!, providerId: 'p2', modelId: 'm-p2' }],
    );
    render(<ProviderStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText('使用已有供应商'));
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.click(await screen.findByText('备用网关'));
    expect(await screen.findByRole('option', { name: 'm-p2' })).toBeInTheDocument();
    await act(async () => {
      slowA.resolve([{ ...MODELS_P1[0]!, modelId: 'm-p1' }]);
    });
    expect(screen.queryByRole('option', { name: 'm-p1' })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('m-p2')).toBeInTheDocument();
  });
});
