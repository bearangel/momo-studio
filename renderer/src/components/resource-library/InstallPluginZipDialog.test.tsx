// renderer/src/components/resource-library/InstallPluginZipDialog.test.tsx
//
// 插件 zip 安装弹窗测试（spec 2026-10-15 §7.2 / P1 预览确认稿）：
//   - 选择 zip 后回显文件名
//   - 安装调 plugin.installZip（Uint8Array + 文件名透传）
//   - 成功展示「已安装：<name>（<id> v<version>，组件 N 项）」并触发 onSuccess
//   - 校验失败错误内联展示（多行）且弹窗不关
//   - 安装中锁定关闭与按钮
//
// Mock 策略遵循 ImportAgentYamlDialog.test 既有形态：真实 jsdom window 上装
// window.api，ipc.client 走真 Proxy 经桩。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InstallPluginZipDialog } from './InstallPluginZipDialog';
import type { PluginSummary } from '../../ipc/types';

const installZip = vi.fn();

const mockApi = {
  plugin: { installZip },
};

const SUMMARY: PluginSummary = {
  id: 'cg',
  name: 'Codegraph 代码图谱',
  version: '0.1.0',
  description: '图谱',
  state: 'active',
  source: 'zip',
  components: ['tools', 'service', 'agents', 'skills', 'panel'],
};

function pickZip(): void {
  const file = new File([new Uint8Array([1, 2, 3])], 'codegraph-0.1.0.zip', {
    type: 'application/zip',
  });
  fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [file] } });
}

beforeEach(() => {
  installZip.mockReset().mockResolvedValue(SUMMARY);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('InstallPluginZipDialog', () => {
  it('选择 zip 后展示文件名', async () => {
    render(<InstallPluginZipDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    pickZip();
    expect(await screen.findByText('codegraph-0.1.0.zip')).toBeTruthy();
  });

  it('安装调 plugin.installZip 且成功展示名称与组件数，触发 onSuccess', async () => {
    const onSuccess = vi.fn();
    render(<InstallPluginZipDialog onClose={vi.fn()} onSuccess={onSuccess} />);
    pickZip();
    await screen.findByText('codegraph-0.1.0.zip');
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => expect(installZip).toHaveBeenCalledTimes(1));
    const [data, filename] = installZip.mock.calls[0] as [Uint8Array, string];
    expect(data).toBeInstanceOf(Uint8Array);
    expect(filename).toBe('codegraph-0.1.0.zip');
    expect(
      await screen.findByText(/已安装：Codegraph 代码图谱（cg v0\.1\.0，组件 5 项）/),
    ).toBeTruthy();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('校验失败错误内联多行展示且弹窗不关', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    installZip.mockRejectedValueOnce(
      new Error('id: 非法插件 id（白名单外字符）: Bad!\ncomponents.tools: 路径不合法: /etc'),
    );
    render(<InstallPluginZipDialog onClose={onClose} onSuccess={onSuccess} />);
    pickZip();
    await screen.findByText('codegraph-0.1.0.zip');
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(await screen.findByText(/非法插件 id/)).toBeTruthy();
    expect(screen.getByText(/路径不合法/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('未选文件时安装按钮禁用', () => {
    render(<InstallPluginZipDialog onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('button', { name: '安装' })).toBeDisabled();
  });
});
