// renderer/src/components/settings/SandboxSettingsPanel.test.tsx
//
// SandboxSettingsPanel 行为测试（v2.4 Task 8，spec §6.4）：
//   - 挂载时通过 ipc.sandbox.getState 拉取并渲染探测状态区
//   - 状态区四种文案分支：可用（版本）/ win32（pwsh 无 OS 沙箱）/ 不可用（原因）/ 未探测
//   - 模式切换 → ipc.settings.updateGlobal({ sandboxMode }) + 乐观更新
//   - 网络开关 → ipc.settings.updateGlobal({ sandboxNetwork })
//   - 重新探测 → ipc.sandbox.reprobe 被调 + 状态刷新 + busy 态禁用
// mock 形态照抄 ConversationSettings.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SandboxSettingsPanel } from './SandboxSettingsPanel';
import type { SandboxInfo } from '../../ipc/types';

const getStateMock = vi.fn();
const reprobeMock = vi.fn();
const updateGlobalMock = vi.fn();

// 桩 window.api（sandbox + settings 两个命名空间）
const mockApi = {
  sandbox: {
    getState: getStateMock,
    reprobe: reprobeMock,
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
  },
  settings: {
    getGlobal: vi.fn(),
    updateGlobal: updateGlobalMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// 构造完整 SandboxInfo（真实形状——Task 7 types.d.ts 契约，不用简化占位）
function makeInfo(overrides?: Partial<SandboxInfo>): SandboxInfo {
  return {
    state: {
      platform: 'linux',
      sandboxTool: 'bwrap',
      toolVersion: '0.8.0',
      available: true,
      unavailableReason: null,
      windowsShell: null,
      executionPolicy: null,
      probedAt: 1757500000000,
    },
    settings: { mode: 'strict', networkEnabled: false },
    installCommand: null,
    bwrapPromptDismissed: false,
    winPolicyPromptDismissed: false,
    ...overrides,
  };
}

describe('SandboxSettingsPanel', () => {
  beforeEach(() => {
    getStateMock.mockReset();
    reprobeMock.mockReset();
    updateGlobalMock.mockReset();
    // 保存路径 fire-and-forget：默认挂起，验证乐观更新不等保存返回
    updateGlobalMock.mockReturnValue(new Promise(() => {}));
  });

  it('挂载时显示"加载中..."（getState 未返回）', () => {
    getStateMock.mockReturnValue(new Promise(() => {}));
    render(<SandboxSettingsPanel />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('挂载后调用 ipc.sandbox.getState 并渲染可用状态（版本号）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument();
    });
    expect(getStateMock).toHaveBeenCalledTimes(1);
  });

  it('available 且 toolVersion 为 null 时回退显示 sandboxTool 名', async () => {
    getStateMock.mockResolvedValue(
      makeInfo({
        state: {
          platform: 'darwin',
          sandboxTool: 'seatbelt',
          toolVersion: null,
          available: true,
          unavailableReason: null,
          windowsShell: null,
          executionPolicy: null,
          probedAt: 1757500000000,
        },
      }),
    );
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('seatbelt · 已启用')).toBeInTheDocument();
    });
  });

  it('win32 不可用时显示 pwsh · 无 OS 沙箱（Windows）', async () => {
    getStateMock.mockResolvedValue(
      makeInfo({
        state: {
          platform: 'win32',
          sandboxTool: null,
          toolVersion: null,
          available: false,
          unavailableReason: null,
          windowsShell: 'pwsh',
          executionPolicy: 'Restricted',
          probedAt: 1757500000000,
        },
      }),
    );
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('pwsh · 无 OS 沙箱（Windows）')).toBeInTheDocument();
    });
  });

  it('Linux 不可用时显示不可用原因', async () => {
    getStateMock.mockResolvedValue(
      makeInfo({
        state: {
          platform: 'linux',
          sandboxTool: null,
          toolVersion: null,
          available: false,
          unavailableReason: 'bwrap 未安装',
          windowsShell: null,
          executionPolicy: null,
          probedAt: 1757500000000,
        },
      }),
    );
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('不可用：bwrap 未安装')).toBeInTheDocument();
    });
  });

  it('不可用且原因为 null 时兜底"未知"（错误路径）', async () => {
    getStateMock.mockResolvedValue(
      makeInfo({
        state: {
          platform: 'linux',
          sandboxTool: null,
          toolVersion: null,
          available: false,
          unavailableReason: null,
          windowsShell: null,
          executionPolicy: null,
          probedAt: 1757500000000,
        },
      }),
    );
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('不可用：未知')).toBeInTheDocument();
    });
  });

  it('state 为 null 时显示"未探测"（boot 早期）', async () => {
    getStateMock.mockResolvedValue(makeInfo({ state: null }));
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('未探测')).toBeInTheDocument();
    });
  });

  it('切换模式为 permissive → 调 updateGlobal({ sandboxMode }) 且乐观选中', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    const permissiveRadio = screen.getByRole('radio', { name: /permissive/ });
    expect(permissiveRadio).not.toBeChecked();
    fireEvent.click(permissiveRadio);

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxMode: 'permissive' });
    });
    // 乐观更新：updateGlobal 挂起（默认 mock）但 radio 已切换
    expect(permissiveRadio).toBeChecked();
    expect(screen.getByRole('radio', { name: /strict/ })).not.toBeChecked();
  });

  it('勾选网络开关 → 调 updateGlobal({ sandboxNetwork: true }) 且乐观选中', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    const checkbox = screen.getByRole('checkbox', { name: /允许沙箱内 bash 访问网络/ });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxNetwork: true });
    });
    expect(checkbox).toBeChecked();
  });

  it('点击"重新探测" → 调 reprobe 并用返回值刷新状态区', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    const refreshed = makeInfo({
      state: {
        platform: 'linux',
        sandboxTool: 'bwrap',
        toolVersion: '0.9.0',
        available: true,
        unavailableReason: null,
        windowsShell: null,
        executionPolicy: null,
        probedAt: 1757500001000,
      },
      settings: { mode: 'permissive', networkEnabled: true },
    });
    reprobeMock.mockResolvedValue(refreshed);
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '重新探测' }));

    await waitFor(() => {
      expect(screen.getByText('0.9.0 · 已启用')).toBeInTheDocument();
    });
    expect(reprobeMock).toHaveBeenCalledTimes(1);
    // 返回值里的 settings 同步刷新（模式/网络控件跟随）
    expect(screen.getByRole('radio', { name: /permissive/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /允许沙箱内 bash 访问网络/ })).toBeChecked();
  });

  it('探测进行中按钮禁用并显示"探测中..."，完成后恢复', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    let resolveReprobe: (v: SandboxInfo) => void = () => {};
    reprobeMock.mockReturnValue(
      new Promise<SandboxInfo>((res) => {
        resolveReprobe = res;
      }),
    );
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '重新探测' }));

    const busyButton = screen.getByRole('button', { name: '探测中...' });
    expect(busyButton).toBeDisabled();

    await act(async () => {
      resolveReprobe(makeInfo());
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重新探测' })).toBeEnabled();
    });
  });
});
