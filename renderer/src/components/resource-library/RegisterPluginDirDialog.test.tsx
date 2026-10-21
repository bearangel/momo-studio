// renderer/src/components/resource-library/RegisterPluginDirDialog.test.tsx
//
// 插件 dev 目录注册弹窗测试（spec 2026-10-15 §7.2）：
//   - 空路径时注册按钮禁用
//   - 注册调 plugin.installDevDir（路径透传），成功展示摘要并触发 onSuccess
//   - 失败错误内联展示且弹窗不关
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegisterPluginDirDialog } from './RegisterPluginDirDialog';
import type { PluginSummary } from '../../ipc/types';

const installDevDir = vi.fn();

const mockApi = {
  plugin: { installDevDir },
};

const SUMMARY: PluginSummary = {
  id: 'cg',
  name: 'Codegraph 代码图谱',
  version: '0.2.0',
  description: '图谱',
  state: 'active',
  source: 'dev',
  components: ['tools'],
};

beforeEach(() => {
  installDevDir.mockReset().mockResolvedValue(SUMMARY);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('RegisterPluginDirDialog', () => {
  it('空路径时注册按钮禁用', () => {
    render(<RegisterPluginDirDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: '注册' })).toBeDisabled();
  });

  it('注册调 plugin.installDevDir 成功后自动关闭（onSuccess 带 summary + onClose）', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<RegisterPluginDirDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('插件源码目录'), {
      target: { value: '/Users/x/dev/plugins/codegraph-plugin' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() =>
      expect(installDevDir).toHaveBeenCalledWith('/Users/x/dev/plugins/codegraph-plugin', undefined),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(SUMMARY));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('失败错误内联展示且弹窗不关', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    installDevDir.mockRejectedValueOnce(new Error('dev 插件目录不存在: /nope'));
    render(<RegisterPluginDirDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('插件源码目录'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText(/目录不存在/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
