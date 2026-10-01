// renderer/src/components/settings/LanguageServicesPanel.test.tsx
// 「语言服务」面板契约（多语言 LSP 子系统 Task 6，spec §10 线框）：
//   - 三态渲染：ready（运行态三档）/ missing-binary（未安装 + installHint 引导 + 复制）/ inactive（未检测到工程标志）
//   - 实验性徽标只出现在 experimental 行
//   - 「重新检测」busy 态触发 lsp:redetect(workspaceId) 并刷新列表
//   - status 失败 → 错误行呈现不崩（不阻塞设置页其余 section）
// mock 形态照抄 BrowserSettings.test.tsx（window.api 桩 + ipc Proxy 透传——只 mock
// IPC 边界，client 模块真实运行；@testing-library/user-event 未安装，点击用 fireEvent）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageServicesPanel } from './LanguageServicesPanel';
import type { LanguageStatus } from '../../ipc/types';

const statusMock = vi.fn();
const redetectMock = vi.fn();

const mockApi = {
  lsp: {
    status: statusMock,
    redetect: redetectMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// 真实形状 fixture（types.d.ts 契约——detect.ts 镜像）：覆盖三态 + 实验层
const STATUSES: LanguageStatus[] = [
  { languageId: 'typescript', label: 'TypeScript / JavaScript', tier: 'verified', toolchain: true, binary: true, running: 'idle', installHint: 'npm i -g typescript-language-server' },
  { languageId: 'go', label: 'Go', tier: 'verified', toolchain: true, binary: true, running: 'running', installHint: 'go install ...' },
  { languageId: 'python', label: 'Python', tier: 'verified', toolchain: true, binary: false, running: 'stopped', installHint: 'pip install pyright' },
  { languageId: 'java', label: 'Java', tier: 'experimental', toolchain: true, binary: false, running: 'stopped', installHint: 'brew install jdtls' },
  { languageId: 'rust', label: 'Rust', tier: 'verified', toolchain: false, binary: false, running: 'stopped', installHint: 'rustup ...' },
];

beforeEach(() => {
  statusMock.mockReset();
  redetectMock.mockReset();
  statusMock.mockResolvedValue(STATUSES);
});

describe('LanguageServicesPanel', () => {
  it('渲染三态：ready（含运行态三档文案）/ missing-binary（含引导）/ inactive', async () => {
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    expect(await screen.findByText('TypeScript / JavaScript')).toBeTruthy();
    expect(screen.getByText('闲置')).toBeTruthy(); // ts: idle
    expect(screen.getByText('运行中')).toBeTruthy(); // go: running
    // stopped 文案：python + java 两行 missing-binary 均为未启动
    expect(screen.getAllByText('未启动').length).toBe(2);
    // python 引导：missing-binary 第二行展示 installHint
    expect(screen.getByText(/pip install pyright/)).toBeTruthy();
    // plan 原断言 getByText(/缺少 pyright|未安装/) 在 python+java 双 missing-binary
    // 行下必然多重命中——改为精确锁「未安装」引导行数（两行各一条）
    expect(screen.getAllByText(/未安装/).length).toBe(2);
    // 线框：missing-binary 行附 [复制] 按钮（python + java）
    expect(screen.getAllByLabelText('复制').length).toBe(2);
    expect(screen.getByText('未检测到工程标志')).toBeTruthy(); // rust inactive 灰显
  });

  it('实验性徽标只出现在 experimental 行', async () => {
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    await screen.findByText('Java');
    expect(screen.getAllByText('实验').length).toBe(1);
  });

  it('重新检测调用 redetect 并刷新列表', async () => {
    redetectMock.mockResolvedValue(STATUSES.slice(0, 2));
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    await screen.findByText('Java');
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    await waitFor(() => expect(redetectMock).toHaveBeenCalledWith('ws-1'));
    await waitFor(() => expect(screen.queryByText('Java')).toBeNull());
  });

  it('status 失败 → 错误提示不崩（IPC 失败不阻塞设置页其余部分）', async () => {
    statusMock.mockRejectedValue(new Error('boom'));
    render(<LanguageServicesPanel workspaceId="ws-1" />);
    expect(await screen.findByText(/加载失败/)).toBeTruthy();
  });
});
