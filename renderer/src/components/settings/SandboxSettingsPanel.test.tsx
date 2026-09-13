// renderer/src/components/settings/SandboxSettingsPanel.test.tsx
//
// SandboxSettingsPanel 行为测试（v2.4 Task 8，spec §6.4 + v2.4.x 三态化 2026-09-13 §6）：
//   - 挂载时通过 ipc.sandbox.getState 拉取并渲染探测状态区
//   - 状态区四种文案分支：可用（版本）/ win32（pwsh 无 OS 沙箱）/ 不可用（原因）/ 未探测
//   - 模式切换 → ipc.settings.updateGlobal({ sandboxMode }) + 乐观更新
//   - 网络三态分段控件（拒绝/每次询问/永久允许）→ updateGlobal({ sandboxNetworkPolicy })
//     + 分态说明文案切换
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
    settings: { mode: 'strict', networkPolicy: 'ask' },
    installCommand: null,
    bwrapPromptDismissed: false,
    winPolicyPromptDismissed: false,
    netPromptDismissed: false,
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

  it('网络三态：默认选中「每次询问」+ 分态说明文案（ask）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    expect(screen.getByRole('radio', { name: '每次询问' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '拒绝' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '永久允许' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('network-policy-desc').textContent).toContain('信任卡');
  });

  it('网络三态：点「永久允许」→ updateGlobal({ sandboxNetworkPolicy: allow }) + 乐观选中 + 说明切换', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('radio', { name: '永久允许' }));

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxNetworkPolicy: 'allow' });
    });
    expect(screen.getByRole('radio', { name: '永久允许' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '每次询问' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('network-policy-desc').textContent).toContain('不再询问');
  });

  it('网络三态：点「拒绝」→ updateGlobal({ sandboxNetworkPolicy: deny }) + 说明切换', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('radio', { name: '拒绝' }));

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxNetworkPolicy: 'deny' });
    });
    expect(screen.getByTestId('network-policy-desc').textContent).toContain('引导卡');
  });

  it('网络三态：deny 态挂载 → 「拒绝」初始选中', async () => {
    getStateMock.mockResolvedValue(makeInfo({ settings: { mode: 'strict', networkPolicy: 'deny' } }));
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: '拒绝' })).toHaveAttribute('aria-checked', 'true');
    });
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
      settings: { mode: 'permissive', networkPolicy: 'allow' },
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
    expect(screen.getByRole('radio', { name: '永久允许' })).toHaveAttribute('aria-checked', 'true');
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
