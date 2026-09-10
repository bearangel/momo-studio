// renderer/src/components/settings/SandboxNotice.test.tsx
//
// SandboxNotice 首启提示卡测试（v2.4 Task 9，spec §6.3）：
//   - bwrap 卡：linux 不可用 + 未忽略 + 有 installCommand → 渲染（含命令文本）
//   - 一键安装：busy 态禁用 → installBwrap → reprobe → available=true 卡片消失；
//     安装失败（ok:false）reprobe 仍不可用 → 卡片保留（错误路径）
//   - 暂不 / X 关闭：dismissPrompt('bwrap') 被调 + 本地隐藏
//   - 授权卡：win32 + Restricted → 渲染（含 Set-ExecutionPolicy 命令）；
//     「我已授权，重新检测」走 reprobe；复制走 clipboard.writeText
//   - null 分支：可用 / 已忽略 / installCommand 缺失 / 策略已放开 / 非目标平台 / state null
// mock 形态照抄 SandboxSettingsPanel.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SandboxNotice } from './SandboxNotice';
import type { SandboxInfo } from '../../ipc/types';

const getStateMock = vi.fn();
const reprobeMock = vi.fn();
const installBwrapMock = vi.fn();
const dismissPromptMock = vi.fn();

// 桩 window.api（sandbox 命名空间；组件经 ipc Proxy 透传消费）
const mockApi = {
  sandbox: {
    getState: getStateMock,
    reprobe: reprobeMock,
    installBwrap: installBwrapMock,
    dismissPrompt: dismissPromptMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// 构造完整 SandboxInfo（真实形状——types.d.ts 契约，不用简化占位）
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
    installCommand: 'sudo apt install bubblewrap',
    bwrapPromptDismissed: false,
    winPolicyPromptDismissed: false,
    ...overrides,
  };
}

// linux 不可用场景（bwrap 卡触发态）
function makeBwrapInfo(overrides?: Partial<SandboxInfo>): SandboxInfo {
  return makeInfo({
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
    ...overrides,
  });
}

// win32 Restricted 场景（授权卡触发态）
function makeWinInfo(overrides?: Partial<SandboxInfo>): SandboxInfo {
  return makeInfo({
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
    installCommand: null,
    ...overrides,
  });
}

describe('SandboxNotice（v2.4 Task 9）', () => {
  beforeEach(() => {
    getStateMock.mockReset();
    reprobeMock.mockReset();
    installBwrapMock.mockReset();
    dismissPromptMock.mockReset();
  });

  it('挂载时调 ipc.sandbox.getState', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
  });

  it('linux 不可用未忽略 → 渲染 bwrap 卡（标题 + installCommand + 操作按钮）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    render(<SandboxNotice />);
    await waitFor(() => {
      expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument();
    });
    expect(screen.getByText('bash 沙箱需要 bubblewrap')).toBeInTheDocument();
    expect(screen.getByText('sudo apt install bubblewrap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键安装' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂不' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制命令/ })).toBeInTheDocument();
  });

  it('installCommand 等宽展示 + 可整段选中复制（font-mono + select-all）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    const code = screen.getByText('sudo apt install bubblewrap');
    expect(code.className).toMatch(/font-mono/);
    expect(code.className).toMatch(/select-all/);
  });

  it('是非模态卡片（fixed 定位、非遮罩）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    const root = container.firstChild as HTMLElement;
    // fixed 定位 + 右下角锚点 + 无 inset-0（不是全屏遮罩）——与 UpgradeNotice 同款
    expect(root.className).toMatch(/fixed/);
    expect(root.className).toMatch(/right-/);
    expect(root.className).toMatch(/bottom-/);
    expect(root.className).not.toMatch(/inset-0/);
  });

  it('点击「复制命令」→ clipboard.writeText(installCommand)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    getStateMock.mockResolvedValue(makeBwrapInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /复制命令/ }));
    expect(writeText).toHaveBeenCalledWith('sudo apt install bubblewrap');
  });

  it('点击「一键安装」→ installBwrap + reprobe；装好后卡片自然消失', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    installBwrapMock.mockResolvedValue({ ok: true, output: '' });
    reprobeMock.mockResolvedValue(makeInfo()); // available=true
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '一键安装' }));

    await waitFor(() => expect(installBwrapMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reprobeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('一键安装进行中按钮禁用并显示「安装中…」，完成后恢复', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    let resolveInstall: (v: { ok: boolean; output: string }) => void = () => {};
    installBwrapMock.mockReturnValue(
      new Promise<{ ok: boolean; output: string }>((res) => {
        resolveInstall = res;
      }),
    );
    // 安装后仍不可用（避免卡片消失干扰 busy 恢复断言）
    reprobeMock.mockResolvedValue(makeBwrapInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '一键安装' }));

    const busyButton = screen.getByRole('button', { name: '安装中…' });
    expect(busyButton).toBeDisabled();

    await act(async () => {
      resolveInstall({ ok: true, output: '' });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '一键安装' })).toBeEnabled();
    });
  });

  it('安装失败（ok:false）+ reprobe 仍不可用 → 卡片保留（错误路径）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    installBwrapMock.mockResolvedValue({ ok: false, output: 'pkexec: not found' });
    reprobeMock.mockResolvedValue(makeBwrapInfo()); // 仍不可用
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '一键安装' }));

    await waitFor(() => expect(reprobeMock).toHaveBeenCalledTimes(1));
    // 卡片保留：用户可改用展示中的手动安装命令
    expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument();
  });

  it('点击「暂不」→ dismissPrompt(bwrap) 被调 + 卡片消失', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    dismissPromptMock.mockResolvedValue(undefined);
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '暂不' }));

    expect(dismissPromptMock).toHaveBeenCalledWith('bwrap');
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('点击 X 关闭（bwrap 卡）→ dismissPrompt(bwrap) + 卡片消失', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    dismissPromptMock.mockResolvedValue(undefined);
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(dismissPromptMock).toHaveBeenCalledWith('bwrap');
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('win32 + Restricted → 渲染授权卡（标题 + Set-ExecutionPolicy 命令）', async () => {
    getStateMock.mockResolvedValue(makeWinInfo());
    render(<SandboxNotice />);
    await waitFor(() => {
      expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument();
    });
    expect(screen.getByText('PowerShell 脚本执行未授权')).toBeInTheDocument();
    expect(
      screen.getByText('Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我已授权，重新检测' })).toBeInTheDocument();
  });

  it('授权卡命令等宽展示 + 可整段选中复制', async () => {
    getStateMock.mockResolvedValue(makeWinInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    const code = screen.getByText(
      'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
    );
    expect(code.className).toMatch(/font-mono/);
    expect(code.className).toMatch(/select-all/);
  });

  it('授权卡点击「复制」→ clipboard.writeText(Set-ExecutionPolicy…)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    getStateMock.mockResolvedValue(makeWinInfo());
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    expect(writeText).toHaveBeenCalledWith(
      'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned',
    );
  });

  it('点击「我已授权，重新检测」→ reprobe + 策略放开后卡片消失', async () => {
    getStateMock.mockResolvedValue(makeWinInfo());
    // 重新检测后策略放开（RemoteSigned）→ 授权卡不再满足显隐条件
    reprobeMock.mockResolvedValue(
      makeWinInfo({
        state: {
          platform: 'win32',
          sandboxTool: null,
          toolVersion: null,
          available: false,
          unavailableReason: null,
          windowsShell: 'pwsh',
          executionPolicy: 'RemoteSigned',
          probedAt: 1757500001000,
        },
      }),
    );
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '我已授权，重新检测' }));

    await waitFor(() => expect(reprobeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('点击 X 关闭（授权卡）→ dismissPrompt(winPolicy) + 卡片消失', async () => {
    getStateMock.mockResolvedValue(makeWinInfo());
    dismissPromptMock.mockResolvedValue(undefined);
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(dismissPromptMock).toHaveBeenCalledWith('winPolicy');
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  // ---- null 分支（可用 / 已忽略 / 缺 installCommand / 策略放开 / 非目标平台 / state null）----

  it('linux 已可用 → 不渲染', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('linux 不可用但 bwrapPromptDismissed → 不渲染', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo({ bwrapPromptDismissed: true }));
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('linux 不可用但 installCommand 为 null（包管理器探测失败）→ 不渲染', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo({ installCommand: null }));
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('win32 Restricted 但 winPolicyPromptDismissed → 不渲染', async () => {
    getStateMock.mockResolvedValue(makeWinInfo({ winPolicyPromptDismissed: true }));
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('win32 策略已放开（RemoteSigned）→ 不渲染', async () => {
    getStateMock.mockResolvedValue(
      makeWinInfo({
        state: {
          platform: 'win32',
          sandboxTool: null,
          toolVersion: null,
          available: false,
          unavailableReason: null,
          windowsShell: 'pwsh',
          executionPolicy: 'RemoteSigned',
          probedAt: 1757500000000,
        },
      }),
    );
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('darwin 平台 → 不渲染（非目标平台）', async () => {
    getStateMock.mockResolvedValue(
      makeInfo({
        state: {
          platform: 'darwin',
          sandboxTool: 'seatbelt',
          toolVersion: '0.2',
          available: true,
          unavailableReason: null,
          windowsShell: null,
          executionPolicy: null,
          probedAt: 1757500000000,
        },
      }),
    );
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('state 为 null（boot 早期探测未完成）→ 不渲染', async () => {
    getStateMock.mockResolvedValue(makeInfo({ state: null }));
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });
});
