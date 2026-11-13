// renderer/src/components/settings/FileIoSettingsPanel.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileIoSettingsPanel } from './FileIoSettingsPanel';
import * as ToastMod from '../ui/Toast';

const getState = vi.fn();
const probe = vi.fn();
const pickNodePath = vi.fn();
const updateGlobal = vi.fn();
// toast 消费面 spy（CreateWorkspaceDialog.test 同款）：组件命名导入 showToast，
// spyOn 模块命名空间即可拦截（不 mock 整个 Toast 模块）
const showToastSpy = vi.spyOn(ToastMod, 'showToast');

const api = {
  fileIo: { getState, probe, pickNodePath },
  settings: { updateGlobal },
};

beforeEach(() => {
  getState.mockResolvedValue({
    mode: 'direct',
    effectiveMode: 'direct',
    clientInstalled: false,
    nodeAvailable: true,
    nodePath: 'C:\\nodejs\\node.exe',
    nodeVersion: 'v14.21.3',
  });
  probe.mockResolvedValue({
    mode: 'proxy',
    effectiveMode: 'proxy',
    clientInstalled: true,
    nodeAvailable: true,
    nodePath: 'C:\\nodejs\\node.exe',
    nodeVersion: 'v14.21.3',
  });
  updateGlobal.mockResolvedValue(undefined);
  // 默认「取消选择」；选中路径的用例各自 mockResolvedValueOnce
  pickNodePath.mockResolvedValue(null);
  // 只替换 window.api、保留 jsdom 真实 window（整体覆盖 window 会让 React
  // commit 阶段读不到 document/Element 直接崩溃——对齐 HubSettingsPanel.test 锚点）
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  showToastSpy.mockClear();
});

describe('FileIoSettingsPanel', () => {
  it('渲染三档模式与状态卡（中性文案）', async () => {
    render(<FileIoSettingsPanel />);
    expect(await screen.findByText('直接读写（默认）')).toBeInTheDocument();
    expect(screen.getByText('Node 代理')).toBeInTheDocument();
    expect(screen.getByText('自动检测')).toBeInTheDocument();
    expect(screen.getByText(/node\.exe/)).toBeInTheDocument();
    // 中性化：不得出现敏感字样
    expect(document.body.textContent ?? '').not.toMatch(/亿赛通|白名单|安全部门|合规/);
  });

  it('切换模式 → settings.updateGlobal 携带 fileIo 补丁', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('Node 代理');
    fireEvent.click(screen.getByLabelText('Node 代理'));
    await waitFor(() =>
      expect(updateGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ fileIo: expect.objectContaining({ mode: 'proxy' }) }),
      ),
    );
  });

  it('重新检测 → 调 fileIo.probe', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('重新检测');
    fireEvent.click(screen.getByText('重新检测'));
    await waitFor(() => expect(probe).toHaveBeenCalled());
  });

  it('点击「浏览」选中路径 → 落库 + 回填输入框 + 重探测', async () => {
    pickNodePath.mockResolvedValueOnce('/usr/local/bin/node');
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    fireEvent.click(screen.getByRole('button', { name: '浏览' }));
    await waitFor(() =>
      expect(updateGlobal).toHaveBeenCalledWith(
        expect.objectContaining({ fileIo: expect.objectContaining({ nodePath: '/usr/local/bin/node' }) }),
      ),
    );
    expect((screen.getByLabelText('Node.js 路径（可选）') as HTMLInputElement).value).toBe(
      '/usr/local/bin/node',
    );
    await waitFor(() => expect(probe).toHaveBeenCalled());
  });

  // 空输入红线：选择器取消（null）不落任何变更。
  // mock 调用史跨用例累积（beforeEach 只重设返回值），断言前先清零
  it('「浏览」取消 → 不调 updateGlobal', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    updateGlobal.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '浏览' }));
    await waitFor(() => expect(pickNodePath).toHaveBeenCalled());
    expect(updateGlobal).not.toHaveBeenCalled();
  });

  // 错误路径红线：pickNodePath reject → 错误文案 + 面板不崩 + 不落任何变更
  it('「浏览」对话框失败 → 错误文案，面板不崩，不调 updateGlobal', async () => {
    pickNodePath.mockRejectedValueOnce(new Error('dialog failed'));
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    updateGlobal.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '浏览' }));
    expect(await screen.findByText('加载文件访问设置失败，请重试')).toBeInTheDocument();
    // 面板主体仍在（未被卸载成错误页/加载中）
    expect(screen.getByText('直接读写（默认）')).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    expect(updateGlobal).not.toHaveBeenCalled();
  });

  // 错误路径红线：初始加载 reject 不得死滞「加载中」，须落错误态且可重试恢复
  it('初始加载失败 → 错误文案 + 重试按钮（无「加载中」），重试成功后恢复面板', async () => {
    getState.mockRejectedValueOnce(new Error('boom'));
    render(<FileIoSettingsPanel />);
    expect(await screen.findByText('加载文件访问设置失败，请重试')).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('重试'));
    expect(await screen.findByText('直接读写（默认）')).toBeInTheDocument();
    expect(screen.queryByText('加载文件访问设置失败，请重试')).not.toBeInTheDocument();
  });

  // 错误路径红线：重新检测 reject 保留上次状态卡，不冒 unhandled rejection
  it('重新检测失败 → 保留状态卡并展示错误文案', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    probe.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByText('重新检测'));
    expect(await screen.findByText('加载文件访问设置失败，请重试')).toBeInTheDocument();
    // 上次快照仍在（三档 radio + 状态卡未被卸载成「加载中」）
    expect(screen.getByText('直接读写（默认）')).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
  });

  // ── 保存失败路径（2026-11-13 代码审查跟进）：空吞改回滚 + toast ──────────────
  it('切换模式保存失败 → radio 回滚到保存前值 + toast「保存失败，请重试」', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('Node 代理');
    updateGlobal.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByLabelText('Node 代理'));
    await waitFor(() => expect(showToastSpy).toHaveBeenCalledWith('保存失败，请重试'));
    // 乐观 radio 回滚：保存前是 direct
    await waitFor(() => {
      expect(screen.getByLabelText('直接读写（默认）')).toBeChecked();
      expect(screen.getByLabelText('Node 代理')).not.toBeChecked();
    });
  });

  it('「浏览」落库失败 → 输入框回滚到保存前路径 + toast（不静默吞错）', async () => {
    pickNodePath.mockResolvedValueOnce('/new/node');
    updateGlobal.mockRejectedValueOnce(new Error('boom'));
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    fireEvent.click(screen.getByRole('button', { name: '浏览' }));
    await waitFor(() => expect(showToastSpy).toHaveBeenCalledWith('保存失败，请重试'));
    expect((screen.getByLabelText('Node.js 路径（可选）') as HTMLInputElement).value).toBe(
      'C:\\nodejs\\node.exe',
    );
  });

  it('手输路径 blur 落库失败 → toast 提示（输入保留所见值，不再空 catch）', async () => {
    render(<FileIoSettingsPanel />);
    await screen.findByText('直接读写（默认）');
    updateGlobal.mockRejectedValueOnce(new Error('boom'));
    const input = screen.getByLabelText('Node.js 路径（可选）') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/tmp/node' } });
    fireEvent.blur(input);
    await waitFor(() => expect(showToastSpy).toHaveBeenCalledWith('保存失败，请重试'));
    expect(input.value).toBe('/tmp/node');
  });
});
