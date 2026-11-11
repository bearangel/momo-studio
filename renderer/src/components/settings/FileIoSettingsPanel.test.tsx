// renderer/src/components/settings/FileIoSettingsPanel.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileIoSettingsPanel } from './FileIoSettingsPanel';

const getState = vi.fn();
const probe = vi.fn();
const updateGlobal = vi.fn();

const api = {
  fileIo: { getState, probe },
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
  // 只替换 window.api、保留 jsdom 真实 window（整体覆盖 window 会让 React
  // commit 阶段读不到 document/Element 直接崩溃——对齐 HubSettingsPanel.test 锚点）
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
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
});
