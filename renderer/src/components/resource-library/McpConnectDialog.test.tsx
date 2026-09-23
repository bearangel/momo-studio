// renderer/src/components/resource-library/McpConnectDialog.test.tsx
//
// P2.1 Task 6：Smithery 连接配置弹窗测试（resource:install 返回 needsConfig 后
// 按 configSchema 收集配置，提交走 onSubmit——View 层接线 installSmitheryRemote）。
//
// 行为约定：
//   - 按 schema.properties 渲染输入框（label=title 缺省回退字段名；placeholder=description）
//   - JsonSchemaLike 契约无 sensitive——输入框一律 type=text（「勿扩契约」回归锁）
//   - schema.required 缺填 → 「连接」禁用；补齐后恢复
//   - 提交 → onSubmit 收到 values（必填 + 非空可选项；空可选项不下发）
//   - onSubmit 成功 → 弹窗自关（onClose）；失败 → 红字错误留在弹窗、可重试
//   - 提交锁定期 → 输入与按钮全部禁用（照抄 UploadSkillDialog lockAll 语义）
//
// Mock 策略：弹窗零 IPC（onSubmit/onClose 由父注入 vi.fn()），不触达 window.api
// （momo-test-rules：mock 收窄到边界）。vitest globals:false，显式导入。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpConnectDialog } from './McpConnectDialog';
import type { JsonSchemaLike } from '../../ipc/types';

const SCHEMA: JsonSchemaLike = {
  required: ['apiKey'],
  properties: {
    apiKey: { title: 'API Key', description: 'Smithery 服务密钥' },
    region: {},
  },
};

describe('McpConnectDialog — Smithery 连接配置', () => {
  it('渲染：标题「连接 {serverName}」+ 按 properties 渲染输入框（label/placeholder 规则）', () => {
    render(
      <McpConnectDialog serverName="Weather MCP" schema={SCHEMA} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: '连接 Weather MCP' })).toBeInTheDocument();
    // label = title；缺省 title 回退字段名
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('region')).toBeInTheDocument();
    // placeholder = description
    expect(screen.getByLabelText('API Key')).toHaveAttribute('placeholder', 'Smithery 服务密钥');
  });

  it('JsonSchemaLike 无 sensitive 语义——输入框一律 type=text（勿扩契约回归锁）', () => {
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('region')).toHaveAttribute('type', 'text');
  });

  it('required 缺填 → 「连接」禁用；补齐后恢复可用', () => {
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '连接' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();
  });

  it('提交 → onSubmit 收到必填 + 非空可选项（空可选项不下发）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    // 空的 region 不下发——避免空串进 header / query
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ apiKey: 'sk-1' }));
  });

  it('可选项填了就随 values 下发', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.change(screen.getByLabelText('region'), { target: { value: 'eu' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ apiKey: 'sk-1', region: 'eu' }));
  });

  it('onSubmit 成功 → 弹窗自关（onClose 触发）', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('onSubmit 失败 → 红字错误留在弹窗、不 onClose、解锁后可重试', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('连接超时'));
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByText(/连接超时/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // 解锁后可重试：第二次成功 → 自关
    onSubmit.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('提交锁定期 → 输入与按钮全部禁用（防双击）', async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<McpConnectDialog serverName="s" schema={SCHEMA} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '连接中…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    });
    expect(screen.getByLabelText('API Key')).toBeDisabled();
    // 解除卡死，让组件清理
    resolveSubmit();
  });
});
