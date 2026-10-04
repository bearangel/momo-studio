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
import { useStreamStore } from '../../stores/stream.store';
import { useWriteGrantStore } from '../../stores/write-grant.store';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { SandboxInfo, WriteBlockedEvent } from '../../ipc/types';

const getStateMock = vi.fn();
const reprobeMock = vi.fn();
const installBwrapMock = vi.fn();
const dismissPromptMock = vi.fn();
const updateGlobalMock = vi.fn();
const grantWriteMock = vi.fn();
const denyWriteMock = vi.fn();

// 桩 window.api（sandbox + settings 命名空间；组件经 ipc Proxy 透传消费）
const mockApi = {
  sandbox: {
    getState: getStateMock,
    reprobe: reprobeMock,
    installBwrap: installBwrapMock,
    dismissPrompt: dismissPromptMock,
    grantWrite: grantWriteMock,
    denyWrite: denyWriteMock,
  },
  settings: {
    updateGlobal: updateGlobalMock,
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
    settings: { mode: 'strict', networkPolicy: 'deny', toolchainPolicy: 'deny', toolchainDirs: ['~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user'] },
    installCommand: 'sudo apt install bubblewrap',
    bwrapPromptDismissed: false,
    winPolicyPromptDismissed: false,
    netPromptDismissed: false,
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
    grantWriteMock.mockReset();
    denyWriteMock.mockReset();
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

  it('是 NoticeStack 条目形态（无 fixed 定位、非遮罩、可交互）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    const root = container.firstChild as HTMLElement;
    // 定位职责移交 NoticeStack 容器；条目自宣 pointer-events-auto
    // （容器 pointer-events-none，不自宣则真实浏览器按钮死点击）——与 UpgradeNotice 同款
    expect(root.className).not.toMatch(/fixed/);
    expect(root.className).not.toMatch(/inset-0/);
    expect(root.className).toMatch(/pointer-events-auto/);
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

// —— netOff 拦截卡（v2.4.x；2026-09-13 修订 B 双态化）——
// 显隐 = netBlockedSeen（stream.store 一次性检测标志）&& !netPromptDismissed
// && networkPolicy === 'deny'（allow 全放行无引导诉求；makeInfo 默认 deny 即本
// 套件语义）。单卡容器三条件并存时 netOff 优先；[去设置] 只导航不 dismiss
//（卡留待用户开完开关自行关）。
describe('SandboxNotice：netOff 拦截卡', () => {
  beforeEach(() => {
    getStateMock.mockReset();
    reprobeMock.mockReset();
    installBwrapMock.mockReset();
    dismissPromptMock.mockReset();
    // 真实 store 归位（不 mock——导航断言走 useUiStore 真实状态转移）
    act(() => {
      useStreamStore.setState({ netBlockedSeen: false });
      useUiStore.setState({ activeView: 'im' });
    });
  });

  it('netBlockedSeen + 未 dismiss → 渲染 netOff 卡（标题 + [去设置] + [知道了]）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    expect(screen.getByText('agent 的网络访问被沙箱拦截')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument();
  });

  it('netBlockedSeen 但 netPromptDismissed → 不渲染', async () => {
    getStateMock.mockResolvedValue(makeInfo({ netPromptDismissed: true }));
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('netBlockedSeen=false → 不渲染（默认 linux 可用场景）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('policy=allow + netBlockedSeen → 不渲染（全放行下无引导诉求）', async () => {
    getStateMock.mockResolvedValue(makeInfo({ settings: { mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'deny', toolchainDirs: [] } }));
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(getStateMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('优先级：netOff 与 bwrap 条件同时满足 → 仅渲染 netOff 卡（bwrap 标题不在场）', async () => {
    getStateMock.mockResolvedValue(makeBwrapInfo());
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    expect(screen.getByText('agent 的网络访问被沙箱拦截')).toBeInTheDocument();
    expect(screen.queryByText('bash 沙箱需要 bubblewrap')).toBeNull();
  });

  it('点击「知道了」→ dismissPrompt(netOff) + 卡片消失', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    dismissPromptMock.mockResolvedValue(undefined);
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));

    expect(dismissPromptMock).toHaveBeenCalledWith('netOff');
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('点击「去设置」→ 仅导航（activeView=settings），不 dismiss、卡片保留', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '去设置' }));

    expect(useUiStore.getState().activeView).toBe('settings');
    expect(dismissPromptMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument();
  });

  it('点击 X 关闭（netOff 卡）→ dismissPrompt(netOff) + 卡片消失', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    dismissPromptMock.mockResolvedValue(undefined);
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(dismissPromptMock).toHaveBeenCalledWith('netOff');
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    });
  });

  it('netOff 卡样式与既有卡一致（NoticeStack 条目形态 + 非模态）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    act(() => {
      useStreamStore.setState({ netBlockedSeen: true });
    });
    const { container } = render(<SandboxNotice />);
    await waitFor(() => expect(screen.getByTestId('sandbox-notice')).toBeInTheDocument());
    const root = container.firstChild as HTMLElement;
    expect(root.className).not.toMatch(/fixed/);
    expect(root.className).not.toMatch(/inset-0/);
    expect(root.className).toMatch(/pointer-events-auto/);
  });
});

// —— 工具链写拦截引导卡（v2.5 沙箱工具链授权，spec 2026-10-01 §7/§8）——
// 显隐 = !showNetOff && toolchainWriteBlockedSeen && !toolchainPromptDismissed
// && toolchainPolicy === 'deny'（makeInfo 默认 deny 即本套件语义）；优先级排
// netOff 之后、bwrap/winPolicy 之前。「本会话允许」= grantToolchain(activeWorkspaceId)
// + 主进程同步置 KV 一次性 flag，renderer 本地 setInfo 隐藏；「去设置」只导航。


// ═══ 通用写授权卡（spec 2026-10-03 §7）═══
describe('SandboxNotice：通用写授权卡', () => {
  const EVT: WriteBlockedEvent = { sessionId: 's-1', workspaceId: 'w-1', dirs: ['/Users/x/.cargo'], command: 'cargo build' };

  // 本 describe 无既有 mock 重置先例，deny 断言用 toHaveBeenCalledWith 需防跨用例
  // 调用累积误绿——补 beforeEach 单独重置 denyWriteMock；默认给 resolved：真实
  // IPC 桥（ipcRenderer.invoke）恒返回 Promise，裸 vi.fn() 回 undefined 会让
  // denyNow 里 .catch(undefined) 同步抛错（mock 保真度：仿真真实返回语义）
  beforeEach(() => {
    denyWriteMock.mockReset();
    denyWriteMock.mockResolvedValue(undefined);
  });

  function receive(e: typeof EVT): void {
    act(() => {
      // 隔离：netBlockedSeen 只置不清（一次性语义）——文件内早前 netOff 用例的
      // 残留 true 会让授权后 netOff 卡顶上，破坏本组显隐断言
      useStreamStore.setState({ netBlockedSeen: false });
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked(e);
    });
  }

  it('pending 事件 → 渲染卡：目录 + 命令 + 三按钮', () => {
    receive(EVT);
    render(<SandboxNotice />);
    expect(screen.getByText(/agent 请求写入工作空间外的目录/)).toBeInTheDocument();
    expect(screen.getByText('/Users/x/.cargo')).toBeInTheDocument();
    expect(screen.getByText('cargo build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '会话允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '始终允许' })).toBeInTheDocument();
  });

  it('会话允许 → grantWrite(session) + 卡消失', async () => {
    grantWriteMock.mockResolvedValue(undefined);
    receive(EVT);
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '会话允许' }));
    await waitFor(() =>
      expect(grantWriteMock).toHaveBeenCalledWith({ scope: 'session', key: 's-1', dirs: ['/Users/x/.cargo'] }),
    );
    await waitFor(() => expect(screen.queryByTestId('sandbox-notice')).toBeNull());
  });

  it('始终允许 → grantWrite(workspace)', async () => {
    grantWriteMock.mockResolvedValue(undefined);
    receive(EVT);
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '始终允许' }));
    await waitFor(() =>
      expect(grantWriteMock).toHaveBeenCalledWith({ scope: 'workspace', key: 'w-1', dirs: ['/Users/x/.cargo'] }),
    );
  });

  // —— 拒绝接线（spec hard-gate §8）：拒绝/X 关闭 → denyWrite 广播解除子进程等待 ——

  it('拒绝 → denyWrite 广播（sessionId+dirs）+ 卡消失', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    receive(EVT);
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() =>
      expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: ['/Users/x/.cargo'] }),
    );
    await waitFor(() => expect(screen.queryByTestId('sandbox-notice')).toBeNull());
  });

  it('X 关闭（writeBlocked 卡）→ 同 denyWrite（关闭即拒绝语义）', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    receive(EVT);
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: ['/Users/x/.cargo'] }),
    );
  });

  it('空 dirs 降级卡关闭 → denyWrite { sessionId, dirs: [] }（空对空匹配链路）', async () => {
    denyWriteMock.mockResolvedValue(undefined);
    receive({ ...EVT, dirs: [] });
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(denyWriteMock).toHaveBeenCalledWith({ sessionId: 's-1', dirs: [] }));
  });

  it('拒绝 → 卡消失 + 同 dirs 不再弹（拒绝记忆）', () => {
    receive(EVT);
    const { unmount } = render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    unmount();
    act(() => {
      useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, command: 'cargo run' });
    });
    render(<SandboxNotice />);
    expect(screen.queryByTestId('sandbox-notice')).toBeNull();
  });

  it('空 dirs（路径提取失败）→ 两授权按钮禁用 + 降级文案 + 无去设置按钮（2026-10-04 删）', () => {
    receive({ ...EVT, dirs: [] });
    render(<SandboxNotice />);
    expect(screen.getByRole('button', { name: '会话允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '始终允许' })).toBeDisabled();
    expect(screen.getByText(/未能定位具体目录/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去设置' })).toBeNull();
  });

  it('sessionId null（映射失败）→ 会话按钮禁用；workspace 按钮可用', () => {
    receive({ ...EVT, sessionId: null });
    render(<SandboxNotice />);
    expect(screen.getByRole('button', { name: '会话允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '始终允许' })).not.toBeDisabled();
  });

  it('workspaceId null 且无激活 workspace → 工作空间按钮禁用；会话按钮可用', () => {
    act(() => {
      useWorkspaceStore.setState({ activeWorkspaceId: null });
    });
    receive({ ...EVT, workspaceId: null });
    render(<SandboxNotice />);
    expect(screen.getByRole('button', { name: '始终允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '会话允许' })).not.toBeDisabled();
  });
});
