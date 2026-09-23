// renderer/src/components/resource-library/ImportBundleDialog.test.tsx
//
// P2.1 Task 6：DXT / MCPB 本地包两阶段导入弹窗测试。
// 阶段一（解析）：选文件 → 「解析」→ parseMcpBundle → 预览
// 阶段二（导入）：userConfigSchema 表单 → 「导入」→ importMcpBundle → 成功消息
//
// 行为约定：
//   - 未选文件 → 「解析」禁用；选文件后回显文件名
//   - 解析后渲染预览（displayName / version / description / serverType / commandPreview）
//   - userConfigSchema 非空 → 渲染表单；required 缺填 → 「导入」禁用
//   - BundleConfigField.sensitive → type=password（区别于 JsonSchemaLike——那边无此语义）
//   - userConfigSchema 为空对象 → 跳过表单直接可导入（config 传 {}）
//   - 导入成功 → 「已导入：{name}（{commandPreview}）」+ onSuccess()（弹窗保留）
//   - 解析失败 → 红字错误，importMcpBundle 不触发
//
// Mock 策略：window.api 桩（resource.parseMcpBundle / importMcpBundle），照抄
// UploadSkillDialog / McpJsonPasteDialog 形态（momo-test-rules：mock 收窄到 IPC 边界）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportBundleDialog } from './ImportBundleDialog';
import type { BundlePreview, ResourceItem } from '../../ipc/types';

// ---- mock IPC 桩（弹窗只触达 resource 两个通道）----
const resourceParseMcpBundle = vi.fn();
const resourceImportMcpBundle = vi.fn();

const mockApi = {
  resource: { parseMcpBundle: resourceParseMcpBundle, importMcpBundle: resourceImportMcpBundle },
};

// ---- 测试载荷 ----
function mkPreview(over: Partial<BundlePreview> = {}): BundlePreview {
  return {
    name: 'demo-server',
    displayName: 'Demo Server',
    version: '1.2.0',
    description: '演示包',
    serverType: 'node',
    commandPreview: 'node dist/index.js --key ${API_KEY}',
    userConfigSchema: {
      API_KEY: {
        type: 'string',
        title: 'API Key',
        description: '服务密钥',
        required: true,
        sensitive: true,
      },
    },
    tempId: 'temp-placeholder',
    ...over,
  };
}

// importMcpBundle 成功返回的 custom ResourceItem（主进程 custom 映射产出）
const IMPORTED: ResourceItem = {
  id: 'custom-mcp-demo-server',
  type: 'mcp',
  source: 'custom',
  slug: 'demo-server',
  name: 'Demo Server',
  description: '演示包',
  installed: true,
  installable: false,
  removable: true,
};

/** 用 fireEvent.change 模拟用户在 input[type=file] 上选了包文件（照抄 UploadSkillDialog 测试） */
function pickFile(file: File): void {
  const input = screen.getByLabelText('选择文件') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  resourceParseMcpBundle.mockReset().mockResolvedValue(mkPreview());
  resourceImportMcpBundle.mockReset().mockResolvedValue(IMPORTED);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('ImportBundleDialog — DXT / MCPB 两阶段导入', () => {
  it('渲染：标题 + 文件选择 input + 「解析」初始禁用（未选文件）', () => {
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '导入 DXT / MCPB 包' })).toBeInTheDocument();
    expect(screen.getByLabelText('选择文件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解析' })).toBeDisabled();
  });

  it('选文件后回显文件名，「解析」恢复可用', () => {
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    pickFile(new File([new Uint8Array([0])], 'demo.dxt'));
    expect(screen.getByText('demo.dxt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解析' })).toBeEnabled();
  });

  it('解析 → 预览元信息 + userConfigSchema 表单（sensitive→password；required 缺填「导入」禁用）', async () => {
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    pickFile(new File([new Uint8Array([1, 2])], 'demo.dxt'));
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('Demo Server')).toBeInTheDocument();
    expect(screen.getByText('1.2.0')).toBeInTheDocument();
    expect(screen.getByText('演示包')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
    expect(screen.getByText(/node dist\/index\.js/)).toBeInTheDocument();
    // required 字段未填 → 「导入」禁用
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled();
    // sensitive 字段渲染为 password；placeholder=description
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', '服务密钥');
  });

  it('填齐 required → 「导入」→ importMcpBundle 收到 buffer/filename/config；成功消息 + onSuccess', async () => {
    const onSuccess = vi.fn();
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={onSuccess} />);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    pickFile(new File([bytes], 'demo.dxt'));
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: 'sk-9' } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() => expect(resourceImportMcpBundle).toHaveBeenCalledTimes(1));
    const [buf, filename, config] = resourceImportMcpBundle.mock.calls[0]!;
    expect(filename).toBe('demo.dxt');
    // buffer 是原文件的 ArrayBuffer（renderer 持有 buffer 二次传参——tempId 非句柄）
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect((buf as ArrayBuffer).byteLength).toBe(bytes.byteLength);
    expect(config).toEqual({ API_KEY: 'sk-9' });
    // 成功消息按契约格式：已导入：{name}（{commandPreview}）——commandPreview 同时
    // 出现在预览块与成功消息，用全文精确匹配锁成功消息节点
    expect(
      await screen.findByText(
        (_, el) =>
          el?.textContent === '已导入：demo-server（node dist/index.js --key ${API_KEY}）',
      ),
    ).toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('userConfigSchema 为空对象 → 跳过表单直接可导入（config 传 {}）', async () => {
    resourceParseMcpBundle.mockResolvedValueOnce(mkPreview({ userConfigSchema: {} }));
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    pickFile(new File([new Uint8Array([0])], 'plain.dxt'));
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText('Demo Server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(() =>
      expect(resourceImportMcpBundle).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'plain.dxt', {}),
    );
  });

  it('解析失败 → 红字错误，importMcpBundle 不触发', async () => {
    resourceParseMcpBundle.mockRejectedValueOnce(new Error('不是合法的 DXT / MCPB 包'));
    render(<ImportBundleDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    pickFile(new File([new Uint8Array([0])], 'bad.dxt'));
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    expect(await screen.findByText(/不是合法的 DXT \/ MCPB 包/)).toBeInTheDocument();
    expect(resourceImportMcpBundle).not.toHaveBeenCalled();
  });
});
