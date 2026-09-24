// renderer/src/components/agent/RegisterMcpDialog.test.tsx
//
// P2.4 Task 3：快速创建 MCP 表单测试（spec §4）。
//   - 传输二态 Segmented：本地（stdio）名称/命令/参数(一行一个)/高级(env KeyValueRows+cwd)；
//     远程（HTTP）名称/URL(https)/高级(headers KeyValueRows)；切换清空对方态字段
//   - 同名二段确认：预检命中 → 警示条 + 按钮变「确认覆盖」；改字段重置
//   - 提交 payload：stdio { name, version?, command, args, env, cwd? }；
//     http { name, version?, command:'', transport:'streamable_http', url, headers }
//   - 提交后 mcp.start + onSuccess + onClose；失败红字不关（既有语义）
// Mock：window.api 桩（resource.registerMcp / resource.list / mcp.start）+ workspace store 注入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RegisterMcpDialog } from './RegisterMcpDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { ResourceItem, Workspace } from '../../ipc/types';

const resourceRegisterMcp = vi.fn();
const resourceList = vi.fn();
const mcpStart = vi.fn();

const mockApi = {
  resource: { registerMcp: resourceRegisterMcp, list: resourceList },
  mcp: { start: mcpStart },
};

const REGISTERED_ITEM: ResourceItem = {
  id: 'custom-mcp-my-mcp',
  type: 'mcp',
  source: 'custom',
  slug: 'my-mcp',
  name: 'my-mcp',
  description: '自定义 MCP（npx）',
  installed: true,
  installable: false,
  removable: true,
};

const WS: Workspace = {
  id: 'ws-active',
  name: '当前工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

beforeEach(() => {
  resourceRegisterMcp.mockReset();
  resourceList.mockReset();
  mcpStart.mockReset();
  resourceRegisterMcp.mockResolvedValue(REGISTERED_ITEM);
  resourceList.mockResolvedValue([]); // 默认无同名
  mcpStart.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useWorkspaceStore.setState({ workspaces: [WS], activeWorkspaceId: 'ws-active', loading: false, error: null });
});

describe('RegisterMcpDialog — 快速创建 MCP：传输二态', () => {
  it('默认本地态：渲染 名称/版本/命令/参数；无 URL 字段', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    expect(screen.getByLabelText('名称')).toBeInTheDocument();
    expect(screen.getByLabelText('命令')).toBeInTheDocument();
    expect(screen.getByLabelText('参数')).toBeInTheDocument();
    expect(screen.queryByLabelText('URL')).toBeNull();
  });

  it('切到远程态：URL 出现、命令/参数隐藏', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    expect(screen.getByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('命令')).toBeNull();
    expect(screen.queryByLabelText('参数')).toBeNull();
  });

  it('切换清空对方态字段：本地填命令 → 切远程 → URL 空；切回本地 → 命令空', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('radio', { name: '本地（stdio）' }));
    expect((screen.getByLabelText('命令') as HTMLInputElement).value).toBe('');
  });

  it('远程态 URL 非 https → 提交 disabled + 提示', () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://x.example.com' } });
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeDisabled();
    expect(screen.getByText('URL 必须以 https:// 开头')).toBeInTheDocument();
  });
});

describe('RegisterMcpDialog — env 行编辑（KeyValueRows）', () => {
  it('删除第 1 行 env → 提交 payload env 为空对象', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    // 高级区默认折叠——展开
    fireEvent.click(screen.getByText('高级：环境变量与工作目录'));
    fireEvent.change(screen.getByLabelText('环境变量名 1'), { target: { value: 'FOO' } });
    fireEvent.change(screen.getByLabelText('环境变量值 1'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 行' }));
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.env).toEqual({});
  });

  it('env 两行 + cwd → payload 透传', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByText('高级：环境变量与工作目录'));
    fireEvent.change(screen.getByLabelText('环境变量名 1'), { target: { value: 'FOO' } });
    fireEvent.change(screen.getByLabelText('环境变量值 1'), { target: { value: 'bar' } });
    fireEvent.click(screen.getByRole('button', { name: '添加环境变量' }));
    fireEvent.change(screen.getByLabelText('环境变量名 2'), { target: { value: 'BAZ' } });
    fireEvent.change(screen.getByLabelText('环境变量值 2'), { target: { value: 'qux' } });
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/opt/wd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(config.cwd).toBe('/opt/wd');
  });
});

describe('RegisterMcpDialog — args 一行一个', () => {
  it('参数 textarea 按行拆分（含带空格的参数值）', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.change(screen.getByLabelText('参数'), { target: { value: '-y\nserver.js\n--port 3000' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config.args).toEqual(['-y', 'server.js', '--port 3000']);
  });
});

describe('RegisterMcpDialog — 远程提交', () => {
  it('远程态提交 payload：transport/url/headers 透传，command 空串', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '远程（HTTP）' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'context7' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://mcp.context7.com/mcp' } });
    fireEvent.click(screen.getByText('高级：请求头'));
    fireEvent.change(screen.getByLabelText('请求头名 1'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByLabelText('请求头值 1'), { target: { value: 'Bearer ctx7sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
    const [config] = resourceRegisterMcp.mock.calls[0]!;
    expect(config).toMatchObject({
      name: 'context7',
      command: '',
      transport: 'streamable_http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer ctx7sk-x' },
    });
  });
});

describe('RegisterMcpDialog — 同名二段确认', () => {
  it('预检命中 → 警示条 + 按钮变「确认覆盖」且未提交；再点才提交', async () => {
    resourceList.mockResolvedValue([{ slug: 'dup-mcp' }]);
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup-mcp' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('将覆盖同名服务器：dup-mcp')).toBeInTheDocument());
    expect(resourceRegisterMcp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
  });

  it('警示后改字段 → 重置回一段态（警示条消失）', async () => {
    resourceList.mockResolvedValue([{ slug: 'dup-mcp' }]);
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup-mcp' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('将覆盖同名服务器：dup-mcp')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd2' } });
    expect(screen.queryByText('将覆盖同名服务器：dup-mcp')).toBeNull();
    expect(screen.getByRole('button', { name: '注册并启动' })).toBeInTheDocument();
  });

  it('预检 list 失败 → 不阻塞直接提交（主进程覆盖语义兜底）', async () => {
    resourceList.mockRejectedValue(new Error('net down'));
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalledTimes(1));
  });
});

describe('RegisterMcpDialog — 既有语义回归', () => {
  it('成功 → mcp.start(activeWorkspaceId, name) + onSuccess + onClose', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'runner' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(mcpStart).toHaveBeenCalledWith('ws-active', 'runner'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('提交失败 → 红字不关弹窗', async () => {
    resourceRegisterMcp.mockRejectedValueOnce(new Error('启动失败'));
    const onClose = vi.fn();
    render(<RegisterMcpDialog onClose={onClose} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(screen.getByText('启动失败')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('版本留空 → payload version undefined', async () => {
    render(<RegisterMcpDialog onClose={() => {}} onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'm' } });
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'cmd' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并启动' }));
    await waitFor(() => expect(resourceRegisterMcp).toHaveBeenCalled());
    expect(resourceRegisterMcp.mock.calls[0]![0].version).toBeUndefined();
  });
});
