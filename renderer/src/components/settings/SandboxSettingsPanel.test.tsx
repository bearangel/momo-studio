// renderer/src/components/settings/SandboxSettingsPanel.test.tsx
//
// SandboxSettingsPanel 行为测试（v2.4 Task 8，spec §6.4；2026-09-13 修订 B 双态化）：
//   - 挂载时通过 ipc.sandbox.getState 拉取并渲染探测状态区
//   - 状态区四种文案分支：可用（版本）/ win32（pwsh 无 OS 沙箱）/ 不可用（原因）/ 未探测
//   - 模式切换 → ipc.settings.updateGlobal({ sandboxMode }) + 乐观更新
//   - 网络双态单选（永久允许（默认）/ 拒绝）→ updateGlobal({ sandboxNetworkPolicy })
//     + 分态说明文案切换
//   - 重新探测 → ipc.sandbox.reprobe 被调 + 状态刷新 + busy 态禁用
//   - 工具链双态单选（v2.5 Task 7，spec §10）：deny 默认渲染；allow/deny 互切
//     → updateGlobal({ sandboxToolchainPolicy })
//   - 目录清单 textarea（v2.5 Task 7）：初值 join('\n')；显式「保存清单」按钮
//     （编辑不自动保存；trim + 去空行归一化回显）；「恢复默认」写回 DEFAULT 五项；
//     空输入边界；reprobe 刷新同步 + dirty 保护
// mock 形态照抄 ConversationSettings.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SandboxSettingsPanel } from './SandboxSettingsPanel';
import type { SandboxInfo } from '../../ipc/types';

const getStateMock = vi.fn();
const reprobeMock = vi.fn();
const updateGlobalMock = vi.fn();
const listWriteGrantsMock = vi.fn();
const revokeWriteMock = vi.fn();

// 桩 window.api（sandbox + settings 两个命名空间）
const mockApi = {
  sandbox: {
    getState: getStateMock,
    reprobe: reprobeMock,
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
    listWriteGrants: listWriteGrantsMock,
    revokeWrite: revokeWriteMock,
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
    settings: { mode: 'strict', networkPolicy: 'allow' },
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
    listWriteGrantsMock.mockReset();
    listWriteGrantsMock.mockResolvedValue([]);
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

  it('网络双态：默认选中「永久允许（默认）」+ 两项行内说明常驻', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    expect(screen.getByRole('radio', { name: '永久允许（默认）' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '拒绝' })).not.toBeChecked();
    expect(screen.getByText(/全放行网络/)).toBeInTheDocument();
    expect(screen.getByText(/一次性引导卡/)).toBeInTheDocument();
  });

  it('网络双态：deny 态点「永久允许（默认）」→ updateGlobal({ sandboxNetworkPolicy: allow }) + 乐观选中', async () => {
    getStateMock.mockResolvedValue(makeInfo({ settings: { mode: 'strict', networkPolicy: 'deny' } }));
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('radio', { name: '永久允许（默认）' }));

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxNetworkPolicy: 'allow' });
    });
    expect(screen.getByRole('radio', { name: '永久允许（默认）' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '拒绝' })).not.toBeChecked();
  });

  it('网络双态：点「拒绝」→ updateGlobal({ sandboxNetworkPolicy: deny })', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('0.8.0 · 已启用')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('radio', { name: '拒绝' }));

    await waitFor(() => {
      expect(updateGlobalMock).toHaveBeenCalledWith({ sandboxNetworkPolicy: 'deny' });
    });
    expect(screen.getByRole('radio', { name: '拒绝' })).toBeChecked();
  });

  it('网络三态：deny 态挂载 → 「拒绝」初始选中', async () => {
    getStateMock.mockResolvedValue(makeInfo({ settings: { mode: 'strict', networkPolicy: 'deny' } }));
    render(<SandboxSettingsPanel />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: '拒绝' })).toBeChecked();
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
    expect(screen.getByRole('radio', { name: '永久允许（默认）' })).toBeChecked();
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

// —— 工具链目录写入双态 + 目录清单编辑（v2.5 沙箱工具链授权 Task 7，spec §10）——
// radio 走既有 save 乐观模式；清单为显式「保存清单」按钮（编辑/失焦不自动保存）；
// 「恢复默认」写回与 electron 端 toolchain-grant.ts DEFAULT_TOOLCHAIN_DIRS 对齐的五项。
describe('SandboxSettingsPanel：已授权目录', () => {
  beforeEach(() => {
    listWriteGrantsMock.mockReset();
    revokeWriteMock.mockReset();
    revokeWriteMock.mockResolvedValue(undefined);
  });

  it('列出工作空间持久授权 + 删除经确认弹窗后才调 revokeWrite（红色危险按钮）', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    listWriteGrantsMock.mockResolvedValue([{ workspaceId: 'w-1', dirs: ['/tmp/grant-a'] }]);
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('/tmp/grant-a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    // 确认弹窗出现；未确认前不撤销
    expect(screen.getByText(/确定撤销 \/tmp\/grant-a/)).toBeInTheDocument();
    expect(revokeWriteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '撤销授权' }));
    await waitFor(() =>
      expect(revokeWriteMock).toHaveBeenCalledWith({ scope: 'workspace', key: 'w-1', dir: '/tmp/grant-a' }),
    );
    await waitFor(() => expect(screen.queryByText('/tmp/grant-a')).toBeNull());
  });

  it('确认弹窗取消 → 不调 revokeWrite、授权保留', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    listWriteGrantsMock.mockResolvedValue([{ workspaceId: 'w-1', dirs: ['/tmp/grant-a'] }]);
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('/tmp/grant-a')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(revokeWriteMock).not.toHaveBeenCalled();
    expect(screen.getByText('/tmp/grant-a')).toBeInTheDocument();
    expect(screen.queryByText(/确定撤销/)).toBeNull();
  });

  it('空授权 → 空态文案', async () => {
    getStateMock.mockResolvedValue(makeInfo());
    listWriteGrantsMock.mockResolvedValue([]);
    render(<SandboxSettingsPanel />);
    await waitFor(() => expect(screen.getByText('暂无持久授权')).toBeInTheDocument());
  });
});
