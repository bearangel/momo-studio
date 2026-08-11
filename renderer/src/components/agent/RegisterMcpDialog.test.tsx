// renderer/src/components/agent/RegisterMcpDialog.test.tsx
//
// v1.6 Task 13：RegisterMcpDialog 测试——表单式注册自定义 MCP server。
//
// 行为约定：
//   - 表单字段：名称*（必填）+ 版本 + 命令*（必填）+ 参数（逗号分隔）+ 环境变量（多行 KEY=VALUE，[+] 加行）
//   - 必填校验：名称或命令为空 → 提交按钮 disabled
//   - 提交：
//       args = params.split(',').map(trim).filter(Boolean)
//       env = Object.fromEntries(envRows 解析)
//       await ipc.mcp.register({ id: randomUUID, name, version, command, args, env, source: 'custom' })
//       await ipc.mcp.start(activeWorkspaceId, name)
//       成功 → onSuccess() 刷新父列表 + onClose() 关闭
//   - source 必须显式 'custom'（否则被 T6 的 deleteRegistered 拒绝）
//   - 提交期间按钮 disabled（防双击）；失败 → 红字错误，弹窗不关
//
// Mock 策略：window.api 桩（mcp.register/mcp.start）+ useWorkspaceStore.setState 注入 activeWorkspaceId。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegisterMcpDialog } from './RegisterMcpDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { Workspace } from '../../ipc/types';

// ---- mock IPC 桩 ----
const mcpRegister = vi.fn();
const mcpStart = vi.fn();

const mockApi = {
  mcp: { register: mcpRegister, start: mcpStart },
};

// 固定 randomUUID，便于断言传入的 id（需匹配 UUID 的模板字面量类型）
const FIXED_UUID = 'fixed-uuid1-1234-5678-9abc';
beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID);
});

const WS: Workspace = {
  id: 'ws-active',
  name: '当前工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  matrixSpaceId: '!space:server',
  teamRoomId: '!team:server',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

beforeEach(() => {
  mcpRegister.mockReset();
  mcpStart.mockReset();
  mcpRegister.mockResolvedValue(undefined);
  mcpStart.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-active',
    loading: false,
    error: null,
  });
});

describe('RegisterMcpDialog — 表单式注册自定义 MCP server', () => {
  it('渲染所有表单字段（名称/版本/命令/参数/环境变量）+ 初始一行 env', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
    expect(screen.getByLabelText('版本')).toBeInTheDocument();
    expect(screen.getByLabelText('命令')).toBeInTheDocument();
    expect(screen.getByLabelText('参数')).toBeInTheDocument();
    // 环境变量至少一行（用 placeholder 定位）
    expect(screen.getAllByPlaceholderText('KEY=VALUE').length).toBeGreaterThanOrEqual(1);
  });

  it('必填校验：名称和命令都为空 → 提交按钮 disabled', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeDisabled();
  });

  it('必填校验：只填名称（命令为空）→ 仍 disabled', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'my-mcp' } });
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeDisabled();
  });

  it('必填校验：名称+命令都填 → 按钮 enabled', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'my-mcp' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'node' } });
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeEnabled();
  });

  it('[+] 按钮点击后追加一行新的 env 输入', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    const initialCount = screen.getAllByPlaceholderText('KEY=VALUE').length;
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(screen.getAllByPlaceholderText('KEY=VALUE').length).toBe(initialCount + 1);
  });

  it('提交 → ipc.mcp.register 收到正确 payload（含 source=custom + randomUUID 作 id）', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'my-mcp' } });
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: '1.2.0' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y, server.js, --port 3000' } });
    // 填第一行 env
    const envInputs = screen.getAllByPlaceholderText('KEY=VALUE');
    fireEvent.change(envInputs[0]!, { target: { value: 'API_KEY=secret123' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(mcpRegister).toHaveBeenCalledTimes(1);
    });
    const [config] = mcpRegister.mock.calls[0]!;
    expect(config).toMatchObject({
      id: FIXED_UUID,
      name: 'my-mcp',
      version: '1.2.0',
      command: 'npx',
      source: 'custom',
    });
    // args 逗号分隔 → trim + 过滤空串
    expect(config.args).toEqual(['-y', 'server.js', '--port 3000']);
    // env 多行 → Record
    expect(config.env).toEqual({ API_KEY: 'secret123' });
  });

  it('args 解析：空串 / 多余逗号 / 前后空格 → 干净的 string[]', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: ' a , , b ,  ,c,' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(mcpRegister).toHaveBeenCalled();
    });
    const [config] = mcpRegister.mock.calls[0]!;
    expect(config.args).toEqual(['a', 'b', 'c']);
  });

  it('env 解析：多行 KEY=VALUE（含 [+] 追加的行）→ Record', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    // 第一行
    const envInputs0 = screen.getAllByPlaceholderText('KEY=VALUE');
    fireEvent.change(envInputs0[0]!, { target: { value: 'FOO=bar' } });
    // 追加第二行
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    const envInputs1 = screen.getAllByPlaceholderText('KEY=VALUE');
    fireEvent.change(envInputs1[1]!, { target: { value: 'BAZ=qux' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(mcpRegister).toHaveBeenCalled();
    });
    const [config] = mcpRegister.mock.calls[0]!;
    expect(config.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('提交 → ipc.mcp.start 用 activeWorkspaceId + name 启动', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'runner' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(mcpStart).toHaveBeenCalledTimes(1);
    });
    expect(mcpStart).toHaveBeenCalledWith('ws-active', 'runner');
  });

  it('成功 → 触发 onSuccess 刷新父列表 + onClose 关闭', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('register 失败 → 红字错误显示，弹窗不关，onSuccess 不触发', async () => {
    mcpRegister.mockRejectedValueOnce(new Error('名称已存在'));
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));

    await waitFor(() => {
      expect(screen.getByText('名称已存在')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('提交期间按钮 disabled（防双击）', async () => {
    // 用未解决的 promise 卡住提交过程
    let resolveRegister: () => void = () => {};
    mcpRegister.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveRegister = resolve; }),
    );
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });

    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    // 提交进行中 → 按钮文案变化 + disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '注册中…' })).toBeDisabled();
    });
    // register 只被调一次（防双击）
    expect(mcpRegister).toHaveBeenCalledTimes(1);

    // 解除卡死，让组件清理
    resolveRegister();
    await waitFor(() => {
      expect(mcpStart).toHaveBeenCalled();
    });
  });
});
