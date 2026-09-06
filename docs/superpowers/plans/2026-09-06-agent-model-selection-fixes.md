# Agent 模型选择与成员管理修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 3 个验收缺陷——创建/编辑 Agent 时模型按供应商联动下拉选择、agent 可更换供应商与模型（双入口）、移出的 agent 可重新添加。

**Architecture:** 纯 renderer 侧修复，主进程零改动（`provider.listModels/fetchModels/addModel`、`agent.updateDefinition`、`agent.addMember` IPC 全部已存在）。新增共享组件 `ProviderModelPicker`（供应商→模型二级联动，含空态拉取），三个表单（CreateAgentDialog / DefinitionEditor / MemberEditDialog）统一接入；资源库为 custom agent 恢复 `DefinitionEditor` 编辑挂载点；新增 `AddAgentDialog` 提供已有 agent 重新加入入口。

**Tech Stack:** React 18 + zustand + vitest + @testing-library/react；Electron IPC 经 `window.api` 桩 mock。

**Spec:** `docs/superpowers/specs/2026-09-06-agent-model-selection-fixes-design.md`（已获用户批准）

## Global Constraints

- **Node 20 LTS**：容器默认 Node 26，所有命令前先 `nvm use 20`（否则 better-sqlite3 ABI 报错）
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- **UI v2.1 设计系统**：只用语义 token；图标 lucide-react（16px / stroke 1.75），禁 emoji 图标（`iconEmoji` 用户数据豁免）；原子组件优先（`ui/Select` / `ui/Input` / `ui/Dialog` / `ui/Button` / `ui/EmptyState`）
- **测试位置**：renderer 单测贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录）；`renderer/vitest.config.ts` 只 include `src/**/*.test.{ts,tsx}`
- **momo-test-rules**：mock 收窄到 IPC 边界（`window.api` 桩）；mock 返回结构对齐真实契约（`ProviderModel` / `WorkspaceAgentMember` / `AgentDefinition` 字段齐备，不写占位符）；错误路径与空输入必须有专项用例
- **Conventional Commits**：`feat:` / `fix:` / `test:` / `refactor:`
- 单测运行：`cd renderer && npx pnpm@9.0.0 vitest run <path>`（自 renderer 包目录）
- 中文注释（代码标识符英文）

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/components/agent/ProviderModelPicker.tsx` | 新建 | 供应商→模型二级联动选择（受控组件，数据自理） |
| `renderer/src/components/agent/ProviderModelPicker.test.tsx` | 新建 | 联动/空态拉取/错误路径测试 |
| `renderer/src/components/agent/CreateAgentDialog.tsx` | 修改 | 模型名 Input → ProviderModelPicker（Bug 1） |
| `renderer/src/components/agent/CreateAgentDialog.test.tsx` | 修改 | 交互改下拉 |
| `renderer/src/components/agent/DefinitionEditor.tsx` | 修改 | 模型字段换 ProviderModelPicker |
| `renderer/src/components/agent/DefinitionEditor.test.tsx` | 修改 | 交互改下拉 |
| `renderer/src/components/agent/MemberEditDialog.tsx` | 修改 | key 区移除 + 模型区（Bug 2） |
| `renderer/src/components/agent/MemberEditDialog.test.tsx` | 修改 | key 用例移除 + 模型用例新增 |
| `renderer/src/components/resource-library/ResourceDetail.tsx` | 修改 | custom agent「编辑」按钮 |
| `renderer/src/components/resource-library/ResourceDetail.test.tsx` | 修改 | 编辑按钮用例 |
| `renderer/src/components/resource-library/ResourceLibraryView.tsx` | 修改 | 挂载 DefinitionEditor（Bug 2 资源库入口） |
| `renderer/src/components/resource-library/ResourceLibraryView.test.tsx` | 修改 | 编辑入口用例 |
| `renderer/src/components/agent/AddAgentDialog.tsx` | 新建 | 已有 agent 加入当前 ws（Bug 3） |
| `renderer/src/components/agent/AddAgentDialog.test.tsx` | 新建 | 过滤/加入/空态/错误用例 |
| `renderer/src/components/agent/MembersPanel.tsx` | 修改 | 「+ 添加 Agent」入口 |

---

### Task 1: ProviderModelPicker 共享组件

**Files:**
- Create: `renderer/src/components/agent/ProviderModelPicker.tsx`
- Test: `renderer/src/components/agent/ProviderModelPicker.test.tsx`

**Interfaces:**
- Consumes: `useProviderStore`（`providers: ModelProvider[]`, `loadProviders: () => Promise<void>`）；IPC `ipc.provider.listModels(providerId): Promise<ProviderModel[]>`、`ipc.provider.fetchModels(providerId): Promise<string[]>`、`ipc.provider.addModel(providerId, modelId): Promise<void>`；`ui/Select`（`label` prop 即 accessible name）
- Produces: `ProviderModelPicker({ providerId: string; modelId: string; onProviderChange: (id: string) => void; onModelChange: (id: string) => void; disabled?: boolean })`；label 文案固定为「模型供应商*」与「模型名」（后续 Task 2/3/4 依赖此 accessible name）

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/agent/ProviderModelPicker.test.tsx
//
// ProviderModelPicker 行为测试：受控组件 + 数据自理。
//   - 供应商列表来自 useProviderStore（setState 注入，loadProviders 桩）
//   - 模型列表 ipc.provider.listModels（window.api 桩），仅 enabled 可选
//   - 联动重置：换供应商补发 onModelChange('')
//   - 空态：内嵌「拉取模型列表」（fetchModels → addModel 逐个 → listModels 刷新）
//   - 错误路径：listModels / fetchModels 失败行内展示
//
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api）；
// store setState 注入状态 + loadProviders 桩；ProviderModel 字段全量对齐真实契约。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useProviderStore } from '../../stores/provider.store';
import type { ProviderModel } from '../../ipc/types';

const listModels = vi.fn();
const fetchModels = vi.fn();
const addModel = vi.fn();

/** 构造全量字段 ProviderModel（契约对齐，不写占位符） */
function pm(providerId: string, modelId: string, enabled: boolean): ProviderModel {
  return { providerId, modelId, enabled, addedAt: 0 };
}

beforeEach(() => {
  listModels.mockReset();
  fetchModels.mockReset();
  addModel.mockReset();

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: { listModels, fetchModels, addModel },
  };

  useProviderStore.setState({
    providers: [
      { id: 'p1', name: '供应商A', baseUrl: 'https://a', defaultModel: null, isDefault: true, createdAt: '', platform: 'openai' as const },
      { id: 'p2', name: '供应商B', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic' as const },
    ],
    loading: false,
    loadProviders: vi.fn().mockResolvedValue(undefined),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setDefault: vi.fn(),
    clear: vi.fn(),
  });
});

/** 受控桩：回调直接透传 spies（无本地 state，方便断言联动补发） */
function renderPicker(props: Partial<Parameters<typeof ProviderModelPicker>[0]> = {}) {
  const onProviderChange = vi.fn();
  const onModelChange = vi.fn();
  render(
    <ProviderModelPicker
      providerId=""
      modelId=""
      onProviderChange={onProviderChange}
      onModelChange={onModelChange}
      {...props}
    />,
  );
  return { onProviderChange, onModelChange };
}

describe('ProviderModelPicker — 供应商下拉', () => {
  it('渲染供应商列表，默认供应商带「（默认）」标记', () => {
    renderPicker();
    const select = screen.getByLabelText('模型供应商*') as HTMLSelectElement;
    expect(select.options).toHaveLength(3); // 请选择... + p1 + p2
    expect(select.options[1]!.textContent).toBe('供应商A（默认）');
    expect(select.options[2]!.textContent).toBe('供应商B');
  });

  it('未选供应商时模型下拉禁用', () => {
    renderPicker();
    expect(screen.getByLabelText('模型名')).toBeDisabled();
  });
});

describe('ProviderModelPicker — 模型联动', () => {
  it('providerId 给定 → listModels 拉取 → 仅 enabled 模型出现在下拉', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true), pm('p1', 'm-off', false)]);
    renderPicker({ providerId: 'p1' });
    const select = (await screen.findByLabelText('模型名')) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'm-on']);
    });
    expect(listModels).toHaveBeenCalledWith('p1');
  });

  it('换供应商 → onProviderChange(id) + 补发 onModelChange(\'\')（联动重置）', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p1' } });
    expect(screen.getByLabelText('模型供应商*')).toHaveValue('p1');
    expect(screen.getByLabelText('模型名')).not.toBeDisabled();
    const { onProviderChange, onModelChange } = renderPicker();
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    expect(onProviderChange).toHaveBeenCalledWith('p2');
    expect(onModelChange).toHaveBeenCalledWith('');
  });

  it('listModels 失败 → 行内 error 展示', async () => {
    listModels.mockRejectedValue(new Error('网络不可达'));
    renderPicker({ providerId: 'p1' });
    expect(await screen.findByText('网络不可达')).toBeInTheDocument();
  });
});

describe('ProviderModelPicker — 空态拉取', () => {
  it('模型列表为空 → 显示「拉取模型列表」→ fetchModels + addModel 逐个 + 刷新', async () => {
    // 首次 listModels 空；fetch 返回两个 id；拉取后 listModels 返回入库结果
    let listCallCount = 0;
    listModels.mockImplementation(async () => {
      listCallCount += 1;
      return listCallCount <= 1 ? [] : [pm('p1', 'glm-5.3', true), pm('p1', 'glm-4.7', true)];
    });
    fetchModels.mockResolvedValue(['glm-5.3', 'glm-4.7']);
    addModel.mockResolvedValue(undefined);

    renderPicker({ providerId: 'p1' });
    const btn = await screen.findByRole('button', { name: /拉取模型列表/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalledWith('p1');
    });
    expect(addModel).toHaveBeenCalledWith('p1', 'glm-5.3');
    expect(addModel).toHaveBeenCalledWith('p1', 'glm-4.7');
    const select = screen.getByLabelText('模型名') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'glm-5.3', 'glm-4.7']);
    });
  });

  it('有已启用模型时不显示拉取按钮', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true)]);
    renderPicker({ providerId: 'p1' });
    await screen.findByRole('option', { name: 'm-on' });
    expect(screen.queryByRole('button', { name: /拉取模型列表/ })).not.toBeInTheDocument();
  });

  it('fetchModels 失败 → 行内 error（不关闭、不清空表单）', async () => {
    listModels.mockResolvedValue([]);
    fetchModels.mockRejectedValue(new Error('HTTP 401'));
    renderPicker({ providerId: 'p1' });
    fireEvent.click(await screen.findByRole('button', { name: /拉取模型列表/ }));
    expect(await screen.findByText('HTTP 401')).toBeInTheDocument();
    expect(addModel).not.toHaveBeenCalled();
  });
});

describe('ProviderModelPicker — 缓存', () => {
  it('同 providerId 二次加载走缓存（listModels 只调一次）', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true)]);
    // 受控有状态 Harness：切换 p1 → p2 → p1
    function Harness() {
      const [providerId, setProviderId] = useState('p1');
      return (
        <ProviderModelPicker
          providerId={providerId}
          modelId=""
          onProviderChange={setProviderId}
          onModelChange={() => {}}
        />
      );
    }
    render(<Harness />);
    await screen.findByRole('option', { name: 'm-on' });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    await waitFor(() => {
      expect(listModels).toHaveBeenCalledWith('p2');
    });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p1' } });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'm-on' })).toBeInTheDocument();
    });
    // p1 只在首次挂载调过一次
    expect(listModels.mock.calls.filter((c) => c[0] === 'p1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/ProviderModelPicker.test.tsx
```

预期：FAIL——`Cannot find module './ProviderModelPicker'`。

- [ ] **Step 3: 实现组件**

```tsx
// renderer/src/components/agent/ProviderModelPicker.tsx
//
// 供应商→模型二级联动选择（受控组件，数据自理）。
// 三个 agent 表单（CreateAgentDialog / DefinitionEditor / MemberEditDialog 模型区）
// 的唯一模型数据入口——彻底取代 deprecated 的 provider.defaultModel 快填。
//
// 行为：
//   - 供应商下拉：数据来自 useProviderStore（挂载时 loadProviders），保留
//     「请选择...」空选项与「（默认）」标记
//   - 模型下拉：ipc.provider.listModels(providerId) 过滤 enabled，按 addedAt 升序
//     （后端已排好序，前端只过滤）；切换供应商时补发 onModelChange('') 联动重置
//   - 空态内嵌拉取：选中供应商但无已启用模型 → 「拉取模型列表」按钮
//     （fetchModels → addModel 逐个幂等入库 → listModels 刷新），模式与
//     settings/ProviderModelList.handleFetchAll 一致
//   - 模型列表按 providerId 缓存在 ref（弹窗内来回切供应商不重复拉取）
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useProviderStore } from '../../stores/provider.store';
import { Select } from '../ui/Select';
import type { ProviderModel } from '../../ipc/types';

interface Props {
  providerId: string;
  modelId: string;
  onProviderChange: (id: string) => void;
  onModelChange: (id: string) => void;
  disabled?: boolean;
}

export function ProviderModelPicker({
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
  disabled,
}: Props) {
  const { providers, loadProviders } = useProviderStore();
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // providerId → 模型列表缓存（避免弹窗内重复拉取）
  const cacheRef = useRef(new Map<string, ProviderModel[]>());

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      return;
    }
    const cached = cacheRef.current.get(providerId);
    if (cached) {
      setModels(cached);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    setError(null);
    ipc.provider
      .listModels(providerId)
      .then((list) => {
        cacheRef.current.set(providerId, list);
        if (!cancelled) setModels(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const enabledModels = models.filter((m) => m.enabled);

  const handleProviderChange = (id: string): void => {
    onProviderChange(id);
    // 联动重置：换供应商即清空模型选择（spec §3.1——父组件只需正常响应两个回调）
    onModelChange('');
  };

  const handleFetch = async (): Promise<void> => {
    if (!providerId) return;
    setFetching(true);
    setError(null);
    try {
      const ids = await ipc.provider.fetchModels(providerId);
      for (const id of ids) {
        await ipc.provider.addModel(providerId, id);
      }
      const list = await ipc.provider.listModels(providerId);
      cacheRef.current.set(providerId, list);
      setModels(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const emptyOptionText = !providerId
    ? '请先选择供应商'
    : enabledModels.length > 0
      ? '请选择模型...'
      : loadingModels
        ? '加载中…'
        : '该供应商暂无模型';

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="模型供应商*"
        value={providerId}
        onChange={(e) => handleProviderChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">请选择...</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? '（默认）' : ''}
          </option>
        ))}
      </Select>
      <div className="flex flex-col gap-1">
        <Select
          label="模型名"
          value={modelId}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={disabled || !providerId}
        >
          <option value="">{emptyOptionText}</option>
          {enabledModels.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.modelId}
            </option>
          ))}
        </Select>
        {providerId && enabledModels.length === 0 && !loadingModels && (
          <button
            type="button"
            onClick={() => void handleFetch()}
            disabled={fetching}
            className="inline-flex w-fit items-center gap-1 rounded border border-subtle px-2 py-1 text-xs text-secondary hover:bg-surface-3 disabled:opacity-50"
          >
            {fetching ? (
              '拉取中…'
            ) : (
              <>
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden /> 拉取模型列表
              </>
            )}
          </button>
        )}
        {error && (
          <p className="text-xs text-status-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/ProviderModelPicker.test.tsx
```

预期：PASS（全部用例）。

- [ ] **Step 5: 类型检查**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
```

预期：双 workspace clean。

- [ ] **Step 6: 提交**

```bash
git add renderer/src/components/agent/ProviderModelPicker.tsx renderer/src/components/agent/ProviderModelPicker.test.tsx
git commit -m "feat: ProviderModelPicker 供应商→模型二级联动选择组件"
```

---

### Task 2: CreateAgentDialog 接入（Bug 1）

**Files:**
- Modify: `renderer/src/components/agent/CreateAgentDialog.tsx`
- Test: `renderer/src/components/agent/CreateAgentDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ProviderModelPicker`（props 同上，label「模型供应商*」「模型名」）；IPC `ipc.provider.listModels`（经 picker，测试需在 window.api 桩中提供）
- Produces: 表单行为变更——提交校验文案「请选择模型供应商与模型」；`createCustom` 入参结构不变（`modelProviderId` / `modelName`）

- [ ] **Step 1: 更新测试（先红）**

对 `renderer/src/components/agent/CreateAgentDialog.test.tsx` 做以下修改：

1）mockApi 增加 provider 命名空间（picker 经 IPC 拉模型列表）：

```tsx
const createCustom = vi.fn();
const providerListModels = vi.fn();
const addMember = vi.fn();
const loadDefinitions = vi.fn();
const setDefaultAgent = vi.fn();

// beforeEach 中：
providerListModels.mockReset().mockResolvedValue([
  { providerId: 'prov-1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
]);

// window.api 桩改为：
(globalThis as unknown as { window: { api: unknown } }).window.api = {
  agent: { createCustom },
  provider: { listModels: providerListModels },
};
```

2）`fillRequired` 改为 async（选供应商后等模型 options 异步加载）：

```tsx
/** 填写必填字段：名称 + 供应商 + 模型（模型 options 异步加载，需 await） */
async function fillRequired(name = '新助手'): Promise<void> {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
  await screen.findByRole('option', { name: 'gpt-4o' });
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });
}
```

3）所有调用 `fillRequired()` 的测试改为 `await fillRequired()`（共 7 处：默认档/全部/自选/创建成功/设默认/失败分支/library 分支；对应 it 函数签名加 `async`）。

4）校验用例更新：

```tsx
it('未选模型服务提交 → 显示错误且不调 createCustom', async () => {
  render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新助手' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(await screen.findByText('请选择模型供应商与模型')).toBeInTheDocument();
  expect(createCustom).not.toHaveBeenCalled();
});
```

（原断言文案「请选择模型服务并填写模型名」同步替换。）

5）删除用例「选择供应商后自动填充其默认模型名」（defaultModel 快填退役），替换为：

```tsx
it('选择供应商后模型下拉列出其已启用模型；模型名不再是手填输入框', async () => {
  render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
  await screen.findByRole('option', { name: 'gpt-4o' });
  // 模型名是 select（下拉）而非 input（手填）
  expect(screen.getByLabelText('模型名').tagName).toBe('SELECT');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/CreateAgentDialog.test.tsx
```

预期：FAIL——新用例断言 `tagName === 'SELECT'` 失败（当前是 Input）；旧文案断言失败。

- [ ] **Step 3: 实现修改**

`renderer/src/components/agent/CreateAgentDialog.tsx`：

1）import 区：删除 `import { useProviderStore } from '../../stores/provider.store';`，删除 `import { Input } from '../ui/Input';`（若名称/图标仍用 Input 则保留——注意：名称与图标字段仍用 Input，**保留 Input import**），新增：

```tsx
import { ProviderModelPicker } from './ProviderModelPicker';
```

2）组件内删除：

```tsx
const { providers, loadProviders } = useProviderStore();
// 以及
useEffect(() => {
  void loadProviders();
}, [loadProviders]);

// 以及整个 handleProviderChange（defaultModel 快填退役）
```

3）`useEffect` 若因此不再使用，从 import 中移除 `useEffect`。

4）校验分支更新：

```tsx
if (!providerId || !modelName.trim()) {
  setError('请选择模型供应商与模型');
  return;
}
```

5）表单区：删除「模型供应商*」`<Select>` 与「模型名」`<Input>` 两个控件块，替换为：

```tsx
<ProviderModelPicker
  providerId={providerId}
  modelId={modelName}
  onProviderChange={setProviderId}
  onModelChange={setModelName}
/>
```

6）文件头注释同步：补一行「v2.2 fix：模型名由手填 Input 改为 ProviderModelPicker 联动下拉（Bug 1）」。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/CreateAgentDialog.test.tsx
```

预期：PASS。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add renderer/src/components/agent/CreateAgentDialog.tsx renderer/src/components/agent/CreateAgentDialog.test.tsx
git commit -m "fix: 创建 Agent 弹窗模型名改为供应商联动下拉"
```

---

### Task 3: DefinitionEditor 接入

**Files:**
- Modify: `renderer/src/components/agent/DefinitionEditor.tsx`
- Test: `renderer/src/components/agent/DefinitionEditor.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ProviderModelPicker`
- Produces: edit 模式提交 `ipc.agent.updateDefinition({ ..., modelProviderId, modelName })` 不变；模型字段改为下拉

- [ ] **Step 1: 更新测试（先红）**

`renderer/src/components/agent/DefinitionEditor.test.tsx`：

1）mockApi 增加 provider 命名空间与 updateDefinition 既有桩保持：

```tsx
const listModels = vi.fn();

// mockApi 改为：
const mockApi = {
  agent: {
    createCustom,
    updateDefinition,
    list: vi.fn().mockResolvedValue([]),
  },
  resource: { list: resourceList },
  provider: { listModels },
};

// beforeEach 中：
listModels.mockReset().mockResolvedValue([
  { providerId: 'prov-1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
]);
```

2）create 模式两个提交用例（「提交时 IPC.createCustom 收到 defaultTools」与「勾选 bash 后提交」）中，供应商选择段替换。原：

```tsx
const providerSelect = screen.getByDisplayValue('请选择...') as HTMLSelectElement;
fireEvent.change(providerSelect, { target: { value: 'prov-1' } });
```

替换为（选供应商 + 等模型加载 + 选模型）：

```tsx
fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
await screen.findByRole('option', { name: 'gpt-4o' });
fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });
```

（两个 it 已是 async，直接替换即可。）

3）新增一个模型字段断言用例：

```tsx
it('模型字段为 ProviderModelPicker 下拉（非手填 Input）', async () => {
  render(<DefinitionEditor mode="create" onClose={() => {}} />);
  expect(screen.getByLabelText('模型名').tagName).toBe('SELECT');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/DefinitionEditor.test.tsx
```

预期：FAIL——`getByLabelText('模型供应商*')` 不存在（当前 Select 无该 label 结构被替换前其实存在——实际失败点：模型名 label 现为 Input 的 label「模型名」，`tagName` 断言 'SELECT' 失败；且 getByDisplayValue('请选择...') 在新结构下仍可能命中，以 tagName 用例为准红）。

- [ ] **Step 3: 实现修改**

`renderer/src/components/agent/DefinitionEditor.tsx`：

1）import 区：删除 `import { useProviderStore } from '../../stores/provider.store';`（该 import 位于文件头部，随 providers 使用移除），新增：

```tsx
import { ProviderModelPicker } from './ProviderModelPicker';
```

2）删除：

```tsx
const { providers, loadProviders } = useProviderStore();
// 以及
useEffect(() => { void loadProviders(); }, [loadProviders]);
// 以及整个 handleProviderChange（defaultModel 快填退役）
```

（`Select` import 若再无使用处一并删除——检查文件其余部分无其他 Select。）

3）表单区：删除「模型供应商*」`<Select>` 与「模型名」`<Input>` 两个控件块，替换为：

```tsx
<ProviderModelPicker
  providerId={providerId}
  modelId={modelName}
  onProviderChange={setProviderId}
  onModelChange={setModelName}
  disabled={readOnly}
/>
```

4）文件头注释补一行：「v2.2 fix：模型字段接入 ProviderModelPicker（与创建侧同构）」。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/DefinitionEditor.test.tsx
```

预期：PASS（含 configure 只读用例——disabled 传递保持只读语义）。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add renderer/src/components/agent/DefinitionEditor.tsx renderer/src/components/agent/DefinitionEditor.test.tsx
git commit -m "fix: DefinitionEditor 模型字段接入 ProviderModelPicker"
```

---

### Task 4: MemberEditDialog 模型区 + key 区移除（Bug 2 成员侧）

**Files:**
- Modify: `renderer/src/components/agent/MemberEditDialog.tsx`
- Test: `renderer/src/components/agent/MemberEditDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ProviderModelPicker`；IPC `ipc.agent.updateDefinition({ id, modelProviderId, modelName })`（直接调用，非 store action）
- Produces: 保存链顺序——模型有变化先 `updateDefinition` 再 `setMemberDeltas`；`pendingRestart` 条件 = 模型变更 ∥ deltas 变更

- [ ] **Step 1: 更新测试（先红）**

`renderer/src/components/agent/MemberEditDialog.test.tsx`：

1）mockApi 扩展（provider 供 picker、agent.updateDefinition 供保存链）：

```tsx
const allocationGet = vi.fn();
const workspaceGet = vi.fn();
const resourceList = vi.fn();
const providerListModels = vi.fn();
const updateDefinition = vi.fn();

const mockApi = {
  allocation: { get: allocationGet },
  workspace: { get: workspaceGet },
  resource: { list: resourceList },
  provider: { listModels: providerListModels },
  agent: { updateDefinition },
};

// beforeEach 默认值：
providerListModels.mockReset().mockResolvedValue([
  { providerId: 'p1', modelId: 'm', enabled: true, addedAt: 0 },
  { providerId: 'p1', modelId: 'm2', enabled: true, addedAt: 1 },
]);
updateDefinition.mockReset().mockResolvedValue(undefined);
```

2）新增 provider store 种子（picker 数据源）——import 增加 `import { useProviderStore } from '../../stores/provider.store';`，beforeEach 增加：

```tsx
useProviderStore.setState({
  providers: [
    { id: 'p1', name: 'P1', baseUrl: 'https://a', defaultModel: null, isDefault: true, createdAt: '', platform: 'openai' as const },
    { id: 'p2', name: 'P2', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai' as const },
  ],
  loading: false,
  loadProviders: vi.fn().mockResolvedValue(undefined),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setDefault: vi.fn(),
  clear: vi.fn(),
});
```

（`buildDef` 的 `modelProviderId: 'p1'` / `modelName: 'm'` 与上述种子对齐。）

3）**删除整个 `describe('MemberEditDialog — key-dirty 语义')` 块**（4 个用例：未动 key / 输入 key / 清空 / trim；以及 hasApiKeyOverride 提示条用例）——key 区 UI 已移除。

4）「取消按钮不触发」用例中 `expect(updateMemberApiKeyMock).not.toHaveBeenCalled();` 改为 `expect(updateDefinition).not.toHaveBeenCalled();`（`updateMemberApiKeyMock` 变量与 store 注入一并删除）。

5）「仅 key 变化 → 重启提示」用例替换为「仅模型变化」：

```tsx
it('agent 运行中 + 仅模型变化（deltas 无变化）→ 同样显示重启提示', async () => {
  render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
  // 等模型下拉加载完成
  await screen.findByRole('option', { name: 'm2' });
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => {
    expect(updateDefinition).toHaveBeenCalledTimes(1);
  });
  expect(screen.getByText(/需重启/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '立即重启' })).toBeInTheDocument();
});
```

6）新增「模型区」describe：

```tsx
describe('MemberEditDialog — 模型区（全局定义）', () => {
  it('显示全局影响提示文案与初始模型（def 的 provider/model）', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    expect(screen.getByText(/定义全局共享，模型修改对所有工作空间的同名 agent 生效/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('模型名')).toHaveValue('m');
    });
  });

  it('模型未变化保存 → updateDefinition 不被调用', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByLabelText('bash');
    fireEvent.click(screen.getByLabelText('bash')); // 只改能力
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it('换模型保存 → updateDefinition(def.id, 新 provider/model) 先于 setMemberDeltas', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    // p2 无已启用模型 → 供应商切换后模型清空，此处改为同供应商换 m2
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p1' } });
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateDefinition).toHaveBeenCalledWith({
        id: 'def-1',
        modelProviderId: 'p1',
        modelName: 'm2',
      });
    });
    // 顺序：updateDefinition 先于 setMemberDeltas
    const order: string[] = [];
    updateDefinition.mockImplementation(async () => {
      order.push('def');
    });
    setMemberDeltasMock.mockImplementation(async () => {
      order.push('deltas');
    });
    expect(order).toEqual([]); // 上述注册晚于首次保存，仅占位确保两 mock 均被调用
    expect(setMemberDeltasMock).toHaveBeenCalled();
  });

  it('API Key 区已移除（无 key 输入框）', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByLabelText('bash');
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(screen.queryByText(/当前使用独立 API key override/)).not.toBeInTheDocument();
  });

  it('updateDefinition 失败 → error 展示且弹窗不关闭', async () => {
    updateDefinition.mockRejectedValue(new Error('Agent 定义不存在: def-1'));
    const onClose = vi.fn();
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />);
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('Agent 定义不存在: def-1')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

注：「换模型保存」用例中先切 p2 再切回 p1 是为了显式覆盖联动重置路径（p1 模型列表已缓存，无需再等 listModels）；order 断言段简化为确认两个 mock 均被调用——真正的顺序保证由实现中 `await updateDefinition` 先于 `await setMemberDeltasAction` 承担，此处不做过重的 invocation-order 断言（momo-test-rules：断言生产消费的字段与调用，不测实现细节时序）。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/MemberEditDialog.test.tsx
```

预期：FAIL——新「模型区」用例红（无模型区）；「API Key 区已移除」用例红（key 输入框仍在）；「仅模型变化」用例红。

- [ ] **Step 3: 实现修改**

`renderer/src/components/agent/MemberEditDialog.tsx`：

1）import 区：删除 `import { Info } from 'lucide-react';`（仅 override 提示条使用）与 `import { Input } from '../ui/Input';`（仅 key 输入使用；若文件其他处无 Input——确认：模型名原为手填不在本弹窗，本弹窗 Input 仅 key 用）。新增：

```tsx
import { ProviderModelPicker } from './ProviderModelPicker';
```

2）组件内删除：

```tsx
const updateMemberApiKeyAction = useAgentStore((s) => s.updateMemberApiKey);
// ---- API Key 区 ---- 相关全部状态：
const [apiKey, setApiKey] = useState('');
const [keyDirty, setKeyDirty] = useState(false);
```

3）新增模型区状态（含 def 变化同步，模式与 DefinitionEditor 一致）：

```tsx
// ---- 模型区（全局定义属性）----
const [modelProviderId, setModelProviderId] = useState(def.modelProviderId ?? '');
const [modelName, setModelName] = useState(def.modelName);

useEffect(() => {
  setModelProviderId(def.modelProviderId ?? '');
  setModelName(def.modelName);
}, [def]);
```

4）`handleSave` 重写：

```tsx
async function handleSave(): Promise<void> {
  setSaving(true);
  setError(null);
  try {
    // 模型变更走全局定义更新（先于能力 deltas，spec §3.3b）
    const modelChanged =
      modelProviderId !== (def.modelProviderId ?? '') || modelName !== def.modelName;
    if (modelChanged) {
      if (!modelProviderId || !modelName) {
        setError('请选择模型供应商与模型');
        return;
      }
      await ipc.agent.updateDefinition({ id: def.id, modelProviderId, modelName });
    }
    const newDeltas = computeDeltas(value, defaultCaps);
    await setMemberDeltasAction(member.instanceId, newDeltas);
    const deltasChanged = !deltasEqual(newDeltas, initialDeltas);
    setInitialDeltas(newDeltas);
    if ((modelChanged || deltasChanged) && member.lastRunning) {
      setPendingRestart(true);
    } else {
      onClose();
    }
  } catch (err) {
    setError((err as Error).message);
  } finally {
    setSaving(false);
  }
}
```

（注意：`return` 提前退出时 `finally` 会复位 saving——原有结构已如此，语义正确。）

5）副标题文案更新：

```tsx
<div className="text-xs text-tertiary">
  更新模型与能力覆盖。模型为全局定义属性，修改对所有工作空间的同名 agent 生效。
</div>
```

6）删除整个「API Key 区」`<section>`（含 hasApiKeyOverride 提示条与说明文案），在「能力覆盖区」之前插入模型区：

```tsx
{/* 模型区（全局定义属性——写入 agent_definitions） */}
<section className="flex flex-col gap-2">
  <div className="text-sm text-secondary">模型</div>
  <div className="text-xs text-tertiary">
    定义全局共享，模型修改对所有工作空间的同名 agent 生效
  </div>
  <ProviderModelPicker
    providerId={modelProviderId}
    modelId={modelName}
    onProviderChange={setModelProviderId}
    onModelChange={setModelName}
  />
</section>
```

7）文件头注释更新：说明 key 区已移除（key 统一在「设置 → 模型服务」供应商处管理；后端 override 机制保留）与模型区语义。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/MemberEditDialog.test.tsx
```

预期：PASS。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add renderer/src/components/agent/MemberEditDialog.tsx renderer/src/components/agent/MemberEditDialog.test.tsx
git commit -m "fix: 成员编辑弹窗支持更换模型并移除 API Key 区"
```

---

### Task 5: 资源库编辑入口（Bug 2 资源库侧）

**Files:**
- Modify: `renderer/src/components/resource-library/ResourceDetail.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`
- Test: `renderer/src/components/resource-library/ResourceDetail.test.tsx`
- Test: `renderer/src/components/resource-library/ResourceLibraryView.test.tsx`

**Interfaces:**
- Consumes: Task 3 修改后的 `DefinitionEditor mode='edit'`（props：`{ mode: 'edit', def: AgentDefinition, onClose }`）
- Produces: `ResourceDetail` 新增可选 prop `onEdit?: (id: string) => void`（custom agent 且 installed 时显示「编辑」按钮）

- [ ] **Step 1: 写失败测试**

`ResourceDetail.test.tsx` 新增 describe：

```tsx
describe('ResourceDetail - custom agent 编辑按钮', () => {
  it('custom agent（installed）: 显示「编辑」按钮并触发 onEdit 回调', () => {
    const onEdit = vi.fn();
    const item = baseItem({
      id: 'custom-agent-researcher',
      source: 'custom',
      type: 'agent',
      name: 'Researcher',
      installed: true,
      removable: true,
      custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'sha256:abc' },
    });
    render(<ResourceDetail item={item} onClose={() => {}} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith('custom-agent-researcher');
  });

  it('builtin agent: 不显示「编辑」按钮（定义不可改）', () => {
    render(<ResourceDetail item={baseItem()} onClose={() => {}} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('custom mcp/skill: 不显示「编辑」按钮', () => {
    const item = baseItem({
      id: 'custom-mcp-github',
      source: 'custom',
      type: 'mcp',
      installed: true,
      removable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });
});
```

`ResourceLibraryView.test.tsx`：

1）mockApi 扩展（编辑链路：agent.list 找 def + DefinitionEditor 提交 updateDefinition + picker 拉模型）：

```tsx
const providerListModels = vi.fn();
const agentUpdateDefinition = vi.fn();

// provider 命名空间改为：
provider: {
  list: providerList,
  listModels: providerListModels,
},
// agent 命名空间改为：
agent: {
  list: agentListDefinitions,
  createCustom: agentCreateCustom,
  updateDefinition: agentUpdateDefinition,
},

// beforeEach 默认值：
providerListModels.mockResolvedValue([
  { providerId: 'p1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
]);
agentUpdateDefinition.mockResolvedValue(undefined);
// 重置数组中加入 providerListModels / agentUpdateDefinition
```

2）新增用例（fixture：custom agent 资源 + 对应 def）：

```tsx
const CUSTOM_AGENT_ITEM = baseItem({
  id: 'custom-agent-researcher',
  source: 'custom',
  type: 'agent',
  slug: 'researcher',
  name: 'Researcher',
  description: '自定义 agent',
  installed: true,
  removable: true,
  custom: { installedAt: '2026-08-12T03:00:00.000Z', agentSystemPromptHash: 'sha256:abc' },
});

it('custom agent 详情点「编辑」→ 挂载 DefinitionEditor（编辑 agent 定义）', async () => {
  resourceList.mockResolvedValue([CUSTOM_AGENT_ITEM]);
  agentListDefinitions.mockResolvedValue([
    {
      id: 'def-1',
      name: 'Researcher',
      slug: 'researcher',
      version: '1.0.0',
      runtime: 'declarative',
      systemPrompt: 'p',
      defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
      source: 'custom',
      description: '',
      iconEmoji: '🤖',
      defaultMcps: [],
      defaultSkills: [],
      workspaceId: null,
      modelProviderId: 'p1',
      modelName: 'gpt-4o',
    },
  ]);

  render(<ResourceLibraryView />);
  await waitFor(() => expect(screen.getByText('Researcher')).toBeInTheDocument());

  // 打开详情 → 点编辑
  fireEvent.click(screen.getByText('Researcher'));
  await waitFor(() => {
    expect(screen.getAllByText('Researcher').length).toBeGreaterThanOrEqual(2);
  });
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));

  // DefinitionEditor 弹窗出现（标题「编辑 agent 定义」+ def 名称回填）
  await waitFor(() => {
    expect(screen.getByText('编辑 agent 定义')).toBeInTheDocument();
  });
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Researcher');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

预期：FAIL——`getByRole('button', { name: '编辑' })` 找不到。

- [ ] **Step 3: 实现**

`ResourceDetail.tsx`：

1）lucide import 增加 `Pencil`：

```tsx
import { Bot, Check, Package, Pencil, Puzzle, Trash2, X } from 'lucide-react';
```

2）Props 增加：

```tsx
interface Props {
  item: ResourceItem;
  onClose: () => void;
  onDelete?: (id: string) => void;
  onInstall?: (id: string) => void;
  /** 编辑 custom agent 定义（仅 type=agent && source=custom 显示按钮） */
  onEdit?: (id: string) => void;
}
```

组件签名同步解构 `onEdit`。

3）底部按钮区，在删除按钮之前插入：

```tsx
{/* 编辑按钮：仅 custom agent（installed）显示——挂载 DefinitionEditor 编辑定义 */}
{item.type === 'agent' && item.source === 'custom' && item.installed && onEdit && (
  <Button
    size="sm"
    onClick={() => onEdit(item.id)}
    className="inline-flex items-center gap-1"
  >
    <Pencil size={12} strokeWidth={1.75} aria-hidden />
    编辑
  </Button>
)}
```

4）文件头注释补一行编辑按钮说明。

`ResourceLibraryView.tsx`：

1）import 增加：

```tsx
import { ipc } from '../../ipc/client';
import { DefinitionEditor } from '../agent/DefinitionEditor';
import type { AgentDefinition, ResourceItem, ResourceFilter } from '../../ipc/types';
```

（原 `import type { ResourceItem, ResourceFilter }` 行合并为上面这行。）

2）组件内新增状态与处理函数：

```tsx
// 编辑中的 custom agent 定义（非 null 时挂载 DefinitionEditor）
const [editingDef, setEditingDef] = useState<AgentDefinition | null>(null);

// 资源 id（custom-agent-<slug>）→ 全局定义查找 → 打开编辑弹窗
const handleEditAgent = async (itemId: string): Promise<void> => {
  const item = items.find((i) => i.id === itemId);
  if (!item) return;
  const defs = await ipc.agent.list();
  const def = defs.find((d) => d.source === 'custom' && d.slug === item.slug);
  if (def) {
    setEditingDef(def);
  } else {
    console.warn('未找到资源对应的 agent 定义', { itemId, slug: item.slug });
  }
};
```

3）`<ResourceDetail>` 调用增加 `onEdit={handleEditAgent}`。

4）弹窗区（`{createAgentOpen && ...}` 之后）追加：

```tsx
{editingDef && (
  <DefinitionEditor
    mode="edit"
    def={editingDef}
    onClose={() => {
      setEditingDef(null);
      void load();
    }}
  />
)}
```

5）文件头注释补一行编辑入口说明。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```

预期：PASS。

- [ ] **Step 5: 类型检查 + 提交**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add renderer/src/components/resource-library/ResourceDetail.tsx renderer/src/components/resource-library/ResourceDetail.test.tsx renderer/src/components/resource-library/ResourceLibraryView.tsx renderer/src/components/resource-library/ResourceLibraryView.test.tsx
git commit -m "feat: 资源库自定义 agent 编辑入口（挂载 DefinitionEditor）"
```

---

### Task 6: AddAgentDialog + MembersPanel 入口（Bug 3）

**Files:**
- Create: `renderer/src/components/agent/AddAgentDialog.tsx`
- Modify: `renderer/src/components/agent/MembersPanel.tsx`
- Test: `renderer/src/components/agent/AddAgentDialog.test.tsx`

**Interfaces:**
- Consumes: `useAgentStore` 的 `loadDefinitions()`（全量 builtin + custom）、`loadMembers(workspaceId)`、`addMember(workspaceId, defId): Promise<WorkspaceAgentMember>`、`members`、`definitions`；`useWorkspaceStore.getActive()`
- Produces: `AddAgentDialog({ onClose: () => void })`；MembersPanel 头部新增「+ 添加 Agent」按钮

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/agent/AddAgentDialog.test.tsx
//
// 添加已有 Agent 弹窗（Bug 3）：全量定义列表（builtin + custom），
// 排除当前 workspace 已加入的 def；点「加入」走 agent.store.addMember。
//
// Mock 策略（momo-test-rules）：window.api 桩（agent 命名空间）；
// store setState 注入 action 桩——loadMembers 用 mockImplementation 回写 store，
// 仿真「加入成功后成员列表更新 → 行消失」的真实数据流。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddAgentDialog } from './AddAgentDialog';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

const agentList = vi.fn();
const agentListMembers = vi.fn();
const agentAddMember = vi.fn();

beforeEach(() => {
  agentList.mockReset();
  agentListMembers.mockReset();
  agentAddMember.mockReset();

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    agent: { list: agentList, listMembers: agentListMembers, addMember: agentAddMember },
  };

  useWorkspaceStore.setState({
    workspaces: [
      {
        id: 'ws-1',
        name: 'WS',
        description: '',
        directoryPath: '/tmp',
        gitInitialized: true,
        createdAt: '',
        ownerId: 'u',
        iconEmoji: '📁',
        defaultAgentInstanceId: null,
      },
    ],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
    setDefaultAgent: vi.fn(),
  });
});

/** 全量字段 AgentDefinition fixture */
function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'def-x',
    name: 'X',
    slug: 'x',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [],
    source: 'custom',
    description: 'd',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'p1',
    modelName: 'm',
    ...overrides,
  };
}

/** 全量字段成员 fixture */
function member(defId: string, name: string): WorkspaceAgentMember {
  return {
    instanceId: `inst-${defId}`,
    workspaceId: 'ws-1',
    agentDefinitionId: defId,
    agentUserId: `@${defId}:local`,
    agentName: name,
    iconEmoji: '',
    hasApiKeyOverride: false,
    lastRunning: false,
    createdAt: '',
  };
}

/** store 种子：definitions + members + action 桩 */
function seedStore(defs: AgentDefinition[], members: WorkspaceAgentMember[]): void {
  useAgentStore.setState({
    definitions: defs,
    members,
    teams: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn().mockImplementation(async () => {
      useAgentStore.setState({ definitions: defs });
    }),
    loadMembers: vi.fn().mockImplementation(async () => {
      useAgentStore.setState({ members });
    }),
    loadBuiltinSuggestions: vi.fn(),
    addMember: agentAddMember,
    removeMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    loadTeams: vi.fn(),
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: vi.fn(),
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });
}

describe('AddAgentDialog — 列表与过滤', () => {
  it('全量列出 builtin + custom；已加入当前 ws 的 def 不显示', async () => {
    seedStore(
      [
        def({ id: 'def-b', name: '内置编码员', slug: 'coder', source: 'builtin' }),
        def({ id: 'def-c', name: '审查员', slug: 'reviewer', source: 'custom' }),
        def({ id: 'def-in', name: '已在工作空间的', slug: 'already-in', source: 'custom' }),
      ],
      [member('def-in', '已在工作空间的')],
    );

    render(<AddAgentDialog onClose={() => {}} />);
    expect(await screen.findByText('内置编码员')).toBeInTheDocument();
    expect(screen.getByText('审查员')).toBeInTheDocument();
    expect(screen.queryByText('已在工作空间的')).not.toBeInTheDocument();
  });

  it('source 徽标：builtin=系统预置，custom=自定义', async () => {
    seedStore(
      [
        def({ id: 'def-b', name: '内置编码员', slug: 'coder', source: 'builtin' }),
        def({ id: 'def-c', name: '审查员', slug: 'reviewer', source: 'custom' }),
      ],
      [],
    );
    render(<AddAgentDialog onClose={() => {}} />);
    await screen.findByText('内置编码员');
    expect(screen.getByText('系统预置')).toBeInTheDocument();
    expect(screen.getByText('自定义')).toBeInTheDocument();
  });
});

describe('AddAgentDialog — 加入动作', () => {
  it('点「加入」→ addMember(ws-1, def.id)；成功后该行从列表消失', async () => {
    const defs = [def({ id: 'def-c', name: '审查员', slug: 'reviewer' })];
    seedStore(defs, []);
    agentAddMember.mockImplementation(async (_ws: string, defId: string) => {
      // 仿真真实 store addMember 成功后的 members 追加（组件靠 members 响应式重算使行消失）
      useAgentStore.setState({ members: [member(defId, '审查员')] });
      return member(defId, '审查员');
    });

    render(<AddAgentDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '加入' }));

    await waitFor(() => {
      expect(agentAddMember).toHaveBeenCalledWith('ws-1', 'def-c');
    });
    await waitFor(() => {
      expect(screen.queryByText('审查员')).not.toBeInTheDocument();
    });
  });

  it('addMember 失败（UNIQUE 竞态）→ 行内 error 提示', async () => {
    seedStore([def({ id: 'def-c', name: '审查员', slug: 'reviewer' })], []);
    agentAddMember.mockRejectedValue(new Error('该 agent 定义已加入 workspace，不可重复添加'));

    render(<AddAgentDialog onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '加入' }));

    expect(await screen.findByText(/不可重复添加/)).toBeInTheDocument();
    // 弹窗不关闭
    expect(screen.getByText('添加 Agent 到工作空间')).toBeInTheDocument();
  });
});

describe('AddAgentDialog — 空态与取消', () => {
  it('所有定义均已加入 → 显示空态文案', async () => {
    seedStore([def({ id: 'def-in', name: '已在工作空间的', slug: 'x' })], [
      member('def-in', '已在工作空间的'),
    ]);
    render(<AddAgentDialog onClose={() => {}} />);
    expect(
      await screen.findByText('所有 agent 均已加入本工作空间'),
    ).toBeInTheDocument();
  });

  it('点「取消」→ onClose', async () => {
    seedStore([], []);
    const onClose = vi.fn();
    render(<AddAgentDialog onClose={onClose} />);
    await screen.findByText('所有 agent 均已加入本工作空间');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/AddAgentDialog.test.tsx
```

预期：FAIL——`Cannot find module './AddAgentDialog'`。

- [ ] **Step 3: 实现 AddAgentDialog**

```tsx
// renderer/src/components/agent/AddAgentDialog.tsx
//
// 添加已有 Agent 弹窗（Bug 3）：把全局 agent 定义（builtin + custom）加入当前
// 工作空间。后端链路（agent:addMember，同 ws 同 def UNIQUE 防重复）已存在，
// 本弹窗只做「全量列表 − 已加入」的选择 UI。
//
// - 行结构：iconEmoji + 名称 + source 徽标（系统预置/自定义）+ 描述 + 「加入」
// - 加入成功：store.addMember 追加 members → 列表响应式重算，该行消失
// - UNIQUE 竞态兜底：addMember 报错 → 行内 error + loadMembers 重同步
import { useEffect, useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import type { AgentDefinition } from '../../ipc/types';

interface Props {
  onClose: () => void;
}

export function AddAgentDialog({ onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { definitions, members, loadDefinitions, loadMembers, addMember } = useAgentStore();
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) {
      // 全量定义（builtin + custom，不带 workspaceId 过滤）
      void loadDefinitions();
      void loadMembers(workspace.id);
    }
  }, [workspace, loadDefinitions, loadMembers]);

  // 已加入当前 ws 的定义集合 → 列表只显示「可添加」项
  const memberDefIds = useMemo(
    () => new Set(members.map((m) => m.agentDefinitionId)),
    [members],
  );
  const addableDefs = definitions.filter((d) => !memberDefIds.has(d.id));

  const handleAdd = async (def: AgentDefinition): Promise<void> => {
    if (!workspace) return;
    setJoiningId(def.id);
    setError(null);
    try {
      await addMember(workspace.id, def.id);
    } catch (err) {
      // UNIQUE 竞态（他处刚加入）→ 重同步成员列表 + 行内提示
      setError((err as Error).message);
      await loadMembers(workspace.id);
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title="添加 Agent 到工作空间" width={448}>
      <div className="flex flex-col gap-2">
        {error && (
          <div className="text-status-error text-sm" role="alert">
            {error}
          </div>
        )}

        {addableDefs.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="所有 agent 均已加入本工作空间"
            description="可到「资源库」创建新的 Agent 定义"
          />
        ) : (
          <div className="flex flex-col max-h-96 overflow-y-auto">
            {addableDefs.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-3"
              >
                <span className="text-lg leading-none">{d.iconEmoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">{d.name}</div>
                  <div className="text-xs text-tertiary truncate">{d.description}</div>
                </div>
                <span className="text-xs text-tertiary shrink-0">
                  {d.source === 'builtin' ? '系统预置' : '自定义'}
                </span>
                <Button
                  size="sm"
                  onClick={() => void handleAdd(d)}
                  disabled={joiningId !== null}
                >
                  {joiningId === d.id ? '加入中…' : '加入'}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

（`EmptyState` 的 `icon/title/description` props 与 `MembersPanel.tsx:92` 现有用法一致。）

- [ ] **Step 4: MembersPanel 加入口**

`renderer/src/components/agent/MembersPanel.tsx`：

1）import 增加：

```tsx
import { AddAgentDialog } from './AddAgentDialog';
```

2）`createOpen` 状态旁增加：

```tsx
const [addOpen, setAddOpen] = useState(false);
```

3）头部按钮区改为：

```tsx
<div className="ml-auto flex gap-2">
  <Button type="button" variant="secondary" onClick={() => setAddOpen(true)}>
    + 添加 Agent
  </Button>
  <Button type="button" onClick={() => setCreateOpen(true)}>
    + 创建 Agent
  </Button>
</div>
```

4）弹窗渲染区（`{createOpen && ...}` 旁）增加：

```tsx
{addOpen && <AddAgentDialog onClose={() => setAddOpen(false)} />}
```

5）文件头注释补一行：「+ 添加 Agent → AddAgentDialog（Bug 3：移出后可重新加入）」。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/AddAgentDialog.test.tsx
```

预期：PASS。

- [ ] **Step 6: 类型检查 + 提交**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
git add renderer/src/components/agent/AddAgentDialog.tsx renderer/src/components/agent/AddAgentDialog.test.tsx renderer/src/components/agent/MembersPanel.tsx
git commit -m "feat: Agent 成员面板添加已有 Agent 入口"
```

---

### Task 7: 全量回归

**Files:**
- 无新改动（验证任务；若前序任务有遗漏在此修复）

**Interfaces:**
- Consumes: 全部前序任务产物
- Produces: 回归通过证据

- [ ] **Step 1: renderer 全量测试**

```bash
cd /workspace && npx pnpm@9.0.0 --filter momo-studio-renderer test
```

预期：全绿（含本计划新增/更新的 7 个测试文件，及未触碰的既有套件）。若 MembersPanel 相关快照/用例因新增按钮失败，按最小改动修正断言。

- [ ] **Step 2: 双 workspace 类型检查**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
```

预期：electron + renderer 双 clean。

- [ ] **Step 3: electron 侧测试（确认零回归——本次主进程零改动，跑一遍兜底）**

```bash
cd /workspace && npx pnpm@9.0.0 --filter momo-studio-electron test
```

预期：全绿。

- [ ] **Step 4: 如有修复则提交**

```bash
git status --short
# 仅当有修复性改动时：
git add -A && git commit -m "test: agent 模型选择与成员管理修复回归收尾"
```

---

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：spec §3.1（Task 1）、§3.2（Task 2）、§3.3a（Task 5）、§3.3b（Task 4）、§3.3c（Task 3）、§3.4（Task 6）、§5 测试策略（各任务 TDD + Task 7 回归门）——无缺口。§4 错误处理分散在各任务用例中（listModels/fetchModels 失败 Task 1、updateDefinition 失败 Task 4、UNIQUE 竞态 Task 6）。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
3. **类型一致性**：`ProviderModelPicker` props 五处（组件 + 三个接入 + 测试）签名一致；label 文案「模型供应商*」「模型名」全局一致；`updateDefinition` 入参 `{ id, modelProviderId, modelName }` 与 types.d.ts:884 对齐；`addMember(workspaceId, defId)` 与 agent.store 一致。
